#!/usr/bin/env bash
# Install or update hermes-flux on the Hermes host (run as the hermes user from this directory).
#
#   ./install.sh               install/update the service and the `flux` worker profile
#   ./install.sh --wire-bots   also give every granted bot the Flux MCP tools and a Flux section in SOUL.md
#
# Layout: ~/.hermes/flux/app (code, domain, operator), ~/.hermes/flux/state (ledger.jsonl, registry.json),
# ~/.hermes/flux/flux.env (HERMES_FLUX_TOKEN, FLUX_VIEW_KEY; mode 600). Bots need a gateway and dashboard
# restart to load a new MCP server (see README).
set -euo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
FLUX=$HOME/.hermes/flux
HERMES=${HERMES:-$HOME/.local/bin/hermes}
WIRE=false
[[ "${1:-}" == "--wire-bots" ]] && WIRE=true

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<5)) { console.error("Node 22.5+ required (node:sqlite)"); process.exit(1) }'

echo "== app"
mkdir -p "$FLUX/state"
rm -rf "$FLUX/app.new"
mkdir -p "$FLUX/app.new"
cp -r "$SRC/src" "$SRC/bin" "$SRC/domain" "$SRC/operator" "$SRC/vendor" "$SRC/test" "$FLUX/app.new/"
rm -rf "$FLUX/app.old"; [[ -d "$FLUX/app" ]] && mv "$FLUX/app" "$FLUX/app.old"
mv "$FLUX/app.new" "$FLUX/app"
chmod +x "$FLUX/app/bin/flux-ctl.cjs"
ln -sf "$FLUX/app/bin/flux-ctl.cjs" "$HOME/.local/bin/flux-ctl"

if [[ ! -f "$FLUX/flux.env" ]]; then
  umask 077
  printf 'HERMES_FLUX_TOKEN=%s\nFLUX_VIEW_KEY=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 12)" > "$FLUX/flux.env"
fi
chmod 600 "$FLUX/flux.env"
TOKEN=$(grep -E '^HERMES_FLUX_TOKEN=' "$FLUX/flux.env" | cut -d= -f2-)

set_env() { # file var value
  touch "$1"
  if grep -qE "^$2=" "$1"; then sed -i "s|^$2=.*|$2=$3|" "$1"; else printf '%s=%s\n' "$2" "$3" >> "$1"; fi
}

# Replace (or add) one entry under mcp_servers:, or with --only make it the sole entry.
set_mcp() { # config name header-yaml [--only]
  python3 - "$@" <<'PY'
import re, sys
path, name, headers = sys.argv[1], sys.argv[2], sys.argv[3]
only = len(sys.argv) > 4
block = [f"  {name}:", "    url: http://127.0.0.1:18790/mcp", f"    timeout: {600 if only else 900}", "    headers:"] + [f"      {h}" for h in headers.split("|")]
lines = open(path).read().replace("\r", "").split("\n")
try:
    i = next(k for k, l in enumerate(lines) if l.rstrip() in ("mcp_servers:", "mcp_servers: {}"))
except StopIteration:
    lines += ["mcp_servers:"] + block
else:
    lines[i] = "mcp_servers:"
    j = i + 1
    while j < len(lines) and (lines[j].startswith(" ") or not lines[j].strip()):
        j += 1
    body, keep, skip = lines[i + 1:j], [], False
    if not only:
        for l in body:
            if re.match(r"^  \S", l):
                skip = l.strip() == f"{name}:"
            if not skip:
                keep.append(l)
        while keep and not keep[-1].strip():
            keep.pop()
    lines = lines[:i + 1] + keep + block + [""] + lines[j:]
open(path, "w").write("\n".join(lines))
PY
}

echo "== flux worker profile"
P=$HOME/.hermes/profiles/flux
if [[ ! -d "$P" ]]; then
  "$HERMES" profile create flux --clone-from pilot --no-alias \
    --description "Flux worker runtime: governed, temporary specialist agents started by the Flux service. Not for chat."
fi
cp "$SRC/flux-profile/SOUL.md" "$P/SOUL.md"
set_mcp "$P/config.yaml" flux 'Authorization: Bearer ${HERMES_FLUX_TOKEN}|X-Flux-Agent: ${FLUX_AGENT_TOKEN}' --only
# Workers get only what Flux gives them: no phone or Home Assistant secrets.
sed -i -E '/^(HERMES_PHONE_TOKEN|HASS_[A-Z_]*)=/d' "$P/.env"
set_env "$P/.env" HERMES_FLUX_TOKEN "$TOKEN"

if $WIRE; then
  echo "== bots"
  for bot in $(python3 -c "import json;print(' '.join(json.load(open('$SRC/operator/policy.json'))['bots']))"); do
    B=$HOME/.hermes/profiles/$bot
    [[ -d "$B" ]] || continue
    set_env "$B/.env" HERMES_FLUX_TOKEN "$TOKEN"
    set_mcp "$B/config.yaml" flux "Authorization: Bearer \${HERMES_FLUX_TOKEN}|X-Hermes-Bot: $bot"
    python3 - "$B/SOUL.md" "$SRC/flux-profile/bot-soul-section.md" <<'PY'
import re, sys
soul, section = sys.argv[1], open(sys.argv[2]).read().strip()
text = open(soul).read() if __import__("os").path.exists(soul) else ""
text = re.sub(r"\n*<!-- flux:start -->.*?<!-- flux:end -->\n*", "\n", text, flags=re.S).rstrip()
open(soul, "w").write(f"{text}\n\n<!-- flux:start -->\n{section}\n<!-- flux:end -->\n")
PY
    echo "  wired $bot"
  done
fi

echo "== service"
mkdir -p "$HOME/.config/systemd/user"
cp "$SRC/hermes-flux.service" "$HOME/.config/systemd/user/hermes-flux.service"
systemctl --user daemon-reload
systemctl --user enable hermes-flux >/dev/null 2>&1
systemctl --user restart hermes-flux
sleep 2
systemctl --user --no-pager --lines=3 status hermes-flux | sed -n '1,6p'
echo "Live Map: http://$(hostname -I | awk '{print $1}'):18791/?key=$(grep -E '^FLUX_VIEW_KEY=' "$FLUX/flux.env" | cut -d= -f2-)"

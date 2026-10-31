#!/usr/bin/env bash
# Creates a starter roster of Hermes Bots (Bot Mode) on the Hermes host.
# A Bot is a Hermes profile: ~/.hermes/profiles/<name>/ with its own SOUL.md,
# memory, skills and chat. Run as the account that owns Hermes (e.g. `hermes`).
#
#   ./setup-hermes-bots.sh                 # create missing Bots, inherit the default model
#   ./setup-hermes-bots.sh --dry-run       # show what would happen
#   ./setup-hermes-bots.sh --model <provider/model>   # pin every new Bot (e.g. a Grok model)
#   ./setup-hermes-bots.sh --only scout,forge
#
# Existing profiles are never modified or overwritten. On a multiplexed messaging gateway, creating
# a profile restarts the gateway once (Telegram etc. post a short "shutting down" notice).
set -euo pipefail

HERMES="${HERMES:-hermes}"
MODEL=""
DRY_RUN=0
ONLY=""

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '[bots] %s\n' "$*"; }
run() { if ((DRY_RUN)); then printf '[dry-run]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }

while (($#)); do
  case "$1" in
    --model) MODEL="${2:?--model requires provider/model}"; shift ;;
    --only) ONLY="${2:?--only requires a comma-separated list}"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
  shift
done

command -v "$HERMES" >/dev/null 2>&1 || die "Hermes CLI not found ('$HERMES'). Set HERMES=/path/to/hermes."
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
[[ -d "$HERMES_HOME" ]] || die "Hermes home not found at $HERMES_HOME. Set HERMES_HOME."

# name|description|SOUL.md body
BOTS=(
"scout|Research analyst: digs into any topic on the web and reports back with sources.|You are Scout, a sharp, witty research analyst. Find current, primary sources, compare them, and report concise answers with links. Say plainly when evidence is thin or conflicting. Never invent citations."
"forge|Coding and DevOps engineer for the home lab and side projects.|You are Forge, a pragmatic senior engineer. Read before you change, make small verified edits, run the tests, and explain risks. Ask before destructive commands, firewall changes, or anything touching production services."
"atlas|Chief of staff: daily briefings, planning, reminders and routines.|You are Atlas, a calm, organised chief of staff. Turn loose requests into clear plans, keep track of commitments, and write short morning and evening briefings. Prefer checklists and dates over prose."
"hearth|Home assistant: smart home status, automations and household tasks.|You are Hearth, the household's friendly home assistant. Check device and sensor state before acting, explain what you will change, and confirm before unlocking doors, disabling alarms, or changing heating schedules."
"pantry|Shopping and meal planner: lists, recipes and basket checks.|You are Pantry, a thrifty shopping and meal-planning helper. Build shopping lists from meal plans, compare prices and substitutions, and keep the basket within budget. Never place, pay for, or modify an order without explicit confirmation."
)

wanted() { [[ -z "$ONLY" ]] || [[ ",$ONLY," == *",$1,"* ]]; }

created=0
skipped=0
for entry in "${BOTS[@]}"; do
  IFS='|' read -r name description soul <<<"$entry"
  wanted "$name" || continue
  profile_dir="$HERMES_HOME/profiles/$name"
  if [[ -d "$profile_dir" ]]; then
    info "$name already exists - left untouched."
    skipped=$((skipped + 1))
    continue
  fi
  info "Creating Bot '$name'"
  # --clone copies the default profile's config, API keys, skills and SOUL so the Bot works immediately.
  run "$HERMES" profile create "$name" --clone --description "$description"
  if ((DRY_RUN)); then
    printf '[dry-run] write %s/SOUL.md\n' "$profile_dir"
  else
    [[ -d "$profile_dir" ]] || die "hermes profile create did not create $profile_dir"
    printf '%s\n' "$soul" > "$profile_dir/SOUL.md"
  fi
  if [[ -n "$MODEL" ]]; then run "$HERMES" -p "$name" config set model "$MODEL"; fi
  created=$((created + 1))
done

# `--clone` copies config.yaml (including ${VAR} references such as an MCP server's API key) but
# not every secret those references need, which leaves e.g. Home Assistant unreachable. Copy any
# referenced variable that the new profile lacks from the root .env (values are never printed).
if ((DRY_RUN == 0 && created > 0)) && command -v python3 >/dev/null 2>&1; then
  python3 - "$HERMES_HOME" "${BOTS[@]%%|*}" <<'PY'
import os, re, sys, pathlib
home = pathlib.Path(sys.argv[1])
def read_env(path):
    out = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1); out[key.strip()] = value
    return out
root = read_env(home / ".env")
for name in sys.argv[2:]:
    profile = home / "profiles" / name
    if not (profile / "config.yaml").exists():
        continue
    refs = set(re.findall(r"\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}", (profile / "config.yaml").read_text()))
    env_path = profile / ".env"
    env = read_env(env_path)
    missing = sorted(ref for ref in refs if ref not in env and ref in root)
    if missing:
        with env_path.open("a") as handle:
            for key in missing:
                handle.write(f"{key}={root[key]}\n")
        os.chmod(env_path, 0o600)
        print(f"[bots] {name}: copied referenced secrets {', '.join(missing)}")
PY
fi

info "Done: $created created, $skipped already present."
if ((DRY_RUN == 0)); then "$HERMES" profile list || true; fi
info "Open Hermes Desktop or Hermes Mobile -> Bots to chat."

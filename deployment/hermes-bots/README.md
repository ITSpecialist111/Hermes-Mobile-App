# Hermes Bots + Hermes Mobile (foldables) runbook

Host: Hermes Agent v0.21.5 on `192.168.68.10` (Linux, `hermes` account).
Phones: Galaxy Z Fold7 (Android build of Hermes Mobile) and iPhone Duo.
App source: https://github.com/ITSpecialist111/Hermes-Mobile-App (branch `fold7-foldables`).

## Current state of this host (31 Oct 2026)

Done by Copilot via the Proxmox node shell (`pct exec 100`, CT 100 "hermesagent") and SSH:

| Change | Where | Undo |
|---|---|---|
| SSH key `copilot-hermes-setup` (only from 192.168.68.5/.6/.210) | `/home/hermes/.ssh/authorized_keys` | delete that line |
| Dashboard login: user `graham`, scrypt password hash, session secret | `~/.hermes/.env` (backup `~/.hermes/.env.bak-copilot-*`) | restore the backup |
| Dashboard/gateway bound to the LAN instead of loopback | `/etc/systemd/system/hermes-dashboard.service.d/hermes-mobile-lan.conf` | delete it, `systemctl daemon-reload && systemctl restart hermes-dashboard` |
| Bots scout, forge, atlas, hearth, pantry (clones of `default`) | `~/.hermes/profiles/` | `hermes profile delete <name>` |
| Bot **pilot** (phone operator) with MCP server `phone` → `http://192.168.68.82:8765/mcp` | `~/.hermes/profiles/pilot/config.yaml`, token `HERMES_PHONE_TOKEN` in its `.env` | `hermes profile delete pilot` |
| `HASS_MCP_API_KEY` copied into the new bots' `.env` (`--clone` had left Home Assistant unreachable) | `~/.hermes/profiles/*/.env` | delete the line |

Creating a profile restarts the multiplexed messaging gateway once (Telegram posts a short
"shutting down" notice); it comes straight back.

### Phone control (Galaxy Z Fold7)

Hermes Mobile's accessibility service lets the Bots operate the phone (screen reading,
taps, typing, swipes, opening apps and links). **Every named Bot has it** (Pilot, Scout, Atlas,
Forge, Hearth, Pantry, Shopping), but not the Default profile that Telegram uses. Each has an
`mcp_servers.phone` entry, `HERMES_PHONE_TOKEN` in its `.env`, and a "phone hands" section in its
SOUL (backups: `*.bak-phone-*`). To add it to another profile, copy the same three pieces and
restart the gateways (see below). It is on while *Settings → Accessibility → Installed
apps → Hermes phone control* is on; the ongoing notification names every action and has **Stop**.
Password fields are always refused, and only LAN/Tailscale peers with the phone's token are accepted.

**Ask first / Autopilot** (*Settings → Phone control → Ask first*, on by default). The phone itself
enforces it, not the Bot: before a tap on anything that sends, posts, pays, buys, orders, deletes,
confirms, submits, calls or installs (judged from the element's text, description and view id, also
for coordinate taps) and before "type and submit", an **Allow / Deny** card appears at the bottom of
the screen. No answer within 60 seconds counts as Deny, and the Bot is told not to retry. Turn
it off for Autopilot: Bots act without asking; the notification still lists every action with
**Stop**, and password fields stay blocked. The Settings row shows *On · Ask first* or *On · Autopilot*.

**App first.** Pilot checks `phone_list_apps` and uses the installed app for a service (messaging,
shopping, banking, social, travel, maps…), and only uses Chrome for general research or when no app
covers it; "in the browser" or a named app overrides this. This is in both the phone's MCP tool
descriptions and Pilot's SOUL (backup: `~/.hermes/profiles/pilot/SOUL.md.bak-*`).

- **Phone locator.** The phone's IP comes from DHCP and changes (it moved from `.82` to `.131`), so
  every Bot points at `http://127.0.0.1:18765/mcp` instead: `~/.hermes/bin/phone-locator.py`, run by
  the user service `hermes-phone-locator` (`systemctl --user status hermes-phone-locator`). It pipes
  each connection to the phone's port 8765. When the phone isn't at its last address, it scans
  `192.168.68.0/22` for the server that accepts `HERMES_PHONE_TOKEN` (about 6 s) and remembers it in
  `~/.hermes/phone-locator.json`. Source: [phone-locator.py](./phone-locator.py). Config backups:
  `config.yaml.bak-locator-*`.
- **Existing chats keep the instructions they started with.** Hermes freezes each chat's system
  prompt and tool list (for prompt caching), so SOUL edits and newly added MCP servers only reach
  *new* chats. That is why Scout kept saying "no connection to your phone" in a chat started before
  phone control. To refresh existing chats: clear `system_prompt_hash`, `system_prompt` and
  `tool_names` for those rows in the profile's `state.db` (Hermes then rebuilds both on the next turn,
  its own recovery path), then `systemctl restart hermes-dashboard` so open chats drop their
  in-memory agent. Rollback values from 31 Oct: `~/.hermes/session-prompt-refresh-*.json`.
- If you ever change a Bot's phone URL or token, restart the dashboard as root
  (`systemctl restart hermes-dashboard`) and `systemctl --user restart hermes-gateway`: running
  gateways only add or remove MCP servers by name, so they keep the old address until restarted.
- Phone control works only while the phone is on the home network (same LAN as the host). Away from
  home the Bots can't reach it unless the phone and host share a Tailscale tailnet.
- Rotating the token (Settings → Phone control → New token) revokes every Bot until each profile's
  `.env` is updated (the locator reads Pilot's `.env`; restart it too).
- Sideloaded app on Android 13+: to toggle the service yourself, first allow *App info → ⋮ → Allow
  restricted settings* for Hermes Mobile.

The gateway answers at `http://192.168.68.10:9119` (login required, LAN only; port 9119 is not
forwarded). The Tailscale installer in step 2 was not used: the host already runs the
machine-level dashboard as a system service, so that service was re-bound instead.
`approvals.mode` is still `off` on this host, so Bots run commands without asking; set
`hermes config set approvals.mode manual` to get approval prompts on the phone.

## 0. Let Copilot onto the host (optional)

From this PC only SSH (22) and the Hermes API (8642) are reachable, and both need credentials.
To let Copilot run steps 1–2 for you, authorize this PC's key as the Hermes account (revoke by
deleting the line afterwards):

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElyYZ3vVUmK3b4dYWveuSVlLdE9Aq49dRNQMIBjFofY copilot-hermes-setup' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

## 1. Create the Bot roster (on the host)

A Bot is a Hermes profile (`~/.hermes/profiles/<name>/`). The script creates five Bots,
cloned from the default profile so they inherit its model and API keys, each with its own
`SOUL.md`: **scout** (research), **forge** (coding/DevOps), **atlas** (planning/briefings),
**hearth** (home), **pantry** (shopping/meals). Existing profiles are never touched.

```bash
scp deployment/hermes-bots/setup-hermes-bots.sh hermes@192.168.68.10:~/
ssh hermes@192.168.68.10
bash ~/setup-hermes-bots.sh --dry-run
bash ~/setup-hermes-bots.sh
# Optional: pin new Bots to one model, e.g. a Grok model (needs the xAI key in the profile):
#   hermes model                       # list provider/model ids the host knows
#   bash ~/setup-hermes-bots.sh --model <provider/model>
```

## 2. Run the phone gateway on the LAN (on the host)

Phones need an authenticated `hermes serve` gateway on port 9119 (today only the API server on
8642 is reachable). The installer binds 9119 to the LAN address only, sets up basic auth
(prompts once for a username/password) and verifies the listener.

```bash
scp Hermes-Mobile-App/scripts/install-hermes-mobile-gateway-linux.sh hermes@192.168.68.10:~/
ssh hermes@192.168.68.10
bash ~/install-hermes-mobile-gateway-linux.sh install --lan-ip 192.168.68.10 --enable-linger
bash ~/install-hermes-mobile-gateway-linux.sh status
```

If the host's nftables input chain drops by default, allow the LAN (not the internet):

```bash
sudo nft add rule inet filter input ip saddr 192.168.68.0/24 tcp dport 9119 accept
```

Check from the PC: `curl http://192.168.68.10:9119/api/status` should report `"auth_required": true`.
Never port-forward 9119 on the router; use Tailscale (`install` without `--lan-ip`) for away-from-home access.

## 3. Galaxy Z Fold7

Enable Developer options → USB debugging, plug the phone in, accept the prompt, then:

```powershell
adb devices
adb install -r "Hermes-Mobile-App\src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk"
```

In the app: **Settings → Security & Pairing** → `http://192.168.68.10:9119` → Test → sign in.
Bots created by `setup-hermes-bots.sh` have no chat yet; tapping one in the app starts its Bot Chat.

Rebuild after changes (Windows without Developer Mode): `Hermes-Mobile-App\scripts\build-android-debug-windows.ps1 -Install`.

Foldable checks: unfolded = Bots rail + conversation; half-folded like a book = rail on the left
page, chat on the right with the divider on the hinge; half-folded in landscape (Flex mode) =
transcript on top, composer under the hinge; fold/unfold keeps the open chat.
Diagnostics: `adb logcat -s HermesFold`.

Approvals and Now Bar checks:
- Ask a Bot to do something that needs approval (e.g. "restart the hermes-gateway service").
  With the app open an approval sheet appears; with the phone folded or the app in the
  background a "needs approval" notification offers **Allow once / Deny**.
- While a Bot is working, its progress notification should appear in the Now Bar. If it does
  not, enable Developer options → **Live notifications for all apps** (One UI 8).

## 4. iPhone Duo

**There is no official Nous Research mobile app** (checked 31 Oct 2026): no App Store developer
named Nous Research, no mobile/iOS app in `NousResearch/hermes-agent` (only `apps/desktop`), and
no TestFlight/App Store links in the official repo or docs. The official clients are Hermes
Desktop, the web dashboard and the CLI/TUI. The TestFlight beta "Hermes Agent App"
(`testflight.apple.com/join/CVhbq8Ur`) is published from `vburojevic/hermes` (hermesapp.dev),
whose README states it "is not affiliated with Nous Research". App Store titles like
"Hermes Agent – Smart Assistant" are from unrelated individual developers.

Any client you sign in to receives full control of the agent (shell, tools, credentials on the
host), so treat third-party apps as you would SSH access.

The iOS build of Hermes Mobile (also community, not Nous) needs a Mac with Xcode
(`pnpm tauri ios init && pnpm tauri ios dev`). Its foldable layout and rotation/Split View settings
(`src-tauri/Info.ios.plist`) are already in the source. Until a Mac build is available, the
official route on the iPhone is the Hermes **web dashboard** in Safari: the same `hermes serve`
gateway from step 2 serves it, and its **Chat** tab runs the full Hermes TUI in the browser
(sessions, cron, profiles, skills, MCP). It has no Bot Mode roster or native notifications.

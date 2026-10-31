#!/usr/bin/env python3
"""Reply drafts for Hermes Mobile.

Polls the phone (through the phone locator) for new messages in the apps the user enabled under
Settings -> Phone control -> Reply drafts, asks a Bot to draft a reply in the user's voice, and
shows the draft on the phone (phone_propose_reply) with Send / Edit / Ignore. Nothing is ever sent
from here: only the user's tap on the phone sends.

The drafting run is a plain completion (no tools, no MCP servers) with the Bot's SOUL and memory,
so a draft can never act on the phone by itself.

Config: ~/.hermes/reply-drafter.json  {"bot": "pilot", "interval": 8, "groups": false}
Usage:  reply-drafter.py
"""
import json
import logging
import os
import re
import subprocess
import time
import urllib.request
from pathlib import Path

HOME = Path(os.path.expanduser("~/.hermes"))
CONFIG = HOME / "reply-drafter.json"
STATE = Path(os.environ.get("HERMES_DRAFTER_STATE", HOME / "reply-drafter.state.json"))
# Overridable for testing against an emulator.
PHONE_URL = os.environ.get("HERMES_PHONE_URL", "http://127.0.0.1:18765/mcp")
FRESH_SECONDS = 15 * 60  # older messages (e.g. after a restart) are not drafted
OTP = re.compile(r"\b(code|otp|passcode|verification|verify|pin)\b.*\b\d{4,8}\b|\b\d{4,8}\b.*\b(code|otp|passcode)\b", re.I | re.S)
log = logging.getLogger("reply-drafter")


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def token(bot: str) -> str:
    if os.environ.get("HERMES_PHONE_TOKEN"):
        return os.environ["HERMES_PHONE_TOKEN"]
    for profile in (bot, "pilot"):
        env = HOME / "profiles" / profile / ".env"
        if env.exists():
            for line in env.read_text().splitlines():
                if line.startswith("HERMES_PHONE_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("HERMES_PHONE_TOKEN not found")


def call(tool: str, args: dict, bot: str, phone_token: str) -> dict:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}}).encode()
    request = urllib.request.Request(PHONE_URL, body, {
        "Content-Type": "application/json", "Authorization": f"Bearer {phone_token}", "X-Hermes-Bot": bot})
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.loads(response.read())["result"]
    text = "".join(part.get("text", "") for part in result.get("content", []) if part.get("type") == "text")
    if result.get("isError"):
        raise RuntimeError(text)
    return {"text": text}


def model_args(bot: str) -> list:
    """The Bot's own model and provider (config.yaml is otherwise ignored to keep MCP servers out)."""
    try:
        import yaml  # available in the Hermes environment's system python? fall back to a regex
        model = yaml.safe_load((HOME / "profiles" / bot / "config.yaml").read_text()).get("model") or {}
        name, provider = model.get("default"), model.get("provider")
    except Exception:
        text = (HOME / "profiles" / bot / "config.yaml").read_text()
        block = text.split("\nmodel:", 1)[-1]
        name = (re.search(r"\n  default: *(\S+)", block) or [None, None])[1]
        provider = (re.search(r"\n  provider: *(\S+)", block) or [None, None])[1]
    return (["-m", name] if name else []) + (["--provider", provider] if provider else [])


def draft(bot: str, message: dict) -> str | None:
    history = "\n".join(f"{'Graham' if line.get('from') == 'me' else line.get('from')}: {line.get('text')}" for line in message.get("history", []))
    prompt = f"""You are drafting a reply for Graham to send from his phone. Write it AS Graham, in the first person, in his natural texting voice: brief, warm, British English, no sign-off. Match the other person's tone; use an emoji only if they do. Use what you know about Graham and this person if it helps. Never invent plans, times, facts or promises Graham hasn't made: if the reply needs something only Graham knows, write a short holding reply or a quick question back.

If no reply is needed (verification codes, automated or marketing messages, delivery or bank notices, a closing "ok"/"thanks"/thumbs-up, or anything sensitive), output exactly: SKIP

Output ONLY the reply text, or SKIP. No quotes, no explanation, do not use tools.

App: {message.get('app')}
Conversation: {message.get('conversation')}{' (group chat)' if message.get('group') else ''}
Recent messages, oldest first:
{history}

New message from {message.get('sender')}: {message.get('text')}"""
    run = subprocess.run(
        ["hermes", "-p", bot, "chat", "-Q", "--source", "tool", "--ignore-user-config", *model_args(bot), "--max-turns", "1", "--query-file", "-"],
        input=prompt, capture_output=True, text=True, timeout=180,
    )
    lines = [line for line in run.stdout.strip().splitlines() if line.strip()]
    session = next((line.split(":", 1)[1].strip() for line in lines if line.startswith("session_id:")), None)
    if session:  # drafting runs are scratch work, not conversations
        subprocess.run(["hermes", "-p", bot, "sessions", "delete", session, "--yes"], capture_output=True, timeout=60)
    reply = "\n".join(line for line in lines if not line.startswith(("session_id:", "\u21bb"))).strip().strip('"').strip()
    if run.returncode != 0 or not reply:
        log.warning("draft failed (%s): %s", run.returncode, run.stderr.strip()[-300:])
        return None
    if reply.upper().rstrip(".") == "SKIP" or len(reply) > 600:
        return None
    return reply


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    state = load_json(STATE, {"since_id": 0})
    phone_token = None
    last_problem = ""
    while True:
        config = load_json(CONFIG, {})
        bot = config.get("bot", "pilot")
        interval = max(4, int(config.get("interval", 8)))
        try:
            phone_token = phone_token or token(bot)
            listing = json.loads(call("phone_messages", {"since_id": state["since_id"], "for_drafting": True}, bot, phone_token)["text"])
            for message in listing.get("messages", []):
                state["since_id"] = max(state["since_id"], int(message["id"]))
                STATE.write_text(json.dumps(state))
                age = time.time() - message.get("at", 0) / 1000
                if age > FRESH_SECONDS or not message.get("can_reply"):
                    continue
                if message.get("group") and not config.get("groups", False):
                    continue
                if OTP.search(message.get("text", "")):
                    continue
                log.info("drafting a reply to %s (%s)", message.get("sender"), message.get("app"))
                reply = draft(bot, message)
                if not reply:
                    log.info("no reply needed for %s", message.get("sender"))
                    continue
                call("phone_propose_reply", {"message_id": message["id"], "text": reply}, bot, phone_token)
                log.info("draft shown on the phone for %s", message.get("sender"))
            last_problem = ""
        except Exception as error:  # phone away, access off, Hermes busy: try again next round
            problem = str(error)[:200]
            if problem != last_problem:
                log.info("waiting: %s", problem)
                last_problem = problem
            phone_token = None
        time.sleep(interval)


if __name__ == "__main__":
    main()

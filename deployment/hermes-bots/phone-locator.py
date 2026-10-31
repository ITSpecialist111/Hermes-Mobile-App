#!/usr/bin/env python3
"""Stable local address for the Hermes Mobile phone-control MCP server.

Bots point at http://127.0.0.1:18765/mcp. Each connection is piped to the phone's server on
port 8765. When the phone is not at its last known address (DHCP gave it a new IP), the LAN is
scanned for a server that accepts the phone's token, and that address is remembered. The token
is only used to recognise the phone; requests themselves pass through untouched.

Usage: phone-locator.py [--subnet 192.168.68.0/22] [--env ~/.hermes/profiles/pilot/.env]
"""
import argparse
import asyncio
import ipaddress
import json
import logging
import os
import time
from pathlib import Path

LISTEN = ("127.0.0.1", 18765)
PHONE_PORT = 8765
STATE = Path(os.path.expanduser("~/.hermes/phone-locator.json"))
log = logging.getLogger("phone-locator")


def read_token(env_path: Path) -> str:
    for line in env_path.read_text().splitlines():
        if line.startswith("HERMES_PHONE_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"HERMES_PHONE_TOKEN not found in {env_path}")


class Locator:
    def __init__(self, subnet: str, token: str):
        self.subnet = ipaddress.ip_network(subnet, strict=False)
        self.token = token
        self.lock = asyncio.Lock()
        self.last_scan = 0.0
        try:
            self.ip = json.loads(STATE.read_text()).get("ip")
        except (OSError, ValueError):
            self.ip = None

    def remember(self, ip: str) -> None:
        if ip != self.ip:
            log.info("phone found at %s (was %s)", ip, self.ip)
        self.ip = ip
        STATE.write_text(json.dumps({"ip": ip, "at": time.strftime("%Y-%m-%d %H:%M:%S")}))

    async def is_phone(self, ip: str, timeout: float = 2.0) -> bool:
        """True if ip:8765 answers an authorised MCP ping (so it is this phone, not another device)."""
        body = b'{"jsonrpc":"2.0","id":1,"method":"ping"}'
        request = (f"POST /mcp HTTP/1.1\r\nHost: {ip}:{PHONE_PORT}\r\nAuthorization: Bearer {self.token}\r\n"
                   f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode() + body
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_connection(ip, PHONE_PORT), timeout)
        except (OSError, asyncio.TimeoutError):
            return False
        try:
            writer.write(request)
            await writer.drain()
            reply = b""
            while len(reply) < 8192:  # headers and body arrive as separate writes; the phone closes after replying
                chunk = await asyncio.wait_for(reader.read(4096), timeout)
                if not chunk:
                    break
                reply += chunk
            return reply.startswith(b"HTTP/1.1 200") and b'"jsonrpc"' in reply
        except (OSError, asyncio.TimeoutError):
            return False
        finally:
            writer.close()

    async def scan(self) -> str | None:
        hosts = [str(h) for h in self.subnet.hosts()]
        gate = asyncio.Semaphore(256)

        async def probe(ip: str) -> str | None:
            async with gate:
                return ip if await self.is_phone(ip, timeout=1.5) else None

        for found in asyncio.as_completed([probe(ip) for ip in hosts]):
            ip = await found
            if ip:
                return ip
        return None

    async def target(self) -> str | None:
        """The phone's current IP: the remembered one if it still answers, otherwise a fresh scan."""
        if self.ip and await self.is_phone(self.ip):
            return self.ip
        async with self.lock:
            if self.ip and await self.is_phone(self.ip):  # another connection may have just rescanned
                return self.ip
            if time.monotonic() - self.last_scan < 20:  # phone is away: don't rescan on every retry
                return None
            self.last_scan = time.monotonic()
            log.info("phone not at %s; scanning %s", self.ip, self.subnet)
            ip = await self.scan()
            if ip:
                self.remember(ip)
            else:
                log.info("phone not found on %s (off Wi-Fi or phone control off)", self.subnet)
            return ip


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except OSError:
        pass
    finally:
        writer.close()


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--subnet", default="192.168.68.0/22")
    parser.add_argument("--env", default="~/.hermes/profiles/pilot/.env")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    locator = Locator(args.subnet, read_token(Path(os.path.expanduser(args.env))))

    async def handle(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
        ip = await locator.target()
        if not ip:
            client_writer.close()
            return
        try:
            phone_reader, phone_writer = await asyncio.wait_for(asyncio.open_connection(ip, PHONE_PORT), 5)
        except (OSError, asyncio.TimeoutError):
            client_writer.close()
            return
        await asyncio.gather(pipe(client_reader, phone_writer), pipe(phone_reader, client_writer))

    server = await asyncio.start_server(handle, *LISTEN)
    log.info("listening on %s:%d, phone last seen at %s", *LISTEN, locator.ip)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())

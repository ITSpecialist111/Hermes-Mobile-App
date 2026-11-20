#!/usr/bin/env node
'use strict';
// flux-ctl: operator CLI for the hermes-flux service (reads HERMES_FLUX_TOKEN from ~/.hermes/flux/flux.env).
//   flux-ctl status | agents | missions [--bot pilot] | ledger [--days 7] | verify
//   flux-ctl run <mission> <objective...> [--bot operator] [--cap id ...] [--full]
//   flux-ctl plan <mission> <objective...>          dry run (no model calls)
//   flux-ctl approvals [status] | approve|deny <id> [note] | ask "<title>" <summary...>
//   flux-ctl memory | rotate <agentId> | forget <agentId> [topic]
//   flux-ctl federation | grant <peerId> <key|keyfile> --missions a,b [--days 30] [--usd 1] | revoke <grantId>
//   flux-ctl peer-keygen <file> | peer-call <url> <grant-file> <key-file> <mission> <objective...> [--host-key k]
//   flux-ctl freeze | unfreeze | retire <agentId>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const envFile = process.env.FLUX_ENV || path.join(os.homedir(), '.hermes', 'flux', 'flux.env');
const token = process.env.HERMES_FLUX_TOKEN || (fs.existsSync(envFile) && (fs.readFileSync(envFile, 'utf8').match(/^HERMES_FLUX_TOKEN=(.+)$/m) || [])[1]?.trim());
const base = process.env.FLUX_URL || 'http://127.0.0.1:18790';

function option(args, name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

async function call(method, route, body, bot = 'operator') {
  const res = await fetch(base + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'X-Hermes-Bot': bot, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

async function main(argv) {
  const args = [...argv];
  const command = args.shift();
  const bot = option(args, '--bot', 'operator');
  let out;
  if (command === 'status') out = await call('GET', '/api/status');
  else if (command === 'agents') out = (await call('GET', '/api/status')).agents;
  else if (command === 'missions') out = await call('GET', '/api/missions', null, bot);
  else if (command === 'ledger') out = await call('GET', `/api/ledger?days=${option(args, '--days', '1')}`);
  else if (command === 'verify') out = (await call('GET', '/api/ledger')).chain;
  else if (command === 'freeze' || command === 'unfreeze') out = await call('POST', '/api/control', { action: command });
  else if (command === 'retire') out = await call('POST', '/api/control', { action: 'retire', agentId: args[0] });
  else if (command === 'run') {
    const capabilities = [];
    for (let c; (c = option(args, '--cap')) !== undefined;) capabilities.push(c);
    const full = args.includes('--full');
    const [mission, ...words] = args.filter(a => a !== '--full');
    out = await call('POST', `/api/run${full ? '?full' : ''}`, { mission, objective: words.join(' '), capabilities }, bot);
  } else if (command === 'plan') {
    const [mission, ...words] = args;
    out = await call('POST', '/api/plan', { mission, objective: words.join(' ') }, bot);
  } else if (command === 'approvals') out = await call('GET', `/api/approvals${args[0] ? `?status=${args[0]}` : ''}`);
  else if (command === 'approve' || command === 'deny') out = await call('POST', '/api/approvals', { id: args[0], decision: command === 'approve' ? 'approved' : 'denied', note: args.slice(1).join(' ') || undefined });
  else if (command === 'ask') out = await call('POST', '/api/approvals', { title: args[0], summary: args.slice(1).join(' ') }, bot);
  else if (command === 'memory') out = await call('GET', '/api/memory');
  else if (command === 'forget') out = await call('POST', '/api/memory', { action: 'forget', agentId: args[0], topic: args.slice(1).join(' ') || undefined });
  else if (command === 'rotate') out = await call('POST', '/api/memory', { action: 'rotate', agentId: args[0] });
  else if (command === 'federation') out = await call('GET', '/api/federation');
  else if (command === 'grant') {
    const missions = option(args, '--missions', '').split(',').filter(Boolean);
    const days = Number(option(args, '--days', '30')), maxUsdPerDay = Number(option(args, '--usd', '1'));
    const [peerId, keyFile] = args;
    const peerKey = fs.existsSync(keyFile) ? JSON.parse(fs.readFileSync(keyFile, 'utf8')).publicKey : keyFile;
    out = await call('POST', '/api/federation', { action: 'grant', peerId, peerKey, missions, days, maxUsdPerDay });
  } else if (command === 'revoke') out = await call('POST', '/api/federation', { action: 'revoke', grantId: args[0] });
  else if (command === 'peer-keygen') {
    // Run on the PEER: creates its key pair; send only publicKey to the host that will grant access.
    const { generateKeys } = require('../src/federation.cjs');
    fs.writeFileSync(args[0], JSON.stringify(generateKeys(), null, 2), { mode: 0o600 });
    out = { wrote: args[0], publicKey: JSON.parse(fs.readFileSync(args[0], 'utf8')).publicKey };
  } else if (command === 'peer-call') {
    // flux-ctl peer-call <http://host:18792> <grant-token-file> <peer-key-file> <mission> <objective...> [--host-key <base64>]
    const { callPeer } = require('../src/federation.cjs');
    const peerHostKey = option(args, '--host-key');
    const [url, grantFile, keyFile, mission, ...words] = args;
    out = await callPeer({ url, grant: fs.readFileSync(grantFile, 'utf8').trim(), privateKey: JSON.parse(fs.readFileSync(keyFile, 'utf8')).privateKeyPem, mission, objective: words.join(' '), peerHostKey });
  } else {
    console.error('usage: flux-ctl status|agents|missions|ledger|verify|run|plan|approvals|approve|deny|ask|memory|forget|rotate|federation|grant|revoke|peer-keygen|peer-call|freeze|unfreeze|retire');
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(out, null, 2));
}

main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

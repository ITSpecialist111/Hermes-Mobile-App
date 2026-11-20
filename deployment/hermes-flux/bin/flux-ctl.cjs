#!/usr/bin/env node
'use strict';
// flux-ctl: operator CLI for the hermes-flux service (reads HERMES_FLUX_TOKEN from ~/.hermes/flux/flux.env).
//   flux-ctl status | agents | missions [--bot pilot] | ledger [--days 7] | verify
//   flux-ctl run <mission> <objective...> [--bot operator] [--cap id ...] [--full]
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
  } else {
    console.error('usage: flux-ctl status|agents|missions|ledger|verify|run|freeze|unfreeze|retire');
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(out, null, 2));
}

main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

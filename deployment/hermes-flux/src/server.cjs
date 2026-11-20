'use strict';
// hermes-flux service.
//   127.0.0.1:18790  /mcp (bots + Flux agents), /api/* (flux-ctl, reply drafter); Bearer HERMES_FLUX_TOKEN
//   0.0.0.0:18791    Live Map dashboard; ?key=FLUX_VIEW_KEY. Metadata only, except /api/approvals which
//                    also needs &approve=FLUX_APPROVE_KEY (the Hermes Mobile app and the map's buttons).
//   0.0.0.0:18792    federation: other Flux cores with a grant signed by this host (policy.federation).
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { createFlux } = require('./app.cjs');
const { createHermesRunner } = require('./hermes-runner.cjs');
const { createTools, handleMcp, compactRun } = require('./mcp.cjs');
const { FederationGate, loadOrCreateHostKey, createFederationHandler } = require('./federation.cjs');

const env = process.env;
const STATE = env.FLUX_STATE || path.join(os.homedir(), '.hermes', 'flux', 'state');
const TOKEN = env.HERMES_FLUX_TOKEN;
const VIEW_KEY = env.FLUX_VIEW_KEY;
const APPROVE_KEY = env.FLUX_APPROVE_KEY;
if (!TOKEN || TOKEN.length < 24) { console.error('HERMES_FLUX_TOKEN (24+ chars) is required'); process.exit(2); }

const runner = createHermesRunner({ hermes: env.FLUX_HERMES_BIN || path.join(os.homedir(), '.local', 'bin', 'hermes'), profile: env.FLUX_PROFILE || 'flux' });
const flux = createFlux({ stateDir: STATE, runner });
const { engine, registry, ledger, approvals, policy, manifest } = flux;
const tools = createTools(flux);
const gate = new FederationGate({ hostKey: loadOrCreateHostKey(STATE), file: path.join(STATE, 'federation.json') });
const federate = createFederationHandler({ gate, engine, coreId: manifest.id, compact: compactRun });

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const send = (res, status, body, headers = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(text);
};

async function readBody(req, limit = 256 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function callerOf(req) {
  const agentHeader = req.headers['x-flux-agent'];
  if (agentHeader !== undefined) {
    const ticket = typeof agentHeader === 'string' && engine.tickets.has(agentHeader) ? agentHeader : null;
    return { kind: 'agent', ticket };
  }
  const bot = String(req.headers['x-hermes-bot'] || '').trim().toLowerCase();
  return bot ? { kind: 'bot', id: bot } : null;
}

const api = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const auth = String(req.headers.authorization || '');
    if (!same(auth.replace(/^Bearer\s+/i, ''), TOKEN)) return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });

    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, { Allow: 'POST' });
      const caller = callerOf(req);
      if (!caller) return send(res, 400, { error: 'X-Hermes-Bot or X-Flux-Agent header required' });
      const message = await readBody(req);
      const replies = [];
      for (const m of Array.isArray(message) ? message : [message]) {
        const r = await handleMcp(m, caller, tools);
        if (r) replies.push(r);
      }
      if (!replies.length) { res.writeHead(202); return res.end(); }
      return send(res, 200, Array.isArray(message) ? replies : replies[0]);
    }

    const bot = String(req.headers['x-hermes-bot'] || 'operator').toLowerCase();
    if (url.pathname === '/api/status' && req.method === 'GET') {
      return send(res, 200, { frozen: registry.frozen, policyRevision: policy.policyRevision, agents: registry.snapshot(), today: ledger.today(), active: activeRuns() });
    }
    if (url.pathname === '/api/missions' && req.method === 'GET') return send(res, 200, engine.missionsFor({ kind: 'bot', id: bot }));
    if (url.pathname === '/api/ledger' && req.method === 'GET') {
      const days = Math.min(31, Math.max(1, Number(url.searchParams.get('days')) || 1));
      return send(res, 200, { ...ledger.summary(days), chain: ledger.verify() });
    }
    if (url.pathname === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const result = await engine.run({ ...body, capabilities: body.capabilities?.length ? body.capabilities : undefined, requester: { kind: 'bot', id: bot } });
        return send(res, 200, url.searchParams.has('full') ? result : compactRun(result));
      } catch (error) {
        return send(res, 403, { error: error.message });
      }
    }
    if (url.pathname === '/api/control' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.action === 'freeze' || body.action === 'unfreeze') {
        registry.setFrozen(body.action === 'freeze');
        ledger.append('control', { action: body.action, by: bot });
        return send(res, 200, { frozen: registry.frozen });
      }
      if (body.action === 'retire') {
        const agent = registry.agents.get(body.agentId);
        if (!agent) return send(res, 404, { error: 'no such live agent' });
        if (agent.users) return send(res, 409, { error: 'agent is busy' });
        registry.retire(agent, `retired by ${bot}`);
        return send(res, 200, { retired: body.agentId });
      }
      return send(res, 400, { error: 'action must be freeze, unfreeze or retire' });
    }
    if (url.pathname === '/api/plan' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, engine.preview({ ...body, capabilities: body.capabilities?.length ? body.capabilities : undefined, requester: { kind: 'bot', id: bot } }));
    }
    if (url.pathname === '/api/approvals' && req.method === 'GET') return send(res, 200, approvals.list({ status: url.searchParams.get('status') || undefined }));
    if (url.pathname === '/api/approvals' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        if (body.id) return send(res, 200, approvals.decide(body.id, { decision: body.decision, by: `bot:${bot}`, note: body.note }));
        return send(res, 200, engine.requestApproval({ title: body.title, summary: body.summary, runId: body.runId, requester: `bot:${bot}` }));
      } catch (error) { return send(res, 400, { error: error.message }); }
    }
    if (url.pathname === '/api/memory' && req.method === 'GET') return send(res, 200, engine.memoryStatus());
    if (url.pathname === '/api/memory' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        if (body.action === 'forget') return send(res, 200, await engine.forget(body.agentId, { topic: body.topic, by: `bot:${bot}` }));
        if (body.action === 'rotate') {
          const agent = registry.agents.get(body.agentId);
          if (!agent) return send(res, 404, { error: 'no such live agent' });
          return send(res, 200, await engine.rotateMemory(agent, { reason: 'operator request', by: `bot:${bot}` }));
        }
        return send(res, 400, { error: 'action must be forget or rotate' });
      } catch (error) { return send(res, 400, { error: error.message }); }
    }
    if (url.pathname === '/api/federation' && req.method === 'GET') {
      return send(res, 200, { enabled: Boolean(policy.federation?.enabled), coreId: manifest.id, publicKey: gate.hostKey.publicKey, keyId: gate.hostKey.keyId, issued: gate.state.issued, revoked: gate.state.revoked });
    }
    if (url.pathname === '/api/federation' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        if (body.action === 'grant') {
          for (const m of body.missions || []) if (!manifest.missions[m]) throw new Error(`Flux: unknown mission ${m}`);
          const { token, grant } = gate.issue({ issuer: manifest.id, peerId: body.peerId, peerKey: body.peerKey, missions: body.missions, days: body.days, maxUsdPerDay: body.maxUsdPerDay });
          ledger.append('federation', { event: 'granted', grantId: grant.grantId, peerId: grant.peerId, missions: grant.missions, maxUsdPerDay: grant.maxUsdPerDay, expiresAt: grant.expiresAt, by: bot });
          return send(res, 200, { token, grant, hostKey: gate.hostKey.publicKey });
        }
        if (body.action === 'revoke') {
          gate.revoke(body.grantId);
          ledger.append('federation', { event: 'revoked', grantId: body.grantId, by: bot });
          return send(res, 200, { revoked: body.grantId });
        }
        return send(res, 400, { error: 'action must be grant or revoke' });
      } catch (error) { return send(res, 400, { error: error.message }); }
    }
    return send(res, 404, { error: 'not found' });
  } catch (error) {
    return send(res, error.status || 500, { error: String(error.message || error) });
  }
});

function activeRuns() {
  const runs = new Map();
  for (const brief of engine.briefs.values()) runs.set(brief.runId, { runId: brief.runId, mission: brief.mission, chain: brief.chain, depth: brief.depth });
  return [...runs.values()];
}

const SAFE = ['seq', 'ts', 'type', 'event', 'agentId', 'roleId', 'lifecycle', 'mission', 'capabilityId', 'kind', 'outcome', 'requester', 'rootRequester', 'profile', 'durationMs', 'disposition', 'from', 'to', 'costUsd', 'action', 'runId', 'rootRunId', 'depth', 'consults', 'sources', 'score', 'pass', 'decision', 'approvalId', 'allowed', 'expectedUsd', 'upperUsd', 'peerId', 'grantId', 'redactions'];
function viewModel() {
  const recent = ledger.records.slice(-80).map(r => {
    const out = {};
    for (const k of SAFE) if (r[k] !== undefined) out[k] = r[k];
    if (r.tokens) out.tokens = r.tokens.total;
    if (r.reason && (r.outcome === 'denied' || r.outcome === 'error' || r.type === 'agent')) out.reason = String(r.reason).slice(0, 160);
    return out;
  });
  return {
    now: new Date().toISOString(), coreId: manifest.id, policyRevision: policy.policyRevision, frozen: registry.frozen,
    agents: registry.snapshot(), active: activeRuns(), today: ledger.today(), week: ledger.summary(7), chain: ledger.verify(),
    budgets: policy.budgets, bots: Object.keys(policy.bots || {}),
    roles: Object.entries(policy.roles).map(([id, r]) => ({ id, title: r.title, lifecycle: r.lifecycle, share: r.share, memory: r.memory, ttlSeconds: r.ttlSeconds, promote: r.promote, toolsets: r.toolsets, knowledge: r.knowledge, consults: r.consults, models: r.models })),
    missions: Object.entries(manifest.missions).map(([id, caps]) => ({ id, capabilities: caps, stages: policy.missions?.[id]?.stages || null })),
    recent,
  };
}

const page = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
// The Hermes Mobile app calls /api/view and /api/approvals cross-origin with keys in the query string
// (no cookies), so CORS can be open: nothing is readable without a key.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const view = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const cookieKey = (String(req.headers.cookie || '').match(/(?:^|;\s*)flux_view=([^;]+)/) || [])[1];
  const queryKey = url.searchParams.get('key');
  if (!VIEW_KEY || !(same(queryKey, VIEW_KEY) || same(cookieKey, VIEW_KEY))) return send(res, 401, 'Flux Live Map: open with ?key=<FLUX_VIEW_KEY>', CORS);
  const cookie = { 'Set-Cookie': `flux_view=${VIEW_KEY}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` };
  if (url.pathname === '/api/view') {
    const model = viewModel();
    model.approvalsPending = approvals.list({ status: 'pending' }).length;
    model.canApprove = Boolean(APPROVE_KEY && same(url.searchParams.get('approve'), APPROVE_KEY));
    return send(res, 200, model, { ...cookie, ...CORS });
  }
  if (url.pathname === '/api/approvals') {
    if (!APPROVE_KEY || !same(url.searchParams.get('approve'), APPROVE_KEY)) return send(res, 403, { error: 'approve key required' }, CORS);
    if (req.method === 'GET') return send(res, 200, { approvals: approvals.list().slice(0, 30) }, CORS);
    if (req.method === 'POST') {
      try {
        const body = await readBody(req, 16 * 1024);
        return send(res, 200, approvals.decide(String(body.id), { decision: body.decision, by: `graham:${String(body.via || 'live-map').slice(0, 20)}`, note: body.note }), CORS);
      } catch (error) { return send(res, 400, { error: error.message }, CORS); }
    }
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // No redirect: inside an app WebView the page is third-party, so it keeps ?key= and sends it itself.
    return send(res, 200, page, { ...cookie, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
  }
  return send(res, 404, 'not found');
});

const federation = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const body = req.method === 'POST' ? await readBodyText(req) : '';
    const out = await federate(req.method, url.pathname, req.headers, body);
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  } catch (error) {
    send(res, error.status || 500, { error: String(error.message || error) });
  }
});

async function readBodyText(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

setInterval(() => {
  try { registry.reap(); approvals.expire(); } catch (error) { console.error('reap failed:', error.message); }
}, 15000).unref();

api.listen(Number(env.FLUX_PORT || 18790), env.FLUX_HOST || '127.0.0.1', () => console.log(`hermes-flux API on ${env.FLUX_HOST || '127.0.0.1'}:${env.FLUX_PORT || 18790}`));
if (VIEW_KEY) view.listen(Number(env.FLUX_VIEW_PORT || 18791), env.FLUX_VIEW_HOST || '0.0.0.0', () => console.log(`hermes-flux Live Map on ${env.FLUX_VIEW_HOST || '0.0.0.0'}:${env.FLUX_VIEW_PORT || 18791}`));
if (policy.federation?.enabled) federation.listen(Number(policy.federation.port || 18792), env.FLUX_FEDERATION_HOST || '0.0.0.0', () => console.log(`hermes-flux federation on port ${policy.federation.port || 18792} (key ${gate.hostKey.keyId})`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { registry.save(); await Promise.race([engine.settle(), new Promise(r => setTimeout(r, 5000))]); process.exit(0); });

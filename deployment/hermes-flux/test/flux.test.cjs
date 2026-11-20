'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFlux } = require('../src/app.cjs');
const { chooseProfile } = require('../src/router.cjs');

const APP = path.join(__dirname, '..');
const basePolicy = () => JSON.parse(fs.readFileSync(path.join(APP, 'operator', 'policy.json'), 'utf8'));

/** Fake Hermes: answers per role, optionally consulting through the ticket in the role contract. */
function fakeRunner({ consult, cite, usage = 1000 } = {}) {
  const calls = [];
  let n = 0;
  const runner = {
    calls,
    discarded: [],
    async run({ roleId, prompt, resume, ticket }) {
      calls.push({ roleId, resume, prompt });
      const sessionId = resume || `s${++n}`;
      const refs = [];
      if (consult?.[roleId]) refs.push(...(await consult[roleId](ticket)));
      const knowledge = (prompt.match(/\[(knowledge:[^\]]+)\]/) || [])[1];
      const input = (prompt.match(/\[input:([^\]]+)\]/) || [])[1];
      const sources = cite?.[roleId] || [...refs, knowledge, input && `input:${input}`, 'https://example.org/spec'].filter(Boolean);
      return {
        sessionId,
        text: JSON.stringify({ summary: `${roleId} finding`, sources, disposition: roleId === 'compliance.reviewer' ? 'change-needed' : 'info' }),
        tokens: { input: usage, output: usage / 10 },
        cumulative: null,
        evidence: 'fetched https://example.org/spec',
        durationMs: 5,
      };
    },
    async discard(id) { runner.discarded.push(id); },
  };
  return runner;
}

function setup({ runner = fakeRunner(), policy = basePolicy(), now } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-test-'));
  return { ...createFlux({ appDir: APP, stateDir, runner, policy, now }), runner, stateDir, policy };
}

const bot = id => ({ kind: 'bot', id });

test('purchase review: parallel stage, shared reviewer promoted by three distinct requesters, steward remembers', async () => {
  let flux;
  const ask = async ticket => (await flux.engine.consult(ticket, { mission: 'compliance-review', question: 'doorbell covers the street?' })).findings.map(f => f.ref);
  const runner = fakeRunner({ consult: { 'market.analyst': ask, 'security.analyst': ask, 'household.steward': ask } });
  flux = setup({ runner });

  const first = await flux.engine.run({ mission: 'purchase-review', objective: 'Video doorbell under £150 with privacy zones', requester: bot('pilot') });
  assert.deepEqual(first.findings.map(f => f.capabilityId).sort(), ['household.policy', 'household.steward', 'market.analyst', 'security.analyst']);
  const kinds = first.events.map(e => e.kind);
  assert.equal(kinds.filter(k => k === 'agent-promoted').length, 1);
  const reviewer = flux.registry.snapshot().find(a => a.roleId === 'compliance.reviewer');
  assert.equal(reviewer.lifecycle, 'persistent');
  assert.equal(reviewer.distinctRequesters, 3);
  assert.equal(runner.calls.filter(c => c.roleId === 'compliance.reviewer').length, 3, 'one logical reviewer, three separate answers');
  assert.ok(!flux.registry.snapshot().some(a => a.lifecycle === 'task'), 'task agents retired');
  const steward = flux.registry.snapshot().find(a => a.roleId === 'household.steward');
  assert.equal(steward.lifecycle, 'persistent');
  assert.match(runner.calls.find(c => c.roleId === 'household.steward').prompt, /\[input:finding:market\.analyst\]/, 'steward receives stage-1 hand-offs');
  assert.ok(first.usage.missionTokens > first.usage.tokens, 'mission totals include consultations');

  await flux.engine.run({ mission: 'steward-log', objective: 'What did we decide about the doorbell?', requester: bot('pilot') });
  const stewardCalls = runner.calls.filter(c => c.roleId === 'household.steward');
  assert.equal(stewardCalls[0].resume, null);
  assert.ok(stewardCalls[1].resume, 'continuous memory resumes the same Hermes session');
  assert.equal(stewardCalls[2]?.resume, undefined);
  assert.equal(flux.ledger.verify().ok, true);
});

test('denials happen before any agent or tool runs', async () => {
  const flux = setup();
  const denied = [
    [{ mission: 'purchase-review', objective: 'x', requester: bot('forge') }, /not granted/],
    [{ mission: 'vendor-contact', objective: 'x', requester: bot('pilot') }, /not granted/],
    [{ mission: 'inbox-brief', objective: 'x', capabilities: ['phone.send'], requester: bot('pilot') }, /capability denied: phone.send/],
    [{ mission: 'research', objective: 'x', requester: bot('nobody') }, /not granted/],
  ];
  for (const [req, pattern] of denied) await assert.rejects(flux.engine.run(req), pattern);
  assert.equal(flux.runner.calls.length, 0);
  assert.equal(flux.ledger.today().denied, 4);
  assert.equal(flux.ledger.records.filter(r => r.type === 'step').length, 0);
});

test('agents can only consult what their role allows, without loops', async () => {
  let flux;
  const runner = fakeRunner({ consult: { 'compliance.reviewer': async t => { await flux.engine.consult(t, { mission: 'compliance-review', question: 'again' }); return []; } } });
  flux = setup({ runner });
  await assert.rejects(flux.engine.run({ mission: 'compliance-review', objective: 'q', requester: bot('pilot') }), /may not consult/);
  await assert.rejects(flux.engine.consult('forged', { mission: 'research', question: 'q' }), /unknown or expired agent ticket/);
});

test('invented sources are dropped and an uncited finding is rejected', async () => {
  const runner = fakeRunner({ cite: { 'research.analyst': ['https://made-up.example/never-fetched', 'knowledge:compliance/uk-domestic-cameras.md'] } });
  const flux = setup({ runner });
  await assert.rejects(flux.engine.run({ mission: 'research', objective: 'q', requester: bot('pilot') }), /no grounded source; dropped https:\/\/made-up/);
  const step = flux.ledger.records.find(r => r.type === 'step');
  assert.equal(step.outcome, 'rejected');
  assert.equal(step.droppedSources.length, 2, 'knowledge the role was not given cannot be cited either');
});

test('TTL agents idle, are reused across workflows, then expire; persistent agents survive a restart', async () => {
  let clock = Date.parse('2026-11-20T10:00:00Z');
  const now = () => clock;
  const flux = setup({ now });
  await flux.engine.run({ mission: 'compliance-review', objective: 'a', requester: bot('pilot') });
  await flux.engine.run({ mission: 'compliance-review', objective: 'b', requester: bot('atlas'), workflow: 'other' });
  const reviewers = flux.registry.snapshot().filter(a => a.roleId === 'compliance.reviewer');
  assert.equal(reviewers.length, 1);
  assert.equal(reviewers[0].calls, 2);
  assert.equal(reviewers[0].ttlRemainingSeconds, 900);
  clock += 901000;
  flux.registry.reap();
  assert.equal(flux.registry.snapshot().length, 0, 'idle ttl agent retired');

  await flux.engine.run({ mission: 'steward-log', objective: 'note', requester: bot('pilot') });
  const { Registry } = require('../src/registry.cjs');
  const reloaded = new Registry({ policy: flux.policy, file: path.join(flux.stateDir, 'registry.json'), ledger: flux.ledger, runner: flux.runner, now });
  assert.deepEqual(reloaded.snapshot().map(a => a.lifecycle), ['persistent']);
});

test('budgets fail closed: daily cap before start, mission cap between stages', async () => {
  const policy = basePolicy();
  policy.budgets.dailyUsd = 0.001;
  const flux = setup({ policy, runner: fakeRunner({ usage: 100000 }) });
  await flux.engine.run({ mission: 'research', objective: 'first', requester: bot('pilot') });
  await assert.rejects(flux.engine.run({ mission: 'research', objective: 'second', requester: bot('pilot') }), /daily cost budget exhausted/);

  const tight = basePolicy();
  tight.missions['purchase-review'].maxTokens = 50000;
  const second = setup({ policy: tight, runner: fakeRunner({ usage: 100000 }) });
  await assert.rejects(second.engine.run({ mission: 'purchase-review', objective: 'doorbell', requester: bot('pilot') }), /mission token budget exhausted/);
  assert.equal(second.runner.calls.some(c => c.roleId === 'household.steward'), false, 'later stage never starts');
});

test('frozen runtime denies new work and retires idle non-persistent agents', async () => {
  const flux = setup();
  await flux.engine.run({ mission: 'compliance-review', objective: 'a', requester: bot('pilot') });
  flux.registry.setFrozen(true);
  assert.equal(flux.registry.snapshot().length, 0);
  await assert.rejects(flux.engine.run({ mission: 'research', objective: 'q', requester: bot('pilot') }), /frozen/);
});

test('ledger detects tampering', async () => {
  const flux = setup();
  await flux.engine.run({ mission: 'research', objective: 'q', requester: bot('pilot') });
  const file = path.join(flux.stateDir, 'ledger.jsonl');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"costUsd":[0-9.e-]+/, '"costUsd":0'));
  assert.equal(flux.ledger.verify().ok, false);
});

test('flux_fetch refuses the household network and roles without web access', async () => {
  const { fetchPage, privateAddress } = require('../src/fetch.cjs');
  for (const ip of ['192.168.68.57', '127.0.0.1', '10.1.2.3', '172.20.0.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:192.168.68.10']) assert.equal(privateAddress(ip), true, ip);
  assert.equal(privateAddress('93.184.216.34'), false);
  await assert.rejects(fetchPage('http://192.168.68.57:8080/mcp'), /not a public internet address/);
  const lookup = async () => [{ address: '192.168.68.10' }];
  await assert.rejects(fetchPage('https://sneaky.example/', { lookup }), /not a public internet address/);
  const redirect = async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:18790/api/status' } });
  await assert.rejects(fetchPage('https://93.184.216.34/', { fetchImpl: redirect }), /127\.0\.0\.1 is not a public/);

  let flux;
  const runner = fakeRunner({ consult: { 'household.steward': async t => { await flux.engine.fetch(t, 'https://example.org'); return []; } } });
  flux = setup({ runner });
  await assert.rejects(flux.engine.run({ mission: 'steward-log', objective: 'q', requester: bot('pilot') }), /has no web access/);
});

test('router explores cold profiles, then picks the cheapest qualifying one, and abstains below the floor', () => {
  const profiles = { cheap: { inputPerMTok: 1, outputPerMTok: 5, qualityFloor: 0.8 }, dear: { inputPerMTok: 3, outputPerMTok: 15, qualityFloor: 0.8 } };
  const role = { models: ['dear', 'cheap'] };
  assert.equal(chooseProfile(role, profiles, () => ({ n: 0, ok: 0, avgCostUsd: 0, avgMs: 0 })).id, 'cheap');
  const stats = { cheap: { n: 5, ok: 3, avgCostUsd: 0.001, avgMs: 10 }, dear: { n: 5, ok: 5, avgCostUsd: 0.004, avgMs: 10 } };
  assert.equal(chooseProfile(role, profiles, id => stats[id]).id, 'dear', 'cheap is below its quality floor');
  stats.dear.ok = 2;
  assert.throws(() => chooseProfile(role, profiles, id => stats[id]), /quality floor/);
});

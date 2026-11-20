'use strict';
// Flux engine for Hermes. The vendored @corpgen/flux-runtime stays the policy gate (missions, capability
// grants, tenant/scope, cited findings). This layer adds what a household runtime of real agents needs:
// who may ask (bots and agents), staged parallel missions with hand-offs, agent-to-agent consultation,
// budgets, the token/cost ledger, model routing and citation grounding.
const fs = require('node:fs');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { createCore, createCatalogue, VERSION } = require('../vendor/flux-runtime');
const { chooseProfile, costOf } = require('./router.cjs');
const contract = require('./contract.cjs');
const { fetchPage } = require('./fetch.cjs');

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const runId = () => `run-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

function fail(message) { throw new Error(`Flux: ${message}`); }

function validatePolicy(manifest, packs, policy) {
  const caps = new Map(packs.flatMap(p => p.capabilities).map(c => [c.id, c]));
  for (const [missionId, list] of Object.entries(manifest.missions)) {
    for (const capId of list) {
      if (caps.get(capId)?.kind === 'specialist' && !policy.roles?.[capId]) fail(`specialist ${capId} has no operator role`);
    }
    const stages = policy.missions?.[missionId]?.stages;
    if (stages) {
      const flat = stages.flat();
      if (flat.length !== list.length || new Set(flat).size !== flat.length || flat.some(c => !list.includes(c))) {
        fail(`stages for ${missionId} must partition its capabilities`);
      }
    }
  }
  for (const [roleId, role] of Object.entries(policy.roles || {})) {
    if (!['task', 'ttl', 'persistent'].includes(role.lifecycle)) fail(`role ${roleId} has an invalid lifecycle`);
    if (role.lifecycle === 'ttl' && !(role.ttlSeconds > 0)) fail(`role ${roleId} needs ttlSeconds`);
    for (const m of role.models || []) if (!policy.modelProfiles?.[m]) fail(`role ${roleId} names unknown model profile ${m}`);
    for (const m of role.consults || []) {
      if (!manifest.missions[m]) fail(`role ${roleId} consults unknown mission ${m}`);
      if (manifest.missions[m].includes(roleId)) fail(`role ${roleId} cannot consult a mission that includes itself`);
    }
  }
  for (const [bot, missions] of Object.entries(policy.bots || {})) {
    for (const m of missions) if (!manifest.missions[m]) fail(`bot ${bot} granted unknown mission ${m}`);
  }
}

function readEnvValue(file, name) {
  try {
    const text = fs.readFileSync(file.replace(/^~/, os.homedir()), 'utf8');
    const match = text.match(new RegExp(`^${name}=(.*)$`, 'm'));
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

class FluxEngine {
  constructor({ manifest, packs, policy, createBindings, registry, ledger, knowledgeDir, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    validatePolicy(manifest, packs, policy);
    Object.assign(this, { manifest, packs, policy, registry, ledger, fetchImpl, now });
    this.catalogue = createCatalogue(manifest, packs);
    this.capabilities = new Map(packs.flatMap(p => p.capabilities).map(c => [c.id, c]));
    this.knowledge = contract.loadKnowledge(knowledgeDir);
    this.briefs = new Map();
    this.tickets = new Map();
    const host = {
      openAgent: input => this.openAgent(input),
      knowledgeLookup: input => this.knowledgeLookup(input),
      phoneMessages: input => this.phoneMessages(input),
    };
    const bindings = {};
    for (const [name, binding] of Object.entries(createBindings(host))) {
      bindings[name] = { ...binding, execute: input => this.timedTool(binding, input) };
    }
    this.core = createCore({ manifest, packs, bindings, tenantId: policy.tenantId, scopeId: policy.scopeId });
  }

  // ---------- who may ask ----------

  missionsFor(requester) {
    const allowed = requester.kind === 'bot' ? this.policy.bots?.[requester.id] || []
      : this.policy.roles?.[requester.roleId]?.consults || [];
    return allowed.map(missionId => ({
      mission: missionId,
      parallel: Boolean(this.policy.missions?.[missionId]?.stages),
      budget: { maxTokens: this.policy.missions?.[missionId]?.maxTokens, maxUsd: this.policy.missions?.[missionId]?.maxUsd },
      capabilities: this.core.discover(missionId).map(c => {
        const role = this.policy.roles?.[c.id];
        return {
          id: c.id, kind: c.kind, description: c.description,
          ...(role ? { title: role.title, lifecycle: role.lifecycle, toolsets: role.toolsets, knowledge: role.knowledge, consults: role.consults } : {}),
        };
      }),
    }));
  }

  authorize(mission, requester, brief) {
    if (this.registry.frozen) fail('runtime frozen by operator');
    if (requester.kind === 'bot') {
      if (!(this.policy.bots?.[requester.id] || []).includes(mission)) fail(`mission ${mission} is not granted to ${requester.id}`);
    } else if (requester.kind === 'agent') {
      if (!(this.policy.roles?.[requester.roleId]?.consults || []).includes(mission)) fail(`${requester.roleId} may not consult ${mission}`);
      const missionCaps = this.manifest.missions[mission] || [];
      const chainRoles = brief.chain.map(c => c.split('#')[0]);
      if (missionCaps.some(c => chainRoles.includes(c))) fail(`consultation loop: ${mission} includes a role already in this chain`);
    } else fail('unknown requester');
    if (brief.depth > (this.policy.budgets?.maxDepth ?? 2)) fail('consultation depth limit reached');
  }

  checkBudget(brief) {
    const budgets = this.policy.budgets || {};
    const today = this.ledger.today();
    if (budgets.dailyUsd != null && today.costUsd >= budgets.dailyUsd) fail(`daily cost budget exhausted ($${today.costUsd.toFixed(4)} of $${budgets.dailyUsd})`);
    if (budgets.dailyTokens != null && today.tokens >= budgets.dailyTokens) fail(`daily token budget exhausted (${today.tokens} of ${budgets.dailyTokens})`);
    const { limits, tokens, usd } = brief.root;
    if (limits.maxTokens != null && tokens >= limits.maxTokens) fail(`mission token budget exhausted (${tokens} of ${limits.maxTokens})`);
    if (limits.maxUsd != null && usd >= limits.maxUsd) fail(`mission cost budget exhausted ($${usd.toFixed(4)} of $${limits.maxUsd})`);
  }

  /** Whole-plan preflight: every stage is resolved and every grant checked before the first step runs. */
  plan(mission, capabilities) {
    const steps = this.catalogue.resolve(mission, capabilities).map(c => c.id);
    const granted = new Set(this.core.discover(mission).map(c => c.id));
    for (const capId of steps) if (!granted.has(capId)) fail(`missing authorised binding: ${capId}`);
    const stages = this.policy.missions?.[mission]?.stages || steps.map(s => [s]);
    return stages.map(stage => stage.filter(c => steps.includes(c))).filter(stage => stage.length);
  }

  // ---------- running missions ----------

  async run({ mission, objective, inputs = [], capabilities, workflow, requester }) {
    const id = runId();
    const started = this.now();
    const parent = requester.parent || null;
    const root = parent ? parent.root : { runId: id, tokens: 0, usd: 0, limits: this.policy.missions?.[mission] || {} };
    const chain = parent ? [...parent.chain, requester.id] : [`${requester.kind === 'bot' ? 'bot' : 'agent'}:${requester.id}`];
    const brief = {
      runId: id, mission, objective, workflowKey: workflow || parent?.workflowKey || id, scopeId: this.policy.scopeId,
      requesterId: requester.kind === 'bot' ? `bot:${requester.id}` : requester.id, rootRequester: parent ? parent.rootRequester : chain[0],
      chain, depth: parent ? parent.depth + 1 : 0, root, usage: { tokens: 0, usd: 0 },
      inputs: [], meta: new Map(), events: [], executed: false,
    };
    const ledgerBase = { runId: id, rootRunId: root.runId, mission, requester: brief.requesterId, rootRequester: brief.rootRequester, depth: brief.depth };
    try {
      if (typeof mission !== 'string' || !ID.test(mission)) fail('invalid mission id');
      if (workflow !== undefined && (typeof workflow !== 'string' || !ID.test(workflow))) fail('invalid workflow id');
      if (typeof objective !== 'string' || !objective.trim() || objective.length > 8000) fail('objective must be 1-8000 characters');
      if (!Array.isArray(inputs) || inputs.length > 12) fail('at most 12 inputs');
      brief.inputs = inputs.map(i => {
        if (!i || typeof i.ref !== 'string' || !ID.test(i.ref) || typeof i.text !== 'string' || i.text.length > 12000) fail('each input needs a ref id and text up to 12000 characters');
        return { ref: i.ref, text: i.text };
      });
      this.authorize(mission, requester, brief);
      this.checkBudget(brief);
      const stages = this.plan(mission, capabilities);

      const findings = [], events = [];
      let runtimeVersion = VERSION, coreId = this.manifest.id;
      for (const [index, stage] of stages.entries()) {
        this.checkBudget(brief);
        const workflowId = `${id}.s${index + 1}`;
        const handoff = findings.map(f => ({ ref: `finding:${f.capabilityId}`, text: `${f.summary}\nSources: ${f.sources.join(', ')}` }));
        this.briefs.set(workflowId, { ...brief, inputs: [...brief.inputs, ...handoff] });
        try {
          const ctx = { workflowId, tenantId: this.policy.tenantId, scopeId: this.policy.scopeId };
          const results = await Promise.allSettled(stage.map(capId => this.core.run(mission, ctx, [capId])));
          const failure = results.find(r => r.status === 'rejected');
          if (failure) throw failure.reason;
          for (const r of results) {
            ({ runtimeVersion, coreId } = r.value);
            findings.push(...r.value.findings);
            events.push(...r.value.events);
          }
        } finally {
          brief.executed ||= this.briefs.get(workflowId).executed;
          this.briefs.delete(workflowId);
        }
      }
      const enriched = findings.map(f => ({ ...f, ...(brief.meta.get(f.capabilityId) || {}) }));
      const result = {
        runId: id, coreId, runtimeVersion, mission, requester: brief.requesterId, findings: enriched,
        events: [...events, ...brief.events],
        usage: { tokens: brief.usage.tokens, costUsd: round(brief.usage.usd), missionTokens: root.tokens, missionCostUsd: round(root.usd) },
        durationMs: this.now() - started,
      };
      this.ledger.append('run', { ...ledgerBase, outcome: 'ok', durationMs: result.durationMs, tokens: brief.usage.tokens, costUsd: round(brief.usage.usd), findings: enriched.map(f => ({ capabilityId: f.capabilityId, disposition: f.disposition || null, sources: f.sources.length })) });
      return result;
    } catch (error) {
      const outcome = brief.executed ? 'error' : 'denied';
      this.ledger.append('run', { ...ledgerBase, outcome, reason: String(error.message).slice(0, 500), durationMs: this.now() - started, tokens: brief.usage.tokens, costUsd: round(brief.usage.usd) });
      throw error;
    }
  }

  /** Agent-to-agent: a running agent consults another mission with its per-call ticket. */
  async consult(ticket, { mission, question }) {
    const holder = this.tickets.get(ticket);
    if (!holder) fail('unknown or expired agent ticket');
    const result = await this.run({ mission, objective: question, requester: { kind: 'agent', id: holder.agentId, roleId: holder.roleId, parent: holder.brief } });
    holder.brief.events.push(...result.events.filter(e => e.agentId));
    holder.consultRuns++;
    const findings = result.findings.map(f => {
      const ref = `flux:${result.runId}/${f.capabilityId}`;
      holder.consultRefs.add(ref);
      return { ref, capabilityId: f.capabilityId, agentId: f.agentId, disposition: f.disposition, summary: f.summary, sources: f.sources };
    });
    return { runId: result.runId, findings, usage: result.usage };
  }

  /** Agent page reader: only for roles whose contract includes web access. */
  async fetch(ticket, url) {
    const holder = this.tickets.get(ticket);
    if (!holder) fail('unknown or expired agent ticket');
    if (!(this.policy.roles[holder.roleId]?.toolsets || []).includes('web')) fail(`${holder.roleId} has no web access`);
    holder.fetches++;
    return fetchPage(url, { fetchImpl: this.fetchImpl });
  }

  // ---------- bindings ----------

  brief(workflowId) {
    const brief = this.briefs.get(workflowId);
    if (!brief) fail(`no active brief for ${workflowId}`);
    return brief;
  }

  async timedTool(binding, input) {
    const brief = this.brief(input.workflowId);
    brief.executed = true;
    const started = this.now();
    const kind = this.capabilities.get(input.capabilityId)?.kind;
    const base = { runId: brief.runId, rootRunId: brief.root.runId, mission: brief.mission, capabilityId: input.capabilityId, kind, rootRequester: brief.rootRequester, tokens: { total: 0 }, costUsd: 0 };
    try {
      const out = await binding.execute(input);
      this.ledger.append('step', { ...base, outcome: 'ok', durationMs: this.now() - started, sources: out?.sources?.length || 0 });
      return out;
    } catch (error) {
      this.ledger.append('step', { ...base, outcome: 'error', reason: String(error.message).slice(0, 300), durationMs: this.now() - started });
      throw error;
    }
  }

  openAgent(input) {
    const brief = this.brief(input.workflowId);
    this.checkBudget(brief);
    const agent = this.registry.acquire(input.capabilityId, brief);
    brief.executed = true;
    return {
      execute: call => this.callAgent(agent, this.brief(call.workflowId)),
      close: () => this.registry.release(agent, brief),
    };
  }

  async callAgent(agent, brief) {
    const role = this.policy.roles[agent.roleId];
    this.checkBudget(brief);
    const choice = chooseProfile(role, this.policy.modelProfiles, p => this.ledger.profileStats(agent.roleId, p));
    const profile = this.policy.modelProfiles[choice.id];
    const knowledge = (role.knowledge || []).flatMap(pack => this.knowledge.get(pack) || []);
    const ticket = randomBytes(18).toString('base64url');
    const consultRefs = new Set();
    const holder = { agentId: agent.id, roleId: agent.roleId, brief: { ...brief, chain: brief.chain }, consultRefs, consultRuns: 0, fetches: 0 };
    this.tickets.set(ticket, holder);
    const prompt = contract.buildPrompt({ agent, role, brief, knowledge, consults: role.consults || [], ticket });
    const started = this.now();
    const base = { runId: brief.runId, rootRunId: brief.root.runId, mission: brief.mission, capabilityId: agent.roleId, kind: 'specialist', agentId: agent.id, lifecycle: agent.lifecycle, profile: choice.id, model: profile.model, routing: choice.reason, rootRequester: brief.rootRequester };
    let out;
    try {
      out = await this.registry.call(agent, { prompt, profile, ticket });
    } catch (error) {
      this.ledger.append('step', { ...base, outcome: 'error', reason: String(error.message).slice(0, 300), durationMs: this.now() - started, tokens: { total: 0 }, costUsd: 0 });
      throw error;
    } finally {
      this.tickets.delete(ticket);
    }
    const finding = contract.parseFinding(out.text);
    const grounding = contract.ground(finding.sources, {
      knowledge: new Set(knowledge.map(k => k.ref)), inputs: new Set(brief.inputs.map(i => i.ref)), consults: consultRefs, evidence: out.evidence || '',
    });
    const cost = costOf(out.usage, profile, out.hermesCostUsd);
    // brief.root is shared by nested consultations, so mission budgets include specialist spend.
    for (const target of [brief.usage, brief.root]) { target.tokens += out.usage.total; target.usd += cost.usd; }
    this.registry.account(agent, out.usage.total, cost.usd);
    const ok = grounding.kept.length > 0;
    brief.meta.set(agent.roleId, { agentId: agent.id, lifecycle: agent.lifecycle, disposition: finding.disposition, profile: choice.id, droppedSources: grounding.dropped, tokens: out.usage.total, costUsd: cost.usd });
    this.ledger.append('step', {
      ...base, outcome: ok ? 'ok' : 'rejected', durationMs: out.durationMs ?? this.now() - started,
      tokens: out.usage, costUsd: cost.usd, costBasis: cost.basis, hermesSession: out.sessionId,
      disposition: finding.disposition, sources: grounding.kept.length, droppedSources: grounding.dropped, consults: holder.consultRuns, fetches: holder.fetches,
      ...(finding.malformed ? { malformed: true } : {}),
    });
    if (!ok) fail(`${agent.id} returned no grounded source${finding.malformed ? ' (reply was not the JSON finding contract)' : ''}${grounding.dropped.length ? `; dropped ${grounding.dropped.slice(0, 3).join(', ')}` : ''}`);
    return { summary: finding.summary, sources: grounding.kept };
  }

  knowledgeLookup(input) {
    const brief = this.brief(input.workflowId);
    const tool = this.policy.tools?.[input.capabilityId] || {};
    const docs = this.knowledge.get(tool.knowledge) || [];
    const passages = contract.lookup(docs, brief.objective, tool.passages ?? 3);
    if (!passages.length) {
      return { summary: `No ${tool.knowledge} rule matched this request. Treat it as unclassified, not as permitted.`, sources: docs.map(d => d.ref) };
    }
    return { summary: passages.map(p => `${p.heading}: ${p.text.replace(/^##.*\n/, '').trim()}`).join('\n\n'), sources: passages.map(p => p.ref) };
  }

  async phoneMessages(input) {
    const brief = this.brief(input.workflowId);
    const cfg = this.policy.phone || {};
    const token = readEnvValue(cfg.tokenEnvFile || '', cfg.tokenVar || 'HERMES_PHONE_TOKEN');
    if (!token) fail('phone token is not configured');
    const bot = brief.rootRequester.replace(/^(bot|agent):/, '');
    const response = await this.fetchImpl(cfg.locatorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, 'X-Hermes-Bot': bot },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'phone_messages', arguments: {} } }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.json();
    const text = body?.result?.content?.map(c => c.text).join('\n') || body?.error?.message || '';
    if (!response.ok || body?.result?.isError || !text) fail(`phone did not return messages: ${text.slice(0, 200) || response.status}`);
    return { summary: text.slice(0, 12000), sources: [`phone:notifications@${new Date(this.now()).toISOString()}`] };
  }
}

function round(n) { return Math.round(n * 1e8) / 1e8; }

module.exports = { FluxEngine, validatePolicy };

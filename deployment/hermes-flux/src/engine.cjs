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
const quality = require('./quality.cjs');
const memory = require('./memory.cjs');
const { createHash } = require('node:crypto');

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
  constructor({ manifest, packs, policy, createBindings, registry, ledger, approvals, knowledgeDir, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    validatePolicy(manifest, packs, policy);
    Object.assign(this, { manifest, packs, policy, registry, ledger, approvals, fetchImpl, now });
    this.grading = new Set();
    this.catalogue = createCatalogue(manifest, packs);
    this.capabilities = new Map(packs.flatMap(p => p.capabilities).map(c => [c.id, c]));
    this.knowledge = contract.loadKnowledge(knowledgeDir);
    this.briefs = new Map();
    this.tickets = new Map();
    const host = {
      openAgent: input => this.openAgent(input),
      knowledgeLookup: input => this.knowledgeLookup(input),
      phoneMessages: input => this.phoneMessages(input),
      briefOf: input => { const b = this.brief(input.workflowId); return { objective: b.objective, inputs: b.inputs }; },
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
      : requester.kind === 'peer' ? (requester.missions || []).filter(m => this.manifest.missions[m])
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
    } else if (requester.kind === 'peer') {
      if (!(requester.missions || []).includes(mission)) fail(`mission ${mission} is not in peer ${requester.id}'s grant`);
      const cap = requester.maxUsdPerDay;
      const spent = this.ledger.since(new Date(new Date(this.now()).setHours(0, 0, 0, 0)).getTime())
        .filter(r => r.type === 'step' && r.rootRequester === `peer:${requester.id}`).reduce((s, r) => s + (r.costUsd || 0), 0);
      if (cap != null && spent >= cap) fail(`peer ${requester.id} has used its daily allowance ($${spent.toFixed(4)} of $${cap})`);
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

  makeBrief({ id, mission, objective, workflow, requester }) {
    const parent = requester.parent || null;
    const root = parent ? parent.root : { runId: id, tokens: 0, usd: 0, limits: this.policy.missions?.[mission] || {} };
    const label = requester.kind === 'agent' ? requester.id : `${requester.kind}:${requester.id}`;
    const chain = parent ? [...parent.chain, requester.id] : [label];
    return {
      runId: id, mission, objective, workflowKey: workflow || parent?.workflowKey || id, scopeId: this.policy.scopeId,
      requesterId: label, rootRequester: parent ? parent.rootRequester : chain[0],
      chain, depth: parent ? parent.depth + 1 : 0, root, usage: { tokens: 0, usd: 0 },
      inputs: [], meta: new Map(), events: [], executed: false,
    };
  }

  validateRequest(brief, { mission, objective, inputs, workflow }) {
    if (typeof mission !== 'string' || !ID.test(mission)) fail('invalid mission id');
    if (workflow !== undefined && (typeof workflow !== 'string' || !ID.test(workflow))) fail('invalid workflow id');
    if (typeof objective !== 'string' || !objective.trim() || objective.length > 8000) fail('objective must be 1-8000 characters');
    if (!Array.isArray(inputs) || inputs.length > 12) fail('at most 12 inputs');
    brief.inputs = inputs.map(i => {
      if (!i || typeof i.ref !== 'string' || !ID.test(i.ref) || typeof i.text !== 'string' || i.text.length > 12000) fail('each input needs a ref id and text up to 12000 characters');
      return { ref: i.ref, text: i.text };
    });
  }

  async run({ mission, objective, inputs = [], capabilities, workflow, requester }) {
    const id = runId();
    const started = this.now();
    const brief = this.makeBrief({ id, mission, objective, workflow, requester });
    const { root } = brief;
    const ledgerBase = { runId: id, rootRunId: root.runId, mission, requester: brief.requesterId, rootRequester: brief.rootRequester, depth: brief.depth };
    try {
      this.validateRequest(brief, { mission, objective, inputs, workflow });
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
      // A finding that needs Graham's decision becomes an approval (top-level runs only; consult
      // findings surface through the agent that asked).
      if (brief.depth === 0 && this.approvals) {
        const on = new Set(this.policy.approvals?.on || ['human-review']);
        for (const f of enriched.filter(x => on.has(x.disposition))) {
          const item = this.approvals.create({
            title: `${this.policy.roles?.[f.capabilityId]?.title || f.capabilityId}: ${objective.replace(/\s+/g, ' ').slice(0, 120)}`,
            summary: f.summary, runId: id, mission, capabilityId: f.capabilityId, agentId: f.agentId, requester: brief.requesterId, sources: f.sources,
          });
          f.approval = { id: item.id, status: item.status };
        }
      }
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
      holder.consultTexts.push(`[${ref}] ${f.summary}`);
      return { ref, capabilityId: f.capabilityId, agentId: f.agentId, disposition: f.disposition, summary: f.summary, sources: f.sources };
    });
    return { runId: result.runId, findings, usage: result.usage };
  }

  /**
   * Dry run: the same authorisation, budget and plan checks as run(), then what would happen (spawn or
   * reuse, model choice, estimated tokens and cost from the ledger, possible consultations), with zero
   * model calls. A plan that would be refused says so instead of throwing.
   */
  preview({ mission, objective, inputs = [], capabilities, workflow, requester }) {
    const brief = this.makeBrief({ id: 'preview', mission, objective, workflow, requester });
    const fallback = this.policy.estimates?.defaultTokens ?? 40000;
    const estimateFor = (capId, kind, profileId) => {
      if (kind !== 'specialist') return { tokens: 0, usd: 0, samples: 0, basis: 'tool (no model)' };
      const seen = this.ledger.estimate(capId, profileId);
      if (seen) return seen;
      const p = this.policy.modelProfiles[profileId];
      return { tokens: fallback, usd: (fallback * 0.85 * (p.inputPerMTok || 0) + fallback * 0.15 * (p.outputPerMTok || 0)) / 1e6, samples: 0, basis: 'default guess' };
    };
    const describe = capId => {
      const cap = this.capabilities.get(capId);
      if (cap.kind !== 'specialist') return { capabilityId: capId, kind: cap.kind, estimate: estimateFor(capId, cap.kind) };
      const role = this.policy.roles[capId];
      const reuse = this.registry.findReusable(capId, brief);
      const choice = chooseProfile(role, this.policy.modelProfiles, p => this.ledger.profileStats(capId, p));
      return {
        capabilityId: capId, kind: cap.kind, title: role.title, lifecycle: role.lifecycle,
        agent: reuse ? `reuse ${reuse.id} (${reuse.lifecycle})` : `spawn new ${role.lifecycle} agent`,
        model: { profile: choice.id, why: choice.reason }, tools: role.toolsets, knowledge: role.knowledge,
        estimate: estimateFor(capId, cap.kind, choice.id), mayConsult: role.consults || [],
      };
    };
    try {
      this.validateRequest(brief, { mission, objective, inputs, workflow });
      this.authorize(mission, requester, brief);
      this.checkBudget(brief);
      const stages = this.plan(mission, capabilities).map(stage => stage.map(describe));
      const expected = stages.flat().reduce((s, st) => ({ tokens: s.tokens + st.estimate.tokens, usd: s.usd + st.estimate.usd }), { tokens: 0, usd: 0 });
      const consults = [...new Set(stages.flat().flatMap(st => st.mayConsult || []))].map(m => {
        const steps = (this.manifest.missions[m] || []).map(describe);
        return { mission: m, steps: steps.map(s => s.capabilityId), estimate: steps.reduce((s, st) => ({ tokens: s.tokens + st.estimate.tokens, usd: s.usd + st.estimate.usd }), { tokens: 0, usd: 0 }) };
      });
      const consultCount = stages.flat().filter(st => st.mayConsult?.length).length;
      const upper = consults.reduce((s, c) => ({ tokens: s.tokens + c.estimate.tokens * consultCount, usd: s.usd + c.estimate.usd * consultCount }), { ...expected });
      const today = this.ledger.today(), budgets = this.policy.budgets || {}, limits = brief.root.limits;
      const warnings = [];
      if (limits.maxUsd != null && upper.usd > limits.maxUsd) warnings.push(`with every consultation it could exceed the mission budget ($${limits.maxUsd}); later stages would then be stopped`);
      if (limits.maxTokens != null && upper.tokens > limits.maxTokens) warnings.push(`with every consultation it could exceed the mission token budget (${limits.maxTokens})`);
      if (budgets.dailyUsd != null && today.costUsd + expected.usd > budgets.dailyUsd) warnings.push('the expected cost would exceed what is left of the daily budget');
      this.ledger.append('plan', { mission, requester: brief.requesterId, rootRequester: brief.rootRequester, allowed: true, expectedUsd: round(expected.usd), upperUsd: round(upper.usd) });
      return {
        allowed: true, mission, stages, consults,
        expected: { tokens: expected.tokens, costUsd: round(expected.usd) }, upperBound: { tokens: upper.tokens, costUsd: round(upper.usd) },
        budgets: { mission: limits, dailyLeftUsd: budgets.dailyUsd != null ? round(budgets.dailyUsd - today.costUsd) : null }, warnings,
        note: 'Estimates come from earlier runs in the ledger (or a default guess) at operator rates. Nothing was run.',
      };
    } catch (error) {
      this.ledger.append('plan', { mission, requester: brief.requesterId, rootRequester: brief.rootRequester, allowed: false, reason: String(error.message).slice(0, 300) });
      return { allowed: false, mission, reason: error.message };
    }
  }

  /** A bot asks Graham directly (e.g. "buy the £99 doorbell?"). Returns the pending approval. */
  requestApproval({ title, summary, runId, requester }) {
    if (!this.approvals) fail('approvals are not enabled');
    if (runId !== undefined && (typeof runId !== 'string' || !/^run-[a-z0-9-]+$/.test(runId))) fail('invalid run id');
    return this.approvals.create({ title, summary, runId: runId || null, requester });
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
    const rotateReason = memory.needsRotation(agent, role, this.now());
    if (rotateReason) await this.rotateMemory(agent, { reason: rotateReason, by: 'flux:policy' });
    const choice = chooseProfile(role, this.policy.modelProfiles, p => this.ledger.profileStats(agent.roleId, p));
    const profile = this.policy.modelProfiles[choice.id];
    const knowledge = (role.knowledge || []).flatMap(pack => this.knowledge.get(pack) || []);
    const ticket = randomBytes(18).toString('base64url');
    const consultRefs = new Set();
    const holder = { agentId: agent.id, roleId: agent.roleId, brief: { ...brief, chain: brief.chain }, consultRefs, consultTexts: [], consultRuns: 0, fetches: 0 };
    this.tickets.set(ticket, holder);
    const prompt = contract.buildPrompt({ agent, role, brief, knowledge, consults: role.consults || [], ticket, memoryRules: agent.memory === 'continuous' ? memory.memoryRules(role) : null });
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
    const kept = { ...finding, sources: grounding.kept };
    if (quality.shouldGrade({ quality: this.policy.quality, gradedSoFar: this.ledger.gradeCount(agent.roleId, choice.id), runId: brief.runId, capabilityId: agent.roleId })) {
      const cited = [
        ...knowledge.filter(k => grounding.kept.some(s => s.split('#')[0] === k.ref)).map(k => `[${k.ref}]\n${k.text}`),
        ...brief.inputs.filter(i => grounding.kept.some(s => s === `input:${i.ref}` || s === i.ref)).map(i => `[input:${i.ref}]\n${i.text}`),
        ...holder.consultTexts,
      ].join('\n\n').slice(0, 12000);
      const job = this.grade({ brief, agent, profileId: choice.id, finding: kept, evidence: (out.evidence || '').slice(0, this.policy.quality.maxEvidenceChars ?? 12000), cited })
        .catch(error => console.error('grading failed:', error.message))
        .finally(() => this.grading.delete(job));
      this.grading.add(job);
    }
    return { summary: finding.summary, sources: grounding.kept };
  }

  /** Background quality grade for one accepted finding (never blocks or changes the mission result). */
  async grade({ brief, agent, profileId, finding, evidence, cited }) {
    const graderId = this.policy.quality?.grader || 'quality.grader';
    const graderRole = this.policy.roles[graderId];
    if (!graderRole) return;
    const today = this.ledger.today(), budgets = this.policy.budgets || {};
    if ((budgets.dailyUsd != null && today.costUsd >= budgets.dailyUsd) || (budgets.dailyTokens != null && today.tokens >= budgets.dailyTokens)) return;
    const gradeBrief = { runId: brief.runId, root: { runId: brief.root.runId }, scopeId: this.policy.scopeId, workflowKey: `grade:${brief.runId}`, requesterId: 'flux:quality', events: [] };
    const grader = this.registry.acquire(graderId, gradeBrief);
    const graderProfileId = chooseProfile(graderRole, this.policy.modelProfiles, p => this.ledger.profileStats(graderId, p)).id;
    const graderProfile = this.policy.modelProfiles[graderProfileId];
    const started = this.now();
    try {
      const out = await this.registry.call(grader, { prompt: quality.gradePrompt({ objective: brief.objective, finding, evidence, cited }), profile: graderProfile, ticket: null });
      const cost = costOf(out.usage, graderProfile, out.hermesCostUsd);
      this.registry.account(grader, out.usage.total, cost.usd);
      const grade = quality.parseGrade(out.text);
      this.ledger.append('step', { runId: brief.runId, rootRunId: brief.root.runId, mission: brief.mission, capabilityId: graderId, kind: 'grader', agentId: grader.id, profile: graderProfileId, model: graderProfile.model, rootRequester: brief.rootRequester, outcome: grade ? 'ok' : 'rejected', durationMs: out.durationMs ?? this.now() - started, tokens: out.usage, costUsd: cost.usd, costBasis: cost.basis });
      if (!grade) return;
      const pass = grade.score >= (this.policy.quality.passScore ?? 0.6);
      this.ledger.append('grade', { runId: brief.runId, capabilityId: agent.roleId, agentId: agent.id, profile: profileId, score: grade.score, pass, answersObjective: grade.answersObjective, supportedBySources: grade.supportedBySources, issues: grade.issues, graderProfile: graderProfileId });
    } finally {
      this.registry.release(grader, gradeBrief);
    }
  }

  /** Wait for background grading (tests and shutdown). */
  async settle() { while (this.grading.size) await Promise.allSettled([...this.grading]); }

  // ---------- memory governance ----------

  memoryStatus() {
    return this.registry.live().filter(a => a.memory === 'continuous').map(a => ({
      agentId: a.id, roleId: a.roleId, lifecycle: a.lifecycle, hasSession: Boolean(a.hermesSession),
      callsSinceRotation: a.callsSinceRotation || 0, memorySince: a.memorySince ? new Date(a.memorySince).toISOString() : null,
      digest: a.memoryDigest || null, rules: memory.memoryRules(this.policy.roles[a.roleId] || {}), policy: this.policy.roles[a.roleId]?.memoryPolicy || null,
    }));
  }

  /** Replace the agent's session with a scrubbed digest it writes itself (optionally excluding a topic). */
  async rotateMemory(agent, { reason, by, exclude } = {}) {
    const role = this.policy.roles[agent.roleId];
    if (agent.memory !== 'continuous') fail(`${agent.id} has no continuous memory`);
    let digest = agent.memoryDigest || null, redactions = 0;
    if (agent.hermesSession) {
      const profile = this.policy.modelProfiles[(role.models || [])[0]];
      const started = this.now();
      const out = await this.registry.call(agent, { prompt: memory.digestPrompt({ role, exclude, now: this.now() }), profile, ticket: null, housekeeping: true });
      const cost = costOf(out.usage, profile, out.hermesCostUsd);
      this.registry.account(agent, out.usage.total, cost.usd);
      this.ledger.append('step', { runId: null, capabilityId: `${agent.roleId}:memory`, kind: 'memory', agentId: agent.id, profile: (role.models || [])[0], rootRequester: by, outcome: 'ok', durationMs: out.durationMs ?? this.now() - started, tokens: out.usage, costUsd: cost.usd, costBasis: cost.basis });
      ({ text: digest, redactions } = memory.scrub(out.text));
    } else if (exclude && digest) {
      digest = null; // a carried digest cannot be filtered without a model call; drop it rather than keep the topic
    }
    this.registry.replaceMemory(agent, digest);
    this.ledger.append('memory', { event: exclude ? 'forgot-topic' : 'rotated', agentId: agent.id, reason, by, topicHash: exclude ? createHash('sha256').update(exclude.toLowerCase()).digest('hex').slice(0, 16) : undefined, digestChars: digest ? digest.length : 0, redactions });
    return { agentId: agent.id, digestChars: digest ? digest.length : 0, redactions };
  }

  async forget(agentId, { topic, by }) {
    const agent = this.registry.agents.get(agentId);
    if (!agent) fail('no such live agent');
    if (agent.users) fail('agent is busy; try again when it is idle');
    if (topic) return this.rotateMemory(agent, { reason: 'forget requested', by, exclude: String(topic).slice(0, 200) });
    this.registry.replaceMemory(agent, null);
    this.ledger.append('memory', { event: 'forgot-all', agentId, by });
    return { agentId, forgotten: 'all' };
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

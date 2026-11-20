'use strict';
// Flux agent registry: the identity and lifecycle of every logical agent, independent of the processes
// that serve its calls. A logical agent is reused by share key; each call is a separate Hermes run.
//
//   task        created for one mission step, retired when its last caller releases it
//   ttl         shared; idles after use and is retired when idle for ttlSeconds (or at maxLifetimeSeconds)
//   persistent  standing identity (survives restarts); no compute while idle; memory: continuous resumes
//               one Hermes session so it remembers earlier missions
//
// A ttl role can declare `promote`: once enough distinct requesters use the same agent inside a window it
// becomes persistent, i.e. the runtime keeps a specialist that has proved useful to many agents.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

class Semaphore {
  constructor(size) { this.free = size; this.waiting = []; }
  async take(timeoutMs) {
    if (this.free > 0) { this.free--; return; }
    await new Promise((resolve, reject) => {
      const waiter = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter(w => w !== waiter);
        reject(new Error('Flux: agent capacity exhausted (all call slots busy)'));
      }, timeoutMs);
      this.waiting.push(waiter);
    });
  }
  give() { const next = this.waiting.shift(); if (next) next(); else this.free++; }
}

const ZERO = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 });

function subtract(now, base) {
  const out = ZERO();
  for (const k of Object.keys(out)) out[k] = Math.max(0, (now?.[k] || 0) - (base?.[k] || 0));
  return out;
}

class Registry {
  constructor({ policy, file, ledger, runner, now = () => Date.now(), slotWaitMs = 180000 }) {
    Object.assign(this, { policy, file, ledger, runner, now, slotWaitMs });
    this.agents = new Map();
    this.frozen = false;
    this.chains = new Map();
    this.slots = new Semaphore(policy.budgets?.maxConcurrentAgentCalls ?? 4);
    this.load();
  }

  role(roleId) {
    const role = this.policy.roles?.[roleId];
    if (!role) throw new Error(`Flux: no operator role for ${roleId}`);
    return role;
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.frozen = Boolean(state.frozen);
    for (const agent of state.agents || []) {
      agent.users = 0;
      if (agent.state === 'active') agent.state = 'idle';
      this.agents.set(agent.id, agent);
      // A task agent cannot outlive its task; a restart ended it.
      if (agent.lifecycle === 'task') this.retire(agent, 'host restarted during task');
    }
    this.save();
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ frozen: this.frozen, agents: [...this.agents.values()] }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  record(brief, event, agent, extra = {}) {
    const entry = { event, agentId: agent.id, roleId: agent.roleId, lifecycle: agent.lifecycle, ...extra };
    brief?.events?.push({ kind: event, agentId: agent.id, capabilityId: agent.roleId });
    this.ledger.append('agent', { ...entry, runId: brief?.runId, rootRunId: brief?.root?.runId });
  }

  live() { return [...this.agents.values()].filter(a => a.state !== 'retired'); }

  shareKeyFor(roleId, role, brief) {
    return (role.share || 'workflow') === 'scope' ? `scope:${brief.scopeId}:${roleId}` : `workflow:${brief.workflowKey}:${roleId}`;
  }

  /** The live agent a call would reuse, without side effects (used by dry runs too). */
  findReusable(roleId, brief) {
    const role = this.role(roleId);
    const key = this.shareKeyFor(roleId, role, brief);
    return this.live().find(a => a.shareKey === key && a.policyRevision === this.policy.policyRevision
      && (a.users < (role.maxConcurrent ?? 2) || a.memory === 'continuous')) || null;
  }

  acquire(roleId, brief) {
    if (this.frozen) throw new Error('Flux: runtime frozen by operator');
    const role = this.role(roleId);
    const share = role.share || 'workflow';
    const key = this.shareKeyFor(roleId, role, brief);
    const revision = this.policy.policyRevision;
    const now = this.now();
    let agent = this.findReusable(roleId, brief);
    if (agent) {
      this.record(brief, 'agent-reused', agent, { requester: brief.requesterId });
    } else {
      if (this.live().length >= (this.policy.budgets?.maxLiveAgents ?? 12)) throw new Error('Flux: live agent limit reached');
      agent = {
        id: `${roleId}#${randomBytes(3).toString('hex')}`, roleId, title: role.title,
        lifecycle: role.lifecycle || 'task', share, memory: role.memory || 'fresh', shareKey: key,
        policyRevision: revision, state: 'idle', createdAt: now, lastUsedAt: now, expiresAt: null,
        users: 0, calls: 0, tokens: 0, costUsd: 0, requesters: [], hermesSession: null, usageBase: null,
        toolsets: role.toolsets || [], knowledge: role.knowledge || [], consults: role.consults || [],
      };
      this.agents.set(agent.id, agent);
      this.record(brief, 'agent-spawned', agent, { requester: brief.requesterId, share });
    }
    agent.users++;
    agent.state = 'active';
    agent.expiresAt = null;
    agent.lastUsedAt = now;
    this.noteRequester(agent, role, brief);
    this.save();
    return agent;
  }

  noteRequester(agent, role, brief) {
    const now = this.now();
    agent.requesters = [...agent.requesters, { id: brief.requesterId, at: now }].slice(-50);
    const rule = role.promote;
    if (!rule || agent.lifecycle !== role.lifecycle || agent.lifecycle === rule.to) return;
    const recent = new Set(agent.requesters.filter(r => now - r.at <= rule.withinSeconds * 1000).map(r => r.id));
    if (recent.size >= rule.distinctRequesters) {
      const from = agent.lifecycle;
      agent.lifecycle = rule.to;
      agent.promotedAt = now;
      this.record(brief, 'agent-promoted', agent, { from, to: rule.to, distinctRequesters: recent.size });
    }
  }

  release(agent, brief) {
    agent.users = Math.max(0, agent.users - 1);
    agent.lastUsedAt = this.now();
    if (agent.users) return this.save();
    if (agent.lifecycle === 'task') return this.retire(agent, 'task complete', brief);
    agent.state = 'idle';
    agent.expiresAt = agent.lifecycle === 'ttl' ? agent.lastUsedAt + this.role(agent.roleId).ttlSeconds * 1000 : null;
    this.record(brief, agent.lifecycle === 'persistent' ? 'agent-standby' : 'agent-idle', agent,
      agent.expiresAt ? { expiresAt: new Date(agent.expiresAt).toISOString() } : {});
    this.save();
  }

  retire(agent, reason, brief) {
    agent.state = 'retired';
    agent.users = 0;
    this.agents.delete(agent.id);
    this.chains.delete(agent.id);
    if (agent.hermesSession) this.runner.discard(agent.hermesSession).catch(() => {});
    this.record(brief, 'agent-retired', agent, { reason, calls: agent.calls, tokens: agent.tokens, costUsd: agent.costUsd });
    this.save();
  }

  /** Retire idle agents whose TTL or lifetime has passed, or that belong to an older policy revision. */
  reap() {
    const now = this.now();
    for (const agent of this.live()) {
      if (agent.users) continue;
      const role = this.policy.roles?.[agent.roleId];
      if (!role) this.retire(agent, 'role removed by operator');
      else if (agent.policyRevision !== this.policy.policyRevision) this.retire(agent, 'policy revision changed');
      else if (agent.lifecycle === 'ttl' && agent.expiresAt && agent.expiresAt <= now) this.retire(agent, 'idle TTL expired');
      else if (agent.lifecycle !== 'persistent' && role.maxLifetimeSeconds && now - agent.createdAt >= role.maxLifetimeSeconds * 1000) this.retire(agent, 'max lifetime reached');
    }
  }

  async call(agent, job) {
    const role = this.role(agent.roleId);
    const run = async () => {
      await this.slots.take(this.slotWaitMs);
      try {
        const resume = agent.memory === 'continuous' ? agent.hermesSession : null;
        const out = await this.runner.run({ role, roleId: agent.roleId, agentId: agent.id, profile: job.profile, prompt: job.prompt, resume, ticket: job.ticket });
        let usage;
        if (out.cumulative) {
          const sameSession = agent.memory === 'continuous' && agent.hermesSession === out.sessionId;
          usage = subtract(out.cumulative, sameSession ? agent.usageBase : null);
        } else usage = { ...ZERO(), ...out.tokens };
        usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        if (agent.memory === 'continuous') {
          if (!agent.hermesSession || agent.hermesSession !== out.sessionId) agent.memorySince = this.now();
          agent.hermesSession = out.sessionId;
          agent.usageBase = out.cumulative || null;
          if (!job.housekeeping) agent.callsSinceRotation = (agent.callsSinceRotation || 0) + 1;
        } else if (out.sessionId && !role.keepTranscript) {
          this.runner.discard(out.sessionId).catch(() => {});
        }
        if (!job.housekeeping) agent.calls++;
        this.save();
        return { ...out, usage };
      } finally {
        this.slots.give();
      }
    };
    if (agent.memory !== 'continuous') return run();
    // One Hermes session cannot take two turns at once: serialise calls to a continuous-memory agent.
    const turn = (this.chains.get(agent.id) || Promise.resolve()).catch(() => {}).then(run);
    this.chains.set(agent.id, turn);
    return turn;
  }

  /** Drop the agent's Hermes session (its working memory) and optionally carry a digest forward. */
  replaceMemory(agent, digest) {
    if (agent.hermesSession) this.runner.discard(agent.hermesSession).catch(() => {});
    agent.hermesSession = null;
    agent.usageBase = null;
    agent.memoryDigest = digest || null;
    agent.memorySince = digest ? this.now() : null;
    agent.callsSinceRotation = 0;
    this.save();
  }

  account(agent, tokens, costUsd) {
    agent.tokens += tokens;
    agent.costUsd = Math.round((agent.costUsd + costUsd) * 1e8) / 1e8;
    this.save();
  }

  setFrozen(frozen) {
    this.frozen = frozen;
    if (frozen) for (const agent of this.live()) if (!agent.users && agent.lifecycle !== 'persistent') this.retire(agent, 'runtime frozen');
    this.save();
  }

  snapshot() {
    const now = this.now();
    return this.live().map(a => ({
      id: a.id, roleId: a.roleId, title: a.title, lifecycle: a.lifecycle, memory: a.memory, share: a.share,
      state: a.state, users: a.users, calls: a.calls, tokens: a.tokens, costUsd: a.costUsd,
      createdAt: new Date(a.createdAt).toISOString(), lastUsedAt: new Date(a.lastUsedAt).toISOString(),
      ttlRemainingSeconds: a.expiresAt ? Math.max(0, Math.round((a.expiresAt - now) / 1000)) : null,
      distinctRequesters: new Set(a.requesters.map(r => r.id)).size, promotedAt: a.promotedAt ? new Date(a.promotedAt).toISOString() : null,
      toolsets: a.toolsets, knowledge: a.knowledge, consults: a.consults, hasMemory: Boolean(a.hermesSession),
      memoryDigest: Boolean(a.memoryDigest), callsSinceRotation: a.callsSinceRotation || 0,
      memorySince: a.memorySince ? new Date(a.memorySince).toISOString() : null,
    }));
  }
}

module.exports = { Registry, Semaphore };

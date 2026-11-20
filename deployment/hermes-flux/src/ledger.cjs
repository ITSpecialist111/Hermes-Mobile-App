'use strict';
// Flux Ledger: append-only JSONL where every record carries the SHA-256 of the previous one, so an edited,
// reordered or deleted line breaks the chain (`verify`). It is the source of truth for token use, shadow
// cost, outcomes and the observations the model router learns from.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const GENESIS = '0'.repeat(64);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const digest = (prev, body) => createHash('sha256').update(`${prev}\n${stable(body)}`).digest('hex');

function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

class Ledger {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.records = [];
    this.head = GENESIS;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        this.records.push(record);
        this.head = record.hash;
      }
    }
  }

  append(type, data) {
    const body = { seq: this.records.length + 1, ts: new Date(this.now()).toISOString(), type, ...data };
    const record = { ...body, prev: this.head, hash: digest(this.head, body) };
    fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    this.records.push(record);
    this.head = record.hash;
    return record;
  }

  /** Re-reads the file so tampering on disk is detected, not just in memory. */
  verify() {
    let prev = GENESIS;
    let count = 0;
    const lines = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8').split('\n').filter(l => l.trim()) : [];
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { return { ok: false, at: count + 1, reason: 'unreadable line' }; }
      const { prev: claimed, hash, ...body } = record;
      if (claimed !== prev || digest(prev, body) !== hash || body.seq !== count + 1) {
        return { ok: false, at: count + 1, reason: 'chain broken' };
      }
      prev = hash;
      count++;
    }
    return { ok: true, count, head: prev };
  }

  since(ms) {
    return this.records.filter(r => Date.parse(r.ts) >= ms);
  }

  today() {
    return this.totals(this.since(startOfLocalDay(this.now())));
  }

  totals(records) {
    const out = { tokens: 0, costUsd: 0, steps: 0, runs: 0, denied: 0, failed: 0, spawned: 0, retired: 0, promoted: 0, modelCalls: 0 };
    for (const r of records) {
      if (r.type === 'step') {
        out.steps++;
        out.tokens += r.tokens?.total || 0;
        out.costUsd += r.costUsd || 0;
        if (r.kind === 'specialist') out.modelCalls++;
      } else if (r.type === 'run') {
        out.runs++;
        if (r.outcome === 'denied') out.denied++;
        if (r.outcome === 'error') out.failed++;
      } else if (r.type === 'agent') {
        if (r.event === 'agent-spawned') out.spawned++;
        if (r.event === 'agent-retired') out.retired++;
        if (r.event === 'agent-promoted') out.promoted++;
      }
    }
    out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
    return out;
  }

  summary(days = 1) {
    const records = this.since(startOfLocalDay(this.now()) - (days - 1) * 86400000);
    const by = key => {
      const groups = {};
      for (const r of records.filter(x => x.type === 'step' && x[key])) {
        const g = groups[r[key]] ||= { steps: 0, tokens: 0, costUsd: 0, ok: 0 };
        g.steps++;
        g.tokens += r.tokens?.total || 0;
        g.costUsd = Math.round((g.costUsd + (r.costUsd || 0)) * 1e6) / 1e6;
        if (r.outcome === 'ok') g.ok++;
      }
      return groups;
    };
    return { days, totals: this.totals(records), byCapability: by('capabilityId'), byProfile: by('profile'), byRequester: by('rootRequester'), quality: this.quality() };
  }

  /** Router observations for one capability and model profile. A graded step counts as a success only if it passed. */
  profileStats(capabilityId, profileId) {
    const grades = this.gradesFor(capabilityId);
    let n = 0, ok = 0, cost = 0, ms = 0, graded = 0, scoreSum = 0;
    for (const r of this.records) {
      if (r.type !== 'step' || r.capabilityId !== capabilityId || r.profile !== profileId) continue;
      n++;
      const grade = grades.get(r.runId);
      if (grade) { graded++; scoreSum += grade.score; }
      if (r.outcome === 'ok' && (!grade || grade.pass)) ok++;
      cost += r.costUsd || 0;
      ms += r.durationMs || 0;
    }
    return { n, ok, avgCostUsd: n ? cost / n : 0, avgMs: n ? ms / n : 0, graded, avgScore: graded ? scoreSum / graded : null };
  }

  gradesFor(capabilityId) {
    const out = new Map();
    for (const r of this.records) if (r.type === 'grade' && r.capabilityId === capabilityId) out.set(r.runId, r);
    return out;
  }

  gradeCount(capabilityId, profileId) {
    return this.records.filter(r => r.type === 'grade' && r.capabilityId === capabilityId && r.profile === profileId).length;
  }

  /** Dry-run estimate from history: mean tokens and cost of earlier steps for this capability (and profile, if seen). */
  estimate(capabilityId, profileId) {
    const steps = this.records.filter(r => r.type === 'step' && r.capabilityId === capabilityId && r.outcome !== 'error');
    const exact = steps.filter(r => r.profile === profileId);
    const sample = exact.length ? exact : steps;
    if (!sample.length) return null;
    const mean = f => sample.reduce((s, r) => s + f(r), 0) / sample.length;
    return { tokens: Math.round(mean(r => r.tokens?.total || 0)), usd: mean(r => r.costUsd || 0), samples: sample.length, basis: exact.length ? 'same profile' : 'other profiles' };
  }

  quality() {
    const out = {};
    for (const r of this.records.filter(x => x.type === 'grade')) {
      const g = out[r.profile] ||= { graded: 0, passed: 0, avgScore: 0 };
      g.avgScore = (g.avgScore * g.graded + r.score) / (g.graded + 1);
      g.graded++;
      if (r.pass) g.passed++;
    }
    for (const g of Object.values(out)) g.avgScore = Math.round(g.avgScore * 100) / 100;
    return out;
  }
}

module.exports = { Ledger, stable, GENESIS };

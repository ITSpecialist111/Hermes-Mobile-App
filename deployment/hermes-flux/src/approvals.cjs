'use strict';
// Human approval queue. A finding that needs Graham's decision (human-review by default), or an explicit
// bot request, becomes an approval: shown on the Live Map and as an Allow/Deny notification by the
// Hermes Mobile app. Details (title, summary) live in approvals.json on the host; the hash-chained
// ledger records only who asked, what was decided, by whom and when.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

class Approvals {
  constructor({ file, ledger, now = () => Date.now() }) {
    Object.assign(this, { file, ledger, now });
    this.items = [];
    if (file && fs.existsSync(file)) this.items = JSON.parse(fs.readFileSync(file, 'utf8')).items || [];
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    // Keep pending items and the last 200 decided ones.
    const decided = this.items.filter(i => i.status !== 'pending').slice(-200);
    this.items = [...this.items.filter(i => i.status === 'pending'), ...decided].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  create({ title, summary, runId = null, mission = null, capabilityId = null, agentId = null, requester, sources = [], ttlDays = 7 }) {
    if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('Flux: approval title must be 1-200 characters');
    if (typeof summary !== 'string' || !summary.trim()) throw new Error('Flux: approval needs a summary');
    const now = this.now();
    const item = {
      id: `apr-${randomBytes(4).toString('hex')}`, status: 'pending', title: title.trim(), summary: summary.trim().slice(0, 2000),
      runId, mission, capabilityId, agentId, requester, sources: sources.slice(0, 10),
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlDays * 86400000).toISOString(),
    };
    this.items.push(item);
    this.ledger.append('approval', { event: 'requested', approvalId: item.id, runId, mission, capabilityId, requester });
    this.save();
    return item;
  }

  decide(id, { decision, by, note }) {
    if (!['approved', 'denied'].includes(decision)) throw new Error('Flux: decision must be approved or denied');
    this.expire();
    const item = this.items.find(i => i.id === id);
    if (!item) throw new Error('Flux: no such approval');
    if (item.status !== 'pending') throw new Error(`Flux: approval already ${item.status}`);
    Object.assign(item, { status: decision, decidedBy: by, decidedAt: new Date(this.now()).toISOString(), note: note ? String(note).slice(0, 500) : undefined });
    this.ledger.append('approval', { event: 'decided', approvalId: id, decision, by, hasNote: Boolean(note), runId: item.runId });
    this.save();
    return item;
  }

  expire() {
    const now = this.now();
    let changed = false;
    for (const item of this.items) {
      if (item.status === 'pending' && Date.parse(item.expiresAt) <= now) {
        item.status = 'expired';
        this.ledger.append('approval', { event: 'expired', approvalId: item.id, runId: item.runId });
        changed = true;
      }
    }
    if (changed) this.save();
  }

  list({ status, requester } = {}) {
    this.expire();
    return this.items.filter(i => (!status || i.status === status) && (!requester || i.requester === requester)).slice().reverse();
  }

  get(id) { return this.items.find(i => i.id === id) || null; }
}

module.exports = { Approvals };

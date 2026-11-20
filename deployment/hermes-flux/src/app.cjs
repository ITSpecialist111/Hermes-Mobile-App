'use strict';
// Builds a Flux runtime from a directory laid out like a standalone Flux core:
//   domain/manifest.json, domain/packs.json      data: missions and capabilities
//   operator/policy.json, operator/bindings.cjs  trusted: grants, roles, budgets, model profiles, adapters
//   operator/knowledge/<pack>/*.md                approved knowledge packs
const path = require('node:path');
const fs = require('node:fs');
const { FluxEngine } = require('./engine.cjs');
const { Registry } = require('./registry.cjs');
const { Ledger } = require('./ledger.cjs');
const { Approvals } = require('./approvals.cjs');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function createFlux({ appDir = path.join(__dirname, '..'), stateDir, runner, policy, fetchImpl, now = () => Date.now() }) {
  const manifest = readJson(path.join(appDir, 'domain', 'manifest.json'));
  const packs = readJson(path.join(appDir, 'domain', 'packs.json'));
  policy ||= readJson(path.join(appDir, 'operator', 'policy.json'));
  const createBindings = require(path.join(appDir, 'operator', 'bindings.cjs'));
  const ledger = new Ledger(path.join(stateDir, 'ledger.jsonl'), { now });
  const registry = new Registry({ policy, file: path.join(stateDir, 'registry.json'), ledger, runner, now });
  const approvals = new Approvals({ file: path.join(stateDir, 'approvals.json'), ledger, now });
  const engine = new FluxEngine({ manifest, packs, policy, createBindings, registry, ledger, approvals, knowledgeDir: path.join(appDir, 'operator', 'knowledge'), fetchImpl, now });
  return { engine, registry, ledger, approvals, policy, manifest };
}

module.exports = { createFlux };

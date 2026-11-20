'use strict';

const { randomUUID } = require('node:crypto');
const VERSION = require('./package.json').version;

function fail(message) { throw new Error(`Flux: ${message}`); }

function record(value, label) {
  if (!value || typeof value !== 'object' ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail(`invalid ${label}`);
  return value;
}

function shape(value, keys, label) {
  record(value, label);
  if (Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail(`invalid ${label} fields`);
}

function id(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) ||
      ['constructor', 'prototype', '__proto__'].includes(value)) fail(`invalid ${label}`);
  return value;
}

function text(value, limit, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) fail(`invalid ${label}`);
  return value;
}

function ids(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > 64) fail(`invalid ${label}`);
  const items = Array.from(value, item => id(item, label));
  if (new Set(items).size !== items.length) fail(`duplicate ${label}`);
  return items;
}

function compile(manifest, packs) {
  shape(manifest, ['schemaVersion', 'id', 'packIds', 'missions'], 'core manifest');
  if (manifest.schemaVersion !== 1) fail('unsupported manifest schema');
  const coreId = id(manifest.id, 'core id'), selected = new Set(ids(manifest.packIds, 'pack id'));
  if (!Array.isArray(packs) || packs.length > 64) fail('invalid packs');
  const catalogue = new Map(), packIds = new Set(), missions = new Map();
  for (const pack of packs) {
    shape(pack, ['id', 'capabilities'], 'pack');
    const key = id(pack.id, 'pack id');
    if (packIds.has(key)) fail(`duplicate pack: ${key}`);
    packIds.add(key);
    if (!selected.has(key)) continue;
    if (!Array.isArray(pack.capabilities) || !pack.capabilities.length || pack.capabilities.length > 64) fail('invalid capabilities');
    for (const c of pack.capabilities) {
      shape(c, ['id', 'kind', 'connection', 'description'], 'capability');
      id(c.id, 'capability id'); id(c.connection, 'connection');
      if (!['tool', 'service', 'specialist'].includes(c.kind)) fail('invalid capability kind');
      text(c.description, 512, 'description');
      if (catalogue.has(c.id)) fail(`ambiguous capability: ${c.id}`);
      catalogue.set(c.id, Object.freeze({ ...c }));
    }
  }
  for (const key of selected) if (!packIds.has(key)) fail(`missing pack: ${key}`);
  const entries = Object.entries(record(manifest.missions, 'missions'));
  if (!entries.length || entries.length > 64) fail('invalid mission count');
  for (const [key, values] of entries) {
    const caps = ids(values, 'mission capability');
    for (const cap of caps) if (!catalogue.has(cap)) fail(`unknown mission capability: ${cap}`);
    missions.set(id(key, 'mission id'), caps);
  }
  return { coreId, catalogue, missions };
}

function validateDefinition(manifest, packs) { compile(manifest, packs); }

function resolver({ catalogue, missions }) {
  return (missionId, requested) => {
    const permitted = missions.get(id(missionId, 'mission id'));
    if (!permitted) fail(`unknown mission: ${missionId}`);
    return (requested === undefined ? permitted : ids(requested, 'requested capability')).map(k => {
      if (!permitted.includes(k)) fail(`capability denied: ${k}`);
      return catalogue.get(k);
    });
  };
}

function createCatalogue(manifest, packs) {
  return Object.freeze({ resolve: resolver(compile(manifest, packs)) });
}

function createCore({ manifest, packs, bindings, tenantId, scopeId }) {
  const definition = compile(manifest, packs), { coreId } = definition, resolve = resolver(definition);
  id(tenantId, 'tenant id'); id(scopeId, 'scope id');
  const connections = new Map(), leases = new Map();
  for (const [key, binding] of Object.entries(record(bindings, 'bindings'))) {
    id(key, 'connection'); record(binding, 'binding');
    const grants = new Set(ids(binding.capabilityIds, 'binding capability'));
    if (typeof binding.execute !== 'function' ||
        (binding.openSpecialist !== undefined && typeof binding.openSpecialist !== 'function')) fail(`invalid adapter: ${key}`);
    connections.set(key, { grants, execute: binding.execute.bind(binding), open: binding.openSpecialist?.bind(binding) });
  }
  function discover(missionId) {
    return resolve(missionId).filter(c => connections.get(c.connection)?.grants.has(c.id));
  }

  async function invoke(cap, conn, ctx, events) {
    const note = kind => events.push({ kind, capabilityId: cap.id });
    const input = Object.freeze({ ...ctx, capabilityId: cap.id });
    if (cap.kind !== 'specialist') {
      note(cap.kind === 'service' ? 'service-called' : 'tool-called');
      return conn.execute(input);
    }
    // Tenant and scope are fixed at core construction. Only overlapping requests in this workflow share a lease.
    const key = JSON.stringify([ctx.workflowId, cap.id]);
    let lease = leases.get(key);
    if (!lease) {
      const role = Object.freeze({ id: randomUUID(), purpose: cap.description });
      const ready = Promise.resolve().then(() => conn.open
        ? conn.open(Object.freeze({ ...input, role })) : { execute: conn.execute, close() {} });
      lease = { role, ready, users: 0 };
      leases.set(key, lease);
      note('specialist-created');
    } else note('specialist-reused');
    lease.users++;
    let session;
    try {
      session = await lease.ready;
      if (typeof session?.execute !== 'function' || typeof session?.close !== 'function') fail('invalid specialist session');
      return await session.execute(Object.freeze({ ...input, role: lease.role }));
    } finally {
      if (--lease.users === 0) {
        leases.delete(key);
        if (typeof session?.close === 'function') await session.close();
        note('specialist-released');
      }
    }
  }

  async function run(missionId, context, proposedCapabilities) {
    shape(context, ['workflowId', 'tenantId', 'scopeId'], 'execution context');
    if (context.tenantId !== tenantId || context.scopeId !== scopeId) fail('tenant or scope denied');
    const workflowId = id(context.workflowId, 'workflow id'), ctx = { tenantId, scopeId, workflowId };
    // Preflight the entire plan so a denied last step cannot trigger an earlier adapter.
    const steps = resolve(missionId, proposedCapabilities).map(cap => {
      const conn = connections.get(cap.connection);
      if (!conn?.grants.has(cap.id)) fail(`missing authorised binding: ${cap.id}`);
      return [cap, conn];
    });
    const events = [], findings = [];
    for (const [cap, conn] of steps) {
      const output = await invoke(cap, conn, ctx, events);
      const summary = text(output?.summary, 12000, 'finding summary');
      if (!Array.isArray(output.sources) || !output.sources.length || output.sources.length > 32) fail('uncited or oversized finding');
      const sources = Array.from(output.sources, s => text(s, 1024, 'source reference'));
      findings.push({ capabilityId: cap.id, summary, sources });
    }
    return { coreId, workflowId, runtimeVersion: VERSION, findings, events };
  }
  return Object.freeze({ run, discover });
}

module.exports = Object.freeze({ VERSION, validateDefinition, createCatalogue, createCore });

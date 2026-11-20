'use strict';
// Flux federation: another Flux core (a second Hermes host, an office core, Morgan) can run missions here
// with a signed capability grant, and this core can call theirs the same way.
//
//  Grant   issued by THIS host and signed with its Ed25519 key:
//          { v, grantId, issuer, peerId, peerKey (SPKI DER, base64url), missions, maxUsdPerDay, expiresAt }
//  Request signed by the PEER's private key over "<ts>\n<nonce>\n<sha256(body)>", sent with the grant;
//          rejected unless the grant verifies, is unexpired and unrevoked, the peer signature matches
//          the key inside the grant, the timestamp is within 5 minutes and the nonce is new.
//  Reply   signed by this host so the caller can prove which core produced the findings.
// The grant only narrows: missions must also exist here, and this host's budgets, freeze and policy apply.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } = require('node:crypto');

const b64u = buf => Buffer.from(buf).toString('base64url');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const SKEW_MS = 5 * 60 * 1000;

function generateKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: b64u(publicKey.export({ type: 'spki', format: 'der' })),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

const publicKeyFrom = encoded => createPublicKey({ key: Buffer.from(encoded, 'base64url'), format: 'der', type: 'spki' });
const keyId = encoded => sha256(encoded).slice(0, 16);

function loadOrCreateHostKey(dir) {
  const file = path.join(dir, 'federation-key.json');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(generateKeys(), null, 2), { mode: 0o600 });
  }
  const keys = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { publicKey: keys.publicKey, privateKey: createPrivateKey(keys.privateKeyPem), keyId: keyId(keys.publicKey) };
}

function issueGrant(hostKey, { issuer, peerId, peerKey, missions, days = 30, maxUsdPerDay = 1, now = Date.now() }) {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(peerId)) throw new Error('Flux: peer id must be lowercase letters, digits and dashes');
  publicKeyFrom(peerKey); // must parse
  if (!Array.isArray(missions) || !missions.length) throw new Error('Flux: a grant needs at least one mission');
  const payload = { v: 1, grantId: `grt-${randomBytes(4).toString('hex')}`, issuer, issuerKey: hostKey.keyId, peerId, peerKey, missions, maxUsdPerDay, expiresAt: new Date(now + days * 86400000).toISOString() };
  const body = b64u(JSON.stringify(payload));
  return { token: `${body}.${b64u(sign(null, Buffer.from(body), hostKey.privateKey))}`, grant: payload };
}

function verifyGrant(token, hostKey, { now = Date.now(), revoked = new Set() } = {}) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) throw new Error('Flux: malformed grant');
  const hostPublic = publicKeyFrom(hostKey.publicKey);
  if (!verify(null, Buffer.from(body), hostPublic, Buffer.from(signature, 'base64url'))) throw new Error('Flux: grant signature invalid');
  const grant = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (grant.v !== 1) throw new Error('Flux: unsupported grant version');
  if (Date.parse(grant.expiresAt) <= now) throw new Error('Flux: grant expired');
  if (revoked.has(grant.grantId)) throw new Error('Flux: grant revoked');
  return grant;
}

const requestMessage = (ts, nonce, body) => Buffer.from(`${ts}\n${nonce}\n${sha256(body)}`);

function signRequest(privateKey, body, now = Date.now()) {
  const ts = String(now), nonce = randomBytes(12).toString('hex');
  return { ts, nonce, signature: b64u(sign(null, requestMessage(ts, nonce, body), privateKey)) };
}

class FederationGate {
  constructor({ hostKey, file, now = () => Date.now() }) {
    Object.assign(this, { hostKey, file, now });
    this.nonces = new Map();
    this.state = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { issued: [], revoked: [] };
  }

  save() {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  issue(options) {
    const result = issueGrant(this.hostKey, { ...options, now: this.now() });
    const { grantId, peerId, missions, maxUsdPerDay, expiresAt } = result.grant;
    this.state.issued.push({ grantId, peerId, missions, maxUsdPerDay, expiresAt, issuedAt: new Date(this.now()).toISOString() });
    this.save();
    return result;
  }

  revoke(grantId) {
    if (!this.state.issued.some(g => g.grantId === grantId)) throw new Error('Flux: no such grant');
    if (!this.state.revoked.includes(grantId)) this.state.revoked.push(grantId);
    this.save();
  }

  /** Verifies grant + request signature + freshness; returns the grant. */
  check({ token, ts, nonce, signature, body }) {
    const now = this.now();
    const grant = verifyGrant(token, this.hostKey, { now, revoked: new Set(this.state.revoked) });
    if (!/^\d{10,16}$/.test(String(ts)) || Math.abs(now - Number(ts)) > SKEW_MS) throw new Error('Flux: request timestamp outside the allowed window');
    if (!/^[0-9a-f]{16,64}$/.test(String(nonce))) throw new Error('Flux: invalid nonce');
    for (const [n, at] of this.nonces) if (now - at > 2 * SKEW_MS) this.nonces.delete(n);
    if (this.nonces.has(nonce)) throw new Error('Flux: replayed request');
    if (!verify(null, requestMessage(ts, nonce, body), publicKeyFrom(grant.peerKey), Buffer.from(String(signature), 'base64url'))) {
      throw new Error('Flux: request signature does not match the grant');
    }
    this.nonces.set(nonce, now);
    return grant;
  }

  signReply(body) {
    return b64u(sign(null, Buffer.from(sha256(body)), this.hostKey.privateKey));
  }
}

/** Client: call a peer core's mission with a grant it issued to us. */
async function callPeer({ url, grant, privateKey, mission, objective, inputs = [], peerHostKey, fetchImpl = globalThis.fetch }) {
  const body = JSON.stringify({ mission, objective, inputs });
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const { ts, nonce, signature } = signRequest(key, body);
  const response = await fetchImpl(new URL('/federation/run', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Flux-Grant': grant, 'X-Flux-Timestamp': ts, 'X-Flux-Nonce': nonce, 'X-Flux-Signature': signature },
    body,
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  const text = await response.text();
  if (peerHostKey) {
    const ok = verify(null, Buffer.from(sha256(text)), publicKeyFrom(peerHostKey), Buffer.from(response.headers.get('x-flux-reply-signature') || '', 'base64url'));
    if (!ok) throw new Error('Flux: peer reply signature invalid');
  }
  const data = JSON.parse(text);
  if (!response.ok) throw new Error(data.error || `Flux: peer returned HTTP ${response.status}`);
  return data;
}

/**
 * Operator binding: serve a capability by running a mission on a peer core. Peer findings keep their
 * own sources and gain a provenance ref `flux-peer:<core>/<runId>/<capability>`.
 */
function createPeerBinding({ capabilityIds, url, grant, privateKey, mission, peerHostKey, objectiveFor, fetchImpl }) {
  return {
    capabilityIds,
    async execute(input) {
      const { objective, inputs } = objectiveFor(input);
      const result = await callPeer({ url, grant, privateKey, mission, objective, inputs, peerHostKey, fetchImpl });
      const findings = result.findings || [];
      if (!findings.length) throw new Error('Flux: peer returned no findings');
      return {
        summary: findings.map(f => `[${result.coreId}/${f.capabilityId}${f.disposition ? `, ${f.disposition}` : ''}] ${f.summary}`).join('\n\n').slice(0, 12000),
        sources: [...findings.map(f => `flux-peer:${result.coreId}/${result.runId}/${f.capabilityId}`), ...findings.flatMap(f => f.sources)].slice(0, 32),
      };
    },
  };
}

/**
 * Inbound federation: returns async (method, path, headers, bodyText) => { status, body, headers }.
 * GET /federation/info is public (core id and public key); POST /federation/run needs a grant.
 */
function createFederationHandler({ gate, engine, coreId, compact }) {
  return async (method, pathname, headers, bodyText) => {
    const reply = (status, data) => {
      const body = JSON.stringify(data);
      return { status, body, headers: { 'Content-Type': 'application/json', 'X-Flux-Core': coreId, 'X-Flux-Key': gate.hostKey.keyId, 'X-Flux-Reply-Signature': gate.signReply(body) } };
    };
    if (method === 'GET' && pathname === '/federation/info') return reply(200, { coreId, publicKey: gate.hostKey.publicKey, keyId: gate.hostKey.keyId });
    if (method !== 'POST' || pathname !== '/federation/run') return reply(404, { error: 'not found' });
    let grant;
    try {
      grant = gate.check({ token: headers['x-flux-grant'], ts: headers['x-flux-timestamp'], nonce: headers['x-flux-nonce'], signature: headers['x-flux-signature'], body: bodyText });
    } catch (error) {
      return reply(401, { error: error.message });
    }
    try {
      const request = JSON.parse(bodyText);
      const result = await engine.run({ mission: request.mission, objective: request.objective, inputs: request.inputs || [], requester: { kind: 'peer', id: grant.peerId, missions: grant.missions, maxUsdPerDay: grant.maxUsdPerDay } });
      return reply(200, { ...compact(result), coreId, grantId: grant.grantId });
    } catch (error) {
      return reply(403, { error: error.message, grantId: grant.grantId });
    }
  };
}

module.exports = { generateKeys, loadOrCreateHostKey, issueGrant, verifyGrant, signRequest, FederationGate, callPeer, createPeerBinding, createFederationHandler, keyId, sha256 };

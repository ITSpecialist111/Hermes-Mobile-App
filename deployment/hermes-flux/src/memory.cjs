'use strict';
// Memory governance for continuous-memory (persistent) agents.
//  - Rules: the role's memoryPolicy.rules are part of its contract (what it may keep).
//  - Rotation: after memoryPolicy.maxCalls calls, or when the memory is older than retainDays, the agent
//    writes a dated digest of what it needs to keep; the digest is scrubbed of personal details, the old
//    Hermes session is deleted and the next call starts fresh with the digest.
//  - Forget: drop all memory, or rotate with one topic excluded. The ledger records that it happened
//    (and a hash of the topic), never the memory itself.

const DEFAULT_RULES = 'Keep decisions, options considered, constraints, open questions and who must approve what. Do not keep personal details of private individuals (names, contact details, addresses, message contents, account or card numbers).';

function memoryRules(role) {
  return role.memoryPolicy?.rules || DEFAULT_RULES;
}

function needsRotation(agent, role, now) {
  if (agent.memory !== 'continuous' || !agent.hermesSession) return null;
  const policy = role.memoryPolicy || {};
  if (policy.maxCalls && (agent.callsSinceRotation || 0) >= policy.maxCalls) return `reached ${policy.maxCalls} calls`;
  if (policy.retainDays && agent.memorySince && now - agent.memorySince >= policy.retainDays * 86400000) return `older than ${policy.retainDays} days`;
  return null;
}

function digestPrompt({ role, exclude, now }) {
  const today = new Date(now).toISOString().slice(0, 10);
  const retain = role.memoryPolicy?.retainDays;
  return [
    'FLUX MEMORY DIGEST REQUEST (issued by the Flux control plane; authoritative)',
    'Your conversation history is about to be replaced by a digest that you write now. Write what you need to keep doing your job.',
    `Memory rules: ${memoryRules(role)}`,
    `Today is ${today}. Date every item (YYYY-MM-DD).${retain ? ` Drop items older than ${retain} days unless they are still open.` : ''}`,
    exclude ? `Forget everything about this topic and leave no trace of it, not even that it was removed: "${exclude}"` : '',
    'Output ONLY the digest as dated bullet points, at most 3000 characters. No JSON.',
  ].filter(Boolean).join('\n');
}

const PATTERNS = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  [/(?:\+44\s?7\d{3}|\b07\d{3})\s?\d{3}\s?\d{3}\b/g, '[phone]'],
  [/\b\d(?: ?\d){9,}\b/g, '[number]'],
  [/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g, '[postcode]'],
];

function scrub(text) {
  let out = String(text || '').trim().slice(0, 3000);
  let redactions = 0;
  for (const [pattern, label] of PATTERNS) out = out.replace(pattern, () => { redactions++; return label; });
  return { text: out, redactions };
}

module.exports = { memoryRules, needsRotation, digestPrompt, scrub, DEFAULT_RULES };

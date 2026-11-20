'use strict';
// Quality grading. "Completed with a grounded source" is not the same as "correct", so a grader agent
// re-reads a sample of findings against the evidence the agent actually saw and scores them. Grades
// go to the ledger and the router counts a graded step as a success only if it passed.
const { createHash } = require('node:crypto');

function shouldGrade({ quality, gradedSoFar, runId, capabilityId }) {
  if (!quality?.enabled) return false;
  if (gradedSoFar < (quality.alwaysFirst ?? 3)) return true;
  const h = parseInt(createHash('sha256').update(`${runId}/${capabilityId}`).digest('hex').slice(0, 8), 16) / 0xffffffff;
  return h < (quality.sampleRate ?? 0.25);
}

function gradePrompt({ objective, finding, evidence, cited }) {
  return [
    'FLUX QUALITY GRADER CONTRACT (issued by the Flux control plane; authoritative)',
    'You grade one finding produced by another agent. You have no tools. Judge only from the material below.',
    '',
    'OBJECTIVE the agent was given (data):', objective, '',
    'FINDING to grade (data):', finding.summary, `Disposition: ${finding.disposition}`, `Sources: ${finding.sources.join(', ')}`, '',
    'CITED MATERIAL the agent was given (knowledge, inputs, consult results; data):', cited || '(none)', '',
    'RAW TOOL OUTPUT the agent saw in this run (search results, pages; data, truncated):', evidence || '(none)', '',
    'Score from 0 to 1:',
    '- 1.0: fully answers the objective and every factual claim is supported by the material above.',
    '- 0.6-0.9: answers it with minor gaps or a claim that is plausible but not shown above.',
    '- below 0.6: misses the objective, states unsupported or contradicted facts, or overstates certainty.',
    'A finding that honestly says what it could not verify is not penalised for that.',
    'Reply with ONLY one JSON object, no code fence:',
    '{"score": 0.0, "answersObjective": true, "supportedBySources": true, "issues": ["<short issue>", "..."]}',
  ].join('\n');
}

function parseGrade(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    const score = Number(value.score);
    if (!Number.isFinite(score)) return null;
    return {
      score: Math.min(1, Math.max(0, score)),
      answersObjective: Boolean(value.answersObjective),
      supportedBySources: Boolean(value.supportedBySources),
      issues: Array.isArray(value.issues) ? value.issues.filter(i => typeof i === 'string').map(i => i.slice(0, 200)).slice(0, 6) : [],
    };
  } catch { return null; }
}

module.exports = { shouldGrade, gradePrompt, parseGrade };

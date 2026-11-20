'use strict';
// economics-v1 model router. Chooses among operator-approved profiles only; a task can never name a model.
// Cold profiles (< MIN_OBSERVATIONS) are explored first, cheapest list price first. After that a profile must
// meet its quality floor (evidence-backed success rate) and qualifying profiles are ranked by cost per
// successful output, then latency, then ID. If none qualify, routing fails closed rather than downgrading.

const MIN_OBSERVATIONS = 3;

const listPrice = p => (p.inputPerMTok || 0) + (p.outputPerMTok || 0);

function chooseProfile(role, profiles, stats) {
  const candidates = (role.models || [])
    .filter(id => profiles[id] && profiles[id].enabled !== false)
    .map(id => ({ id, profile: profiles[id], stats: stats(id) }));
  if (!candidates.length) throw new Error('Flux: no enabled model profile for this role');

  const cold = candidates.filter(c => c.stats.n < MIN_OBSERVATIONS)
    .sort((a, b) => listPrice(a.profile) - listPrice(b.profile) || a.id.localeCompare(b.id));
  if (cold.length) return { id: cold[0].id, reason: `exploring (${cold[0].stats.n}/${MIN_OBSERVATIONS} observations)` };

  const qualified = candidates
    .map(c => ({ ...c, rate: c.stats.ok / c.stats.n }))
    .filter(c => c.rate >= (c.profile.qualityFloor ?? 0))
    .map(c => ({ ...c, costPerSuccess: c.stats.avgCostUsd / Math.max(c.rate, 1e-9) }))
    .sort((a, b) => a.costPerSuccess - b.costPerSuccess || a.stats.avgMs - b.stats.avgMs || a.id.localeCompare(b.id));
  if (!qualified.length) throw new Error('Flux: no model profile meets its quality floor for this role');
  const best = qualified[0];
  return { id: best.id, reason: `best cost per cited result ($${best.costPerSuccess.toFixed(5)}, ${(best.rate * 100).toFixed(0)}% success)` };
}

function costOf(tokens, profile, hermesCostUsd) {
  if (hermesCostUsd > 0) return { usd: hermesCostUsd, basis: 'hermes' };
  const usd = ((tokens.input || 0) * (profile.inputPerMTok || 0)
    + (tokens.output || 0) * (profile.outputPerMTok || 0)
    + (tokens.cacheRead || 0) * (profile.cacheReadPerMTok || 0)
    + (tokens.cacheWrite || 0) * (profile.cacheWritePerMTok || 0)) / 1e6;
  return { usd: Math.round(usd * 1e8) / 1e8, basis: 'operator-rate' };
}

module.exports = { chooseProfile, costOf, MIN_OBSERVATIONS };

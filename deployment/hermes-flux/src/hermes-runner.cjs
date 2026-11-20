'use strict';
// Runs one Flux agent call as a real Hermes child: `hermes -p flux chat -Q --format stream-json`.
// Role toolsets map to `-t` (so web access, skills and the consult tool are per role), knowledge is in the
// prompt, continuous memory uses `--resume`, and `--max-turns` / `--run-budget` bound the run. Token use
// is read back from the profile's state.db (session_model_usage covers every call, including the hidden
// title-generation call) and tool outputs from `messages` are returned as evidence for citation checks.
const { spawn, execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

// Hermes needs at least one toolset name; `todo` is harmless (an in-session checklist) for tool-less roles.
const NO_TOOLS = 'todo';

function readSession(dbFile, sessionId) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return null; }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const u = db.prepare(`select coalesce(sum(input_tokens),0) input, coalesce(sum(output_tokens),0) output,
      coalesce(sum(cache_read_tokens),0) cacheRead, coalesce(sum(cache_write_tokens),0) cacheWrite,
      coalesce(sum(reasoning_tokens),0) reasoning, coalesce(sum(estimated_cost_usd),0) cost,
      coalesce(sum(api_call_count),0) calls from session_model_usage where session_id = ?`).get(sessionId);
    const evidence = db.prepare(`select content from messages where session_id = ? and role = 'tool'`)
      .all(sessionId).map(r => String(r.content ?? '')).join('\n');
    return {
      cumulative: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, reasoning: u.reasoning },
      hermesCostUsd: u.cost, apiCalls: u.calls, evidence,
    };
  } finally {
    db.close();
  }
}

function createHermesRunner({
  hermes = 'hermes', profile = 'flux',
  stateDb = path.join(os.homedir(), '.hermes', 'profiles', profile, 'state.db'),
  graceSeconds = 60, env = process.env,
} = {}) {
  async function run({ role, profile: model, prompt, resume, ticket }) {
    const toolsets = [...(role.toolsets || [])];
    if ((role.consults || []).length || toolsets.includes('web')) toolsets.push('flux');
    const args = ['-p', profile, 'chat', '-Q', '--format', 'stream-json', '--source', 'tool',
      '-m', model.model, '--provider', model.provider, '-t', toolsets.length ? toolsets.join(',') : NO_TOOLS,
      '--max-turns', String(role.maxTurns ?? 8), '--query-file', '-'];
    if (role.skills?.length) args.push('-s', role.skills.join(','));
    if (role.runBudgetSeconds) args.push('--run-budget', String(role.runBudgetSeconds));
    if (resume) args.push('--resume', resume);

    const started = Date.now();
    const child = spawn(hermes, args, { env: { ...env, FLUX_AGENT_TOKEN: ticket || '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    const hardLimitMs = ((role.runBudgetSeconds ?? 300) + graceSeconds) * 1000;
    const timer = setTimeout(() => child.kill('SIGTERM'), hardLimitMs);
    child.stdin.end(prompt);
    const code = await new Promise(resolve => child.on('close', resolve));
    clearTimeout(timer);

    let sessionId = null, result = null;
    const texts = [];
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.session_id) sessionId = event.session_id;
      if (event.type === 'text' && event.text) texts.push(event.text);
      if (event.type === 'result') result = event;
    }
    if (!result || code !== 0 || result.exit_code) {
      if (sessionId) await discard(sessionId).catch(() => {});
      throw new Error(`Flux: agent run failed (exit ${code ?? 'killed'}): ${(stderr || stdout).trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`);
    }
    const db = sessionId ? readSession(stateDb, sessionId) : null;
    const t = result.tokens || {};
    return {
      sessionId,
      text: result.text ?? texts.join(''),
      tokens: { input: t.input || 0, output: t.output || 0, cacheRead: t.cache_read || 0, cacheWrite: t.cache_write || 0, reasoning: 0 },
      cumulative: db?.cumulative || null,
      hermesCostUsd: db?.hermesCostUsd || 0,
      evidence: db?.evidence || '',
      durationMs: result.duration_ms ?? Date.now() - started,
    };
  }

  function discard(sessionId) {
    return new Promise(resolve => execFile(hermes, ['-p', profile, 'sessions', 'delete', sessionId, '--yes'],
      { env, timeout: 60000 }, () => resolve()));
  }

  return { run, discard };
}

module.exports = { createHermesRunner, readSession };

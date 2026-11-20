'use strict';
// MCP tools (streamable HTTP, JSON responses). Bots get missions/run/agents/ledger; a running Flux agent
// gets only flux_consult, bound to its per-call ticket.
const pkg = { name: 'hermes-flux', version: '0.1.0' };

const BOT_TOOLS = [
  {
    name: 'flux_missions',
    description: 'List the Flux missions you may run. Flux spins up governed specialist agents (real Hermes agents) with fixed tools, knowledge, a budget and an audit ledger; they return cited findings and then retire, idle on a TTL, or persist. Use Flux instead of delegate_task when the job needs a named specialist, least-privilege tools, cited evidence, cost tracking, or a specialist that should be shared or remembered (compliance reviewer, household steward).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'flux_run',
    description: 'Run a Flux mission. Specialists are spawned or reused under operator policy; the result has one cited finding per capability with a disposition (supported, change-needed, human-review, info), plus tokens and shadow cost. Missions can take a few minutes. Denials (mission not granted, budget, frozen) happen before any agent starts.',
    inputSchema: {
      type: 'object',
      properties: {
        mission: { type: 'string', description: 'Mission id from flux_missions.' },
        objective: { type: 'string', description: 'What you need, in plain language, with the relevant details.' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'Optional subset of the mission capabilities.' },
        workflow: { type: 'string', description: 'Optional workflow id: reuse it to share task agents across related runs.' },
        inputs: { type: 'array', description: 'Optional evidence the agents may cite as input:<ref>.', items: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'] } },
      },
      required: ['mission', 'objective'],
      additionalProperties: false,
    },
  },
  {
    name: 'flux_agents',
    description: 'Show live Flux agents: role, lifecycle (task, ttl, persistent), state, TTL remaining, calls, tokens and cost.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'flux_ledger',
    description: 'Summarise Flux spend and outcomes from the tamper-evident ledger (tokens, shadow cost, runs, denials, spawns, promotions).',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 31 } }, additionalProperties: false },
  },
];

const AGENT_TOOLS = [
  {
    name: 'flux_consult',
    description: 'Consult a specialist through Flux (only the missions your role contract lists). Returns cited findings; cite each by its ref (flux:...). Ask one focused question per call.',
    inputSchema: {
      type: 'object',
      properties: {
        mission: { type: 'string', description: 'A mission from your role contract, e.g. compliance-review.' },
        question: { type: 'string', description: 'The focused question, with the facts the specialist needs.' },
        ticket: { type: 'string', description: 'The ticket from your role contract (always pass it).' },
      },
      required: ['mission', 'question'],
      additionalProperties: false,
    },
  },
  {
    name: 'flux_fetch',
    description: 'Read a public web page as plain text (for roles with web access; web_extract is unavailable on this host). Cite the page by its URL. Private and local network addresses are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL to read, typically from a web_search result.' },
        ticket: { type: 'string', description: 'The ticket from your role contract (always pass it).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

function compactRun(result) {
  return {
    runId: result.runId,
    mission: result.mission,
    findings: result.findings.map(f => ({
      capabilityId: f.capabilityId, agentId: f.agentId, lifecycle: f.lifecycle, disposition: f.disposition,
      summary: f.summary, sources: f.sources,
    })),
    agents: result.events.filter(e => e.agentId).map(e => `${e.kind} ${e.agentId}`),
    usage: result.usage,
    durationSeconds: Math.round(result.durationMs / 1000),
  };
}

function createTools(flux) {
  const { engine, registry, ledger } = flux;
  return {
    list(caller) { return caller.kind === 'bot' ? BOT_TOOLS : AGENT_TOOLS; },
    async call(caller, name, args) {
      if (caller.kind === 'bot') {
        if (name === 'flux_missions') return { missions: engine.missionsFor({ kind: 'bot', id: caller.id }), liveAgents: registry.snapshot().map(a => `${a.id} (${a.lifecycle}, ${a.state})`) };
        if (name === 'flux_run') {
          const capabilities = Array.isArray(args.capabilities) && args.capabilities.length ? args.capabilities : undefined;
          return compactRun(await engine.run({ mission: args.mission, objective: args.objective, capabilities, workflow: args.workflow, inputs: args.inputs || [], requester: { kind: 'bot', id: caller.id } }));
        }
        if (name === 'flux_agents') return { frozen: registry.frozen, agents: registry.snapshot() };
        if (name === 'flux_ledger') return { ...ledger.summary(Math.min(31, Math.max(1, args.days || 1))), chain: ledger.verify() };
      } else if (name === 'flux_consult') {
        const ticket = caller.ticket || args.ticket;
        return engine.consult(ticket, { mission: args.mission, question: args.question });
      } else if (name === 'flux_fetch') {
        return engine.fetch(caller.ticket || args.ticket, args.url);
      }
      throw new Error(`Flux: tool ${name} is not available to this caller`);
    },
  };
}

async function handleMcp(message, caller, tools) {
  const { id, method, params = {} } = message || {};
  const reply = result => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    return reply({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: pkg });
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return null;
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: tools.list(caller) });
  if (method === 'tools/call') {
    try {
      const out = await tools.call(caller, params.name, params.arguments || {});
      return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false });
    } catch (error) {
      return reply({ content: [{ type: 'text', text: String(error.message || error) }], isError: true });
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

module.exports = { createTools, handleMcp, compactRun, BOT_TOOLS, AGENT_TOOLS };

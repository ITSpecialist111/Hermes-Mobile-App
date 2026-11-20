# Hermes Flux: governed specialist agents for a Hermes household

Flux lets Hermes bots call on **specialist agents that exist only while they are useful**. A Flux agent is a real Hermes agent (a child `hermes chat` on the `flux` worker profile). The operator defines it: persona, tools, knowledge, web access, model, budget and lifecycle. Each call returns a **cited finding** and is written to a **tamper-evident token and cost ledger**.

Flux keeps the portable `@corpgen/flux-runtime` 1.0.0 (vendored unchanged; see `vendor/flux-runtime`) as its policy gate. That gate handles missions, capability grants, tenant and scope, preflight, and the rule that every finding must cite something. This directory adds what a runtime of real agents needs on top.

## Hermes sub-agents vs Flux agents

They solve different problems, and both are available to every bot.

| | Hermes sub-agents (`delegate_task`) | Flux agents (`flux_run`) |
|---|---|---|
| Who defines the helper | The calling model, at run time (goal text) | The operator, in `operator/policy.json` (roles) |
| Tools | Inherits the parent's tools minus a fixed blocklist. A Pilot sub-agent can drive the phone | Only the role's toolsets (`-t`), plus `flux_fetch`/`flux_consult` if granted. No phone or HA secrets on the worker profile |
| Knowledge | Whatever the parent passes in the goal | Approved knowledge packs per role (`operator/knowledge/<pack>`), citable by ref |
| Model | Parent's model (or a configured override) | Chosen per call by the economics router from operator-approved profiles |
| Lifetime | Dies with the delegation | `task`, `ttl` (idle timeout), or `persistent`; ttl agents can be promoted to persistent when many agents use them |
| Memory | None beyond the call | `fresh` per call, or `continuous` (resumes one Hermes session across missions, e.g. Household Steward) |
| Sharing | None: each delegation is private to its parent | One logical specialist can serve several requesters (same scope and policy revision), with separate answers |
| Agent-to-agent | Children cannot delegate further | Agents consult missions their role lists (`flux_consult`), depth-limited, loops refused |
| Preflight | None | Whole plan checked before anything runs: mission grant, capabilities, bindings, budgets, freeze |
| Output | Free text summary | JSON finding: summary, sources, disposition (supported / change-needed / human-review / info) |
| Evidence | Not checked | Sources are grounded: URLs must appear in the agent's own tool output; knowledge and input refs must have been given; invented ones are dropped; no grounded source means rejected |
| Tokens and cost | In the parent's session totals | Per step, per agent, per mission, per requester, per model; shadow cost at operator rates; daily and mission budgets fail closed |
| Audit | Session transcript | Hash-chained ledger (`flux-ctl verify`), Live Map, `flux_ledger` |
| Parallelism | Yes, inside the parent's turn | Mission stages run in parallel; stage outputs hand off to the next stage as citable inputs |
| Best for | Quick parallel chores the bot could do itself | Named specialists, cited research, purchase and compliance questions, anything to audit, roles that should persist |

Each bot's SOUL.md has a short Flux section with this guidance.

## Lifecycles

| Lifecycle | Spawned | Between calls | Retired | Example |
|---|---|---|---|---|
| `task` | On first use in a workflow | (none) | When its last caller releases it | Research, Market, Security analysts, Reply drafter |
| `ttl` | On first use in the scope | Idle; reused by any requester in the scope | Idle for `ttlSeconds`, or at `maxLifetimeSeconds` | Compliance Reviewer (15 min) |
| `persistent` | On first use | Standby: identity, counters and memory survive restarts; no compute | Only by the operator (`flux-ctl retire`) or a policy revision change | Household Steward |

**Promotion** is the dynamic part. A ttl role with `promote: { to: "persistent", distinctRequesters: 3, withinSeconds: 3600 }` becomes persistent once three different agents or bots use it within an hour. A specialist that has proved useful to the whole runtime then stays. Promotion is recorded in the ledger. A policy revision change retires idle agents of the old revision.

An agent's identity is not a container. Calls are separate `hermes chat` runs; `continuous` memory resumes one session and serialises its calls.

## What a role can have

```jsonc
"compliance.reviewer": {
  "persona": "...",                       // data, not authority
  "lifecycle": "ttl", "ttlSeconds": 900, "share": "scope", "memory": "fresh",
  "promote": { "to": "persistent", "distinctRequesters": 3, "withinSeconds": 3600 },
  "toolsets": ["web"],                    // Hermes toolsets; "web" also grants flux_fetch
  "skills": [],                           // Hermes skills (-s)
  "knowledge": ["compliance"],            // operator/knowledge/compliance/*.md
  "consults": [],                         // missions it may consult (none: no recursion)
  "models": ["sonnet"],                   // operator model profiles
  "maxTurns": 10, "runBudgetSeconds": 240
}
```

`flux_fetch` exists because this host's Hermes web backend (`ddgs`) can search but not open pages. It returns page text for public addresses only. LAN, loopback, link-local and CGNAT addresses are refused at every redirect hop, so an agent cannot reach Home Assistant, the phone, or Flux itself.

## Missions in this household

| Mission | Steps | Who may run it |
|---|---|---|
| `research` | Research Analyst (may consult compliance) | all bots |
| `compliance-review` | household policy lookup, then Compliance Reviewer | pilot, scout, atlas, hearth; analysts and steward via consult |
| `purchase-review` | Market and Security analysts and the policy lookup **in parallel**, then the Household Steward | pilot, scout, pantry, shopping |
| `steward-log` | Household Steward | pilot, hearth |
| `reply-draft` | Reply Drafter | reply-drafter service |
| `inbox-brief` | phone notifications (read-only) | pilot |

`phone.send` is declared but granted nowhere. Asking for it fails before anything runs.

## Run it

```bash
./install.sh --wire-bots   # on the Hermes host, as the hermes user, from this directory
```

The installer does the following:

1. Copies the app to `~/.hermes/flux/app` and creates `~/.hermes/flux/flux.env` (`HERMES_FLUX_TOKEN`, `FLUX_VIEW_KEY`, mode 600).
2. Creates the `flux` worker profile (cloned from pilot). Its only MCP server is Flux, and it holds no phone or Home Assistant secrets.
3. Installs the `hermes-flux` user service.
4. With `--wire-bots`, gives every granted bot an `mcp_servers.flux` entry (with its `X-Hermes-Bot` header) and the SOUL section.

Hermes loads new MCP servers only on restart, and it freezes each session's tool list. After wiring, clear the frozen prompts and restart the gateway and dashboard, as in `../hermes-bots/README.md`.

```bash
flux-ctl status | agents | missions --bot pilot | ledger --days 7 | verify
flux-ctl run research "question" --bot pilot
flux-ctl freeze | unfreeze | retire <agentId>
```

- **MCP and API:** `127.0.0.1:18790`, bearer token. Bots get `flux_missions`, `flux_run`, `flux_agents` and `flux_ledger`. Running agents get `flux_consult` and `flux_fetch`, bound to a per-call ticket.
- **Live Map:** `http://<host>:18791/?key=<FLUX_VIEW_KEY>`. It shows metadata only, never findings or objectives. It also appears in the app under **Settings → Flux agents**, and over WireGuard away from home.
- **Tests:** `node --test test/flux.test.cjs` (fake Hermes runner; no model calls).

## Results on this host (20 Nov 2026)

| Run | What happened | Tokens / shadow cost |
|---|---|---|
| Denials | Unknown mission, `phone.send`, `forge` asking for purchase-review: refused before any agent started | 0 |
| `research` (PSTI) | Haiku analyst consulted compliance on its own; TTL reviewer spawned; analyst retired | 68.6k / $0.094 |
| `purchase-review` (video doorbell) | Two analysts in parallel, each consulted the **same** reviewer (reused across workflows), reviewer **promoted to persistent** at 3 requesters; steward consolidated and consulted; all `change-needed` | 208k / $0.23, 97 s |
| Pilot via the gateway: `steward-log` | Pilot chose Flux, the persistent steward **remembered** the doorbell decision after a service restart | 14k / $0.04 |
| `research` with `flux_fetch` | Opened TP-Link's UK page, quoted the spec, separated activity zones from privacy masking | 67k / $0.036 |

Shadow cost uses the operator's list-price rates in `policy.json`. The Copilot subscription does not bill per token, so treat it as an economics signal, not an invoice. Hermes's own estimate is used instead whenever it reports one.

## Limits (honest)

- Requester identity (`X-Hermes-Bot`) is asserted by local processes holding the bearer token. The service listens on loopback only.
- `flux_fetch` checks DNS before connecting (a rebinding race is possible); it does not read PDFs.
- The router's "success" means a grounded finding was produced, not that the answer was graded correct.
- Logical agents live in one process. Persistent agents survive restarts; agents that were mid-call do not resume.

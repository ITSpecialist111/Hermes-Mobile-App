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
| Human in the loop | None (the parent decides) | Findings marked human-review, or a bot's `flux_request_approval`, become Allow / Deny cards on Graham's phone; bots check `flux_approvals` before acting |
| Quality | Not measured | A grader agent samples findings against the evidence the agent saw; failed grades count against that model in routing |
| Memory rules | n/a | Role memory rules, automatic rotation into a scrubbed, dated digest, `flux_forget` (all or one topic) |
| Cost before you spend | n/a | `flux_plan` dry run: spawn or reuse, model, expected and worst-case cost, budget warnings; zero model calls |
| Across machines | n/a | Other Flux cores run granted missions here (and this core can call theirs) with Ed25519-signed grants |

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

## Human approval, quality, memory, dry runs and federation

### Approvals on the phone (`src/approvals.cjs`, app `src/flux.ts`)
When a top-level finding has a disposition listed in `policy.approvals.on` (default `human-review`), it becomes an approval. A bot can also ask directly with `flux_request_approval`, for example "Buy the Aqara G400 for £99.99?".

- **On the phone:** the Hermes Mobile app polls `:18791/api/approvals` and raises each pending approval as the native **Allow once / Deny** card used for command approvals. A tap goes straight back to Flux. The Live Map also shows the queue with Approve and Deny buttons.
- **Keys:** both need the link with `&approve=<FLUX_APPROVE_KEY>`. The view key alone shows no approvals.
- **Records:** details stay in `state/approvals.json`. The ledger records who asked, the decision, who made it and when; notes are never written to it.
- **Expiry:** pending approvals expire after 7 days.
- **Bots:** `flux_approvals` shows decisions. Bots are told never to act on a pending, denied or expired approval.

### Graded quality (`src/quality.cjs`)
"Grounded" means the sources were really used. It does not mean the answer is right. So a `quality.grader` agent (ttl, tool-less) re-reads sampled findings against the raw tool output the agent saw, plus the cited knowledge, inputs and consult results, and scores them from 0 to 1.

- **Sampling:** the first 3 findings per capability and model are always graded, then 25% (`policy.quality`).
- **Background only:** grading never delays or changes the mission result.
- **Effect on routing:** a graded step counts as a success for the router only if it passed (score ≥ 0.6). `flux_ledger` and the Live Map show average quality per model.

### Memory governance (`src/memory.cjs`)
Continuous-memory roles get `memoryPolicy` (`rules`, `maxCalls`, `retainDays`), and the rules are part of their contract.

- **Rotation:** after `maxCalls` calls, or once the memory is older than `retainDays`, the agent writes a dated digest of what it must keep.
  - Emails, phone numbers, long numbers and postcodes are scrubbed from it.
  - The old Hermes session is deleted, and the next call starts fresh with the digest.
- **Forget:**
  - `flux_forget` / `flux-ctl forget <agentId> [topic]` drops everything, or rewrites the memory without one topic.
  - The ledger records a hash of the topic, never the topic or the memory.
  - Only bots in `memoryAdmins` may use it.

### Dry runs (`engine.preview`)
`flux_plan` / `flux-ctl plan <mission> <objective>` makes zero model calls. It runs the same authorisation, budget and plan checks as a real run, then shows:

- each step's agent (spawn or reuse);
- its model and why the router chose it;
- an estimate from earlier ledger runs;
- possible consultations;
- the expected and worst-case cost, with budget warnings.

A plan that would be refused says so.

### Federation (`src/federation.cjs`, port 18792)
Each core has an Ed25519 host key (`state/federation-key.json`).

- **Grants:** `flux-ctl grant <peerId> <peer public key or key file> --missions a,b --days 30 --usd 1` returns a grant token signed by this host. It names the peer's key, its missions, a daily allowance and an expiry.
- **Requests:** the peer signs every request (`peer-keygen`, `peer-call`).
- **What this host checks:**
  - the grant signature, expiry and revocation (`flux-ctl revoke`);
  - that the request is signed by the key in the grant;
  - a 5-minute clock window and a single-use nonce;
  - the mission list and the peer's daily allowance.
- **Normal rules still apply:** all of this host's own rules apply too (budgets, freeze, grounding).
- **Replies:** they are signed by this host, so the peer can prove which core produced the findings.
- **Calling out:** `createPeerBinding` lets an operator bind a capability to a mission on a peer core. Its findings keep their sources and gain a `flux-peer:<core>/<run>/<capability>` ref.

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
flux-ctl plan purchase-review "question" --bot pilot          # dry run, no model calls
flux-ctl approvals [pending] | approve <id> [note] | deny <id> [note] | ask "<title>" <summary...>
flux-ctl memory | rotate <agentId> | forget <agentId> [topic]
flux-ctl federation | grant <peerId> <key> --missions a,b | revoke <grantId>
flux-ctl peer-keygen <file> | peer-call <url> <grant-file> <key-file> <mission> <objective...> [--host-key <key>]
flux-ctl freeze | unfreeze | retire <agentId>
```

- **MCP and API:** `127.0.0.1:18790`, bearer token. Bots get `flux_missions`, `flux_run`, `flux_plan`, `flux_agents`, `flux_ledger`, `flux_approvals`, `flux_request_approval`, `flux_memory` and `flux_forget`. Running agents get `flux_consult` and `flux_fetch`, bound to a per-call ticket.
- **Live Map:** `http://<host>:18791/?key=<FLUX_VIEW_KEY>`, plus `&approve=<FLUX_APPROVE_KEY>` for the approvals queue. It shows metadata only unless approvals are unlocked. It also appears in the app under **Settings → Flux agents**, and over WireGuard away from home.
- **Federation:** `http://<host>:18792`. It accepts signed grants only.
- **Tests:** `node --test test/flux.test.cjs` (15 tests; fake Hermes runner; no model calls).

## Results on this host (20 Nov 2026)

| Run | What happened | Tokens / shadow cost |
|---|---|---|
| Denials | Unknown mission, `phone.send`, `forge` asking for purchase-review: refused before any agent started | 0 |
| `research` (PSTI) | Haiku analyst consulted compliance on its own; TTL reviewer spawned; analyst retired | 68.6k / $0.094 |
| `purchase-review` (video doorbell) | Two analysts in parallel, each consulted the **same** reviewer (reused across workflows), reviewer **promoted to persistent** at 3 requesters; steward consolidated and consulted; all `change-needed` | 208k / $0.23, 97 s |
| Pilot via the gateway: `steward-log` | Pilot chose Flux, the persistent steward **remembered** the doorbell decision after a service restart | 14k / $0.04 |
| `research` with `flux_fetch` | Opened TP-Link's UK page, quoted the spec, separated activity zones from privacy masking | 67k / $0.036 |
| `flux_plan` purchase-review | Zero model calls: spawn/reuse per step, router choice, expected $0.13, worst case $0.25 with consults; `forge` refused | 0 |
| Grader on a real research finding | Scored 0.82 (pass), and flagged two "corroborating" sites absent from the agent's tool output and an over-strong `supported` | 12.9k / $0.043 |
| Steward memory rotation | 2.8k-character dated digest, nothing to redact, old session deleted, digest carried into the next call | one model call |
| Federation from another PC | Peer `office-pc` ran `compliance-review` with a signed grant; reply signature verified; `purchase-review` refused (not in grant) | 8.4k / $0.032 |

Shadow cost uses the operator's list-price rates in `policy.json`. The Copilot subscription does not bill per token, so treat it as an economics signal, not an invoice. Hermes's own estimate is used instead whenever it reports one.

## Limits (honest)

- Requester identity (`X-Hermes-Bot`) is asserted by local processes holding the bearer token. The service listens on loopback only.
- Phone approvals arrive while the Hermes Mobile app process is alive (it polls every 20 s). They are always on the Live Map.
- Grades come from another model. They are a quality signal, not ground truth.
- The digest scrubber catches common patterns (emails, UK phone numbers, long numbers, postcodes), not every personal detail. The role's memory rules carry the rest.
- `flux_fetch` checks DNS before connecting (a rebinding race is possible); it does not read PDFs.
- The router's "success" means a grounded finding was produced, not that the answer was graded correct.
- Logical agents live in one process. Persistent agents survive restarts; agents that were mid-call do not resume.

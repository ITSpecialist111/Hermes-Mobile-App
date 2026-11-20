# Flux use cases

Flux is not a separate chat. You talk to a normal Bot (Pilot is granted every mission) and ask it to use Flux. The Bot runs the mission, Flux spins up or reuses the specialists, and the Bot reports their cited findings back to you.

Start a **new chat** after installing Flux: older chats keep the tool list they started with.

## How to start

| You say to a Bot | What Flux does |
|---|---|
| "Use Flux to research which smart thermostats under £200 work with Home Assistant." | `research`: a temporary Research Analyst searches and reads pages (`flux_fetch`), cites them, and retires. |
| "Run a Flux purchase review: two video doorbells under £150 for the front door." | `purchase-review`: Market and Security analysts run in parallel and consult the shared Compliance Reviewer. Then the persistent Household Steward records the decision. |
| "With Flux, what would a purchase review for a robot vacuum cost? Don't run it." | `flux_plan`: a dry run with zero model calls. It shows which agents would spawn or be reused, the model each would use, the expected and worst-case cost, and any budget warnings. |
| "Ask the Flux compliance reviewer whether we can keep doorbell clips for 60 days." | `compliance-review`: a household-rules lookup, then the Compliance Reviewer gives a disposition. |
| "What has the Flux household steward recorded about the doorbell?" | `steward-log`: the persistent steward answers from its memory. |
| "Ask me before buying the Aqara for £99.99." | `flux_request_approval`: an **Allow / Deny** card appears on your phone and on the Live Map. |
| "Show my Flux approvals" / "What did I decide about the doorbell?" | `flux_approvals`: lists pending, approved, denied and expired approvals. |
| "Make the steward forget the doorbell." | `flux_forget`: the steward rewrites its memory without that topic. The ledger keeps only a hash of the topic. |
| "How much has Flux spent this week, and which model is doing best?" | `flux_ledger`: tokens, shadow cost, runs, denials, spawns, promotions and graded quality per model. |

Watch it happen under **Settings → Flux agents** in Hermes Mobile. A dotted ring is a dormant role. Formed orbs are live agents: task (amber), TTL (cyan, with an arc for the time left) and persistent (violet).

## Worked examples (real runs, 20 Nov 2026)

### 1. Buying a video doorbell (`purchase-review`)
- **What happened:**
  - Two analysts ran in parallel.
  - Each one consulted the **same** Compliance Reviewer on its own. That reviewer was reused from an earlier run and was promoted to persistent after its third distinct requester.
  - The Household Steward consolidated the findings: `change-needed`. The camera would see the pavement, so UK GDPR applies: masking, audio off, a sign, and clips kept for at most 30 days.
- **Approval:** nothing was bought. A purchase over £100 needs Graham's approval.
- **Cost:** 208k tokens, about $0.23 at list prices, 97 s.

### 2. Checking a specific claim (`research` + `flux_fetch`)
- **What happened:** the analyst opened TP-Link's UK spec page, quoted it, and separated "activity zones" (which only filter alerts) from privacy masking (which stops recording).
- **Grading:** a later Aqara question was graded 0.82 by the quality grader. The grader flagged two "corroborating" sites that the agent had never opened.

### 3. Remembering across days (`steward-log`)
- **What happened:** after a service restart, Pilot asked the steward what had been decided and what still needed sign-off. The steward answered from memory.
- **Memory rotation:** its memory later rotated into a 2.8k-character dated digest, and the old session was deleted.

### 4. Approving from the phone
- **What happened:** a Bot asked "Buy the Aqara G400 doorbell for £99.99?". The Fold7 showed **Flux · pilot needs approval** with **Allow once** and **Deny**.
- **Result:** the tap was recorded as `approved` by `graham:phone` in the hash-chained ledger, and the card cleared.

### 5. Another machine asking for help (federation)
- **What happened:** a second computer (`office-pc`) with a signed grant ran `compliance-review` on the home core for $0.03. It got signed findings back.
- **Refused:** it asked for `purchase-review`, which is outside its grant, and was refused.

### 6. Safety checks that cost nothing
- **Refused before anything ran:** these requests started no agent and made zero tool calls:
  - `forge` asking for a purchase review;
  - any request for `phone.send`;
  - an unknown mission;
  - the runtime while frozen.

## Who can run what

| Bot | Missions |
|---|---|
| Pilot | research, compliance-review, purchase-review, steward-log, inbox-brief |
| Scout | research, compliance-review, purchase-review |
| Atlas | research, compliance-review |
| Hearth | research, compliance-review, steward-log |
| Pantry, Shopping | research, purchase-review |
| Forge | research |

Grants live in `operator/policy.json` (`bots`). Only the operator can change them.

## When to use Flux and when to use Hermes sub-agents

- **Hermes sub-agents (`delegate_task`):** quick, private helpers that inherit the Bot's own tools. Use them for parallel chores the Bot could do itself.
- **Flux:** use it when the job needs any of these:
  - a named specialist;
  - least-privilege tools;
  - cited evidence;
  - a budget;
  - your approval;
  - an audit trail;
  - a specialist that should be shared or should remember.

The full comparison table is in [README.md](README.md).

## From the host (SSH)

```bash
flux-ctl run research "your question" --bot pilot
flux-ctl plan purchase-review "your question" --bot pilot   # dry run, no cost
flux-ctl approvals pending
flux-ctl ledger --days 7
```

# Ethical ICU Triage Panel (`ethical-triage-panel-agent`)

Reference example for **moderated multi-agent deliberation** on a single shared topic: a hospital must allocate the last ICU bed among several patients. The goal is to show **protocol and role interaction** (broadcast, round-robin, explicit recipient, projection, signal-based closure), not medical correctness.

All **in-topic natural language** is **Russian** (JSON field names and code remain English). See [How-to: Multi-agent conversation](../../docs/15-how_to_multiagent_conversation.md).

## What this demonstrates

- One **topic** with a moderator seat plus four **persona seats**; **four personas share one `agentId`** so routing must use distinct `memberId`s.
- **Selectors**: `broadcast` (case brief, synthesis), `round_robin` (initial and final prompts), `explicit_recipient` (directed critiques).
- **Custom topic projection** `x-triage.panel-state`: initial/final votes, mind changes, critique edges, simple majority candidate, final decision message id.
- **Stop policies**: `signalBased` on `x-triage.decision-finalized` (primary) and a high `maxRounds` safety net (see note below).
- **Transcript file**: running the demo writes a formatted UTF-8 transcript (default `ethical-triage-transcript.txt` in the current working directory, or `TRIAGE_TRANSCRIPT_PATH`).

## Architecture

| Role | `agentId` | `memberId` |
|------|-----------|------------|
| Moderator (owner) | `ethical-triage-moderator-agent` | `triage#moderator` |
| Personas (same agent) | `ethical-triage-persona-agent` | `triage#utilitarian`, `triage#fairness`, `triage#duty`, `triage#pragmatist` |

**Moderator** (`moderator-agent.ts`, `moderator-modules.ts`): orchestrates protocol; bundled demo execution runs the full in-memory `ConversationService` driver and writes the transcript (APLRET: perception/learning/policy stay pure; effects in execution).

**Personas** (`persona-agent.ts`): on `wakeOnTopicMessage`, reply deterministically from fixtures for `triage_initial_prompt`, `triage_critique`, and `triage_final_prompt` (Russian JSON bodies).

**Phases** (see `deliberation-driver.ts`): create topic → broadcast brief → round-robin initial prompts and answers → explicit critiques and replies → moderator reads projection and broadcasts synthesis → round-robin final prompts → revisions → final decision → `appendSignal` → verify post-close rejection.

### Stop policy note

`readProjection` requires the topic to remain **open**. A tight `maxRounds` rule with **five** seats increments `totalRounds` quickly (`floor(messages/5)`), which can close the topic **before** synthesis. This example therefore uses **`signalBased` first** and **`maxRounds: 500`** as a backstop. For panels with fewer messages per round, you can lower the backstop once you have validated counts.

## Running locally

From the monorepo root:

```bash
yarn install
yarn workspace @a2arium/callagent-core build
yarn workspace @a2arium/ethical-triage-panel-agent build
yarn workspace @a2arium/ethical-triage-panel-agent start
```

Optional output path:

```bash
TRIAGE_TRANSCRIPT_PATH=/tmp/triage.txt yarn workspace @a2arium/ethical-triage-panel-agent start
```

**Runner (moderator manifest)** — after `build`, from repo root:

```bash
yarn run-agent apps/examples/ethical-triage-panel-agent/dist/moderator-agent.js '{"runTriage": true}' 
```

Use a separate process with `persona-agent-runtime.json` / `dist/persona-agent.js` if you want live topic wakes instead of the bundled driver.

## Tests

```bash
yarn jest apps/examples/ethical-triage-panel-agent/tests/ethical-triage-panel.harness.test.ts
```

## What to inspect

- **Transcript file**: phase headers, selector usage, Russian payloads.
- **Projection**: `triagePanelProjection` in `projection.ts`; driver calls `readProjection` before the closure signal.
- **TurnTrace**: when using `ctx.conversation.post` in execution, traces include selector/fanout/stop metadata; the bundled moderator path uses a separate in-memory service (see test comment).

## Non-goals

No external tools, RAG, or NATS in this example. Selector policy registry is intentionally omitted.

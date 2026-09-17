# How-to: `flow.md` for APLRET agents

Use this guide to author and maintain **`flow.md`**, the canonical **behavioral map** for agents whose control flow spans multiple turns, awaits, or major branches.

**Related:** [APLRET contracts](./0-aplret_contracts.md) (`flow.md` expectations) · [How to test APLRET agents](./11-how_to_test_aplret_agents.md) · [How to debug with TurnTrace](./12-how_to_debug_with_turn_trace.md) · [Agent repository layout](./14-agent_repository_layout_for_aplret.md) · [Migration: adopting `flow.md`](./migration/4.1-flow-md-adoption-migration.md) · [Migration: scaffold tooling](./migration/4.1-scaffold-agent-tooling.md)

---

## What `flow.md` is for

APLRET agents are **structurally** clear (Attention → … → Transition) but **procedurally** distributed across modules and resumed turns. That is good for correctness and testability; it is harder for quick answers to:

- what happens first, next, and after an await
- what causes completion or failure
- how branches relate

`flow.md` answers:

> What does this agent do over time?

It does **not** replace the runtime contract, `agent.ts`, tests, or ADRs. It complements them. Runtime truth remains **code + tests**; `flow.md` is maintained behavioral documentation.

For new agents, the non-trivial scaffold preset emits a canonical `flow.md` stub with required section order; fill in vocabulary and branch details as behavior is implemented.

---

## When `flow.md` is required

An agent **SHOULD** include `flow.md` when any of the following are true:

- it uses `await_input`, `await_tool`, or `await_child`
- it has multiple major branches
- it uses LLM-backed planning or structured extraction that steers control
- it has non-trivial failure or repair paths
- understanding the procedure requires reading several modules

**Simple one-turn agents MAY omit `flow.md`.**

---

## Normative role

- Code review **SHOULD** expect `flow.md` to be updated when behavior over time changes.
- Tests **SHOULD** align with major paths and branch IDs in `flow.md` (see [How to test APLRET agents](./11-how_to_test_aplret_agents.md)).
- Examples **SHOULD** not contradict `flow.md`.

---

## Required format

A canonical `flow.md` **MUST** use this section order:

```md
# Flow: <agent-name>

## Purpose

## Flow summary

## State vocabulary

### Stages
### Normalized observations
### Intents
### Execution result kinds
### Terminal outcomes

## Flow table

## Branches and failure paths

## Turn semantics

## Code map
```

Additional sections **MAY** be added **after** `## Code map`. Required sections **MUST** stay in this order.

### Title

```md
# Flow: <agent-name>
```

Use the same stable agent name as in the codebase.

### Purpose

1–3 sentences: behavioral role only, no low-level implementation.

### Flow summary

- **SHOULD** be 4–10 numbered steps
- dominant happy path + major failures + await/resume points

### State vocabulary

Subsections **MUST** exist:

| Subsection | Content |
|------------|---------|
| `### Stages` | Stage names matching code exactly |
| `### Normalized observations` | Normalized kinds (not raw transport) |
| `### Intents` | Domain intent kinds Policy may emit |
| `### Execution result kinds` | Categories Transition consumes |
| `### Terminal outcomes` | Success/failure visible to callers |

Example observation lines:

```md
- `user/context.provided`
- `child/html.fetched`
```

For conversation-enabled agents, vocabulary SHOULD include topic semantics where relevant:

- selectors: `broadcast`, `round_robin`, `explicit_recipient`
- topic observation kinds: `topic.message.received`, `topic.member.joined`, `topic.member.left`, `topic.closed`, `outbound.committed`
- seat identity: `memberId` (topic-scoped), with `agentId` as routing identity
- invite lifecycle kinds: `topic.invite.issued`, `topic.invite.received`, `topic.invite.accepted`, `topic.invite.declined`, `topic.invite.expired`
- invite capability token: `InviteToken` (opaque capability, not derived by policy)

### Flow table

**Most important section.** Columns **MUST** include:

| Current condition | Policy emits | Execution does | Transition outcome | Next turn consequence |

Rules:

- one row per major branch or path
- await paths MUST show await explicitly
- terminal paths MUST show completion/failure

### Branches and failure paths

**MUST** cover major failures, non-happy paths, repair/retry if used.

**Strongly recommended:** stable branch IDs:

```md
### B1: Validation failure
- Trigger:
- Policy response:
- Outcome:
```

IDs (`B1`, `B2`, …) help review, tests, and AI-assisted fixes.

### Turn semantics

Short APLRET-specific notes: when data is decision-visible, what is awaited, what resumes the loop, inbox-gated child results, etc.

### Code map

Short list: `agent.ts`, `types.ts`, normalizers, reducers, policy, effects, transition — not every helper.

---

## Authoring rules

1. **Use code names exactly** in vocabulary and flow table (no paraphrase).
2. **Describe normalized behavior**, not transport wrapper archaeology.
3. **Optimize for procedure:** start, wait, resume, complete, fail must be obvious.
4. **Stay concise** — split deep design into ADRs; keep `flow.md` navigable.
5. **Update with behavior** — same PR when stages, obs, intents, outcomes, awaits, or major branches change.
6. **Flow table is authoritative** for major paths: if code has a path, the table should have a row.

---

## Optional YAML front matter

```md
---
agent: fetch-detail-page
entry: ./agent.ts
uses_llm: false
uses_tools: false
uses_children: true
uses_plans: false
terminal_outcomes:
  - success
  - failure
---
```

Useful for future tooling.

---

## Optional test mapping

```md
## Covered by tests

- B1 validation failure -> `tests/failure.test.ts`
- B3 success path -> `tests/golden.test.ts`
```

---

## Review checklist

- [ ] Canonical section order
- [ ] Flow summary explains main path
- [ ] Flow table covers major paths
- [ ] Failures and awaits explicit
- [ ] Vocabulary matches code spelling
- [ ] Code map points to real files
- [ ] Updated in the same change as behavior when needed

---

## Worked example

```md
# Flow: fetch-detail-page

## Purpose

This agent receives detail-page fetch context, validates it, dispatches HTML fetching to a child agent, waits for completion, and returns fetched HTML or an explicit terminal failure.

## Flow summary

1. **Initialization**: Wait for fetch context (URL + siteConfig) through the current-turn inbox.
2. **Validation**: Validate usable `url` and valid `siteConfig`.
3. **Primary fetch**: If valid and HTML missing, Policy emits `start_fetch`; Execution delegates to the fetcher sub-agent.
4. **Suspension**: Transition enters `await_child` until child completion is in the inbox.
5. **Completion**: After child returns, verify HTML; complete successfully or fail.

## State vocabulary

### Stages
- `idle`, `fetching_html`, `completed`

### Normalized observations
- `user/context.provided`
- `user/validation.failed`
- `child/html.fetched`
- `child/child.failed`
- `internal/idle`

### Intents
- `wait_for_context`, `start_fetch`, `complete_success`, `fail`

### Execution result kinds
- `child_delegated`, `final_complete`, `waiting`, `fatal_error`

### Terminal outcomes
- Success: HTML + target URL
- Failure: validation or fetch failure

## Flow table

| Current condition | Policy emits | Execution does | Transition outcome | Next turn consequence |
|---|---|---|---|---|
| No context | `wait_for_context` | none | `continue` | Wait for context |
| Validation failed | `fail` | prepare error | `complete` | Terminal failure |
| Valid, no HTML | `start_fetch` | delegate child | `await_child(token)` | Suspended |
| Usable HTML | `complete_success` | prepare payload | `complete` | Terminal success |
| Child error | `fail` | prepare error | `complete` | Terminal failure |

## Branches and failure paths

### B1: Validation failure
- **Trigger**: missing `url` or bad `siteConfig`
- **Response**: `fail`
- **Outcome**: terminal failure

### B2: Child failure
- **Trigger**: child `ok === false` or empty payload
- **Response**: `fail`
- **Outcome**: terminal failure

### B3: Successful fetch
- **Trigger**: usable HTML from child
- **Response**: `complete_success`
- **Outcome**: terminal success

## Turn semantics

- Execution does not write cognition directly.
- Child results affect Policy only after inbox → Perception → Learning on a later turn.
- `await_child` suspends until matching completion observation.

## Code map

- `agent.ts`, `types.ts`, `normalizers/user.ts`, `normalizers/child.ts`, `reducers.ts`, `policy.ts`, `execution.ts`, `transition.ts`
```

---

## Keeping `flow.md` in sync with code

Treat `flow.md` as a **first-class companion** to `agent.ts`, not optional prose.

**Rule of thumb:** if you would explain the agent differently to a new engineer, update `flow.md`.

### What must stay aligned

Stages, normalized observations, intents, execution result kinds, transition/terminal outcomes, await/resume behavior, major branches, and **Code map** paths.

You do **not** need to mirror every helper rename or log line.

### When `flow.md` must be updated

| Change | Update sections |
|--------|-----------------|
| New/removed major branch | Flow summary (if major), Flow table, Branches |
| New/renamed stage | Stages, Flow table, Turn semantics if needed |
| New/renamed observation | Normalized observations, summary/branches if needed |
| New/renamed intent | Intents, Flow table, summary if needed |
| New execution result kind | Execution result kinds, Flow table, Turn semantics if awaits change |
| Await/resume semantics change | Flow summary, Flow table, Turn semantics |
| Terminal outcomes change | Terminal outcomes, Flow table, Branches |
| Files moved | Code map |

### When you usually skip `flow.md`

Internal refactors, logging-only changes, renames with no behavior change, schema tightening that does not change visible flow — unless they change how you’d explain behavior.

### Files that should trigger a `flow.md` check

`policy.ts`, `transition.ts`, `types.ts`, `perception.ts`, `learning.ts`, `execution.ts`, `normalizers/*`, `effects/**`.

### Author workflow

1. Implement behavior.
2. Re-read `flow.md` against the change (summary, table, vocabulary, turn semantics).
3. Patch only affected sections.
4. Sanity check: could someone understand new behavior from `flow.md` alone?
5. Ensure tests still cover documented branches.

### Reviewer workflow

Ask: did behavior-over-time change? If yes, was `flow.md` updated? Does the flow table match Transition? Do vocabulary spellings match `types.ts`?

### Drift signals

- Doc mentions intents/stages/obs that no longer exist
- Branch in code but not in table
- Wrong terminal or await story
- Code map points at wrong files
- Tests and `flow.md` disagree on branches

### PR template snippet

```md
- [ ] Checked whether `flow.md` needs an update
- [ ] If behavior changed, updated `flow.md`
- [ ] `flow.md` vocabulary matches this PR’s code names
```

### Repository conventions

- Keep `flow.md` next to `agent.ts`.
- Prefer stable names in code so the doc stays accurate.
- Keep Code map short.
- Use branch IDs (`B1`, `B2`, …) for non-trivial agents.

### Final check

> If I gave only `flow.md` to a new engineer, would they understand current behavior?

If no, the document is stale.

---

## See also

- [Migration: adopting `flow.md`](./migration/4.1-flow-md-adoption-migration.md) — incremental adoption for existing repos.

## Conversation vocabulary 

If the agent uses thread-native conversations, keep `flow.md` vocabulary synchronized with:

- conversation observation kinds: `message.received`, `delivery.failed`, `thread.closed`, `thread.archived`
- conversation intents used by Policy (domain-named, not transport wrappers)
- execution calls to `ctx.conversation.startThread/send/close/archive`

Behavioral rule: flow tables should show where conversation observations enter the inbox and where follow-up sends are emitted.

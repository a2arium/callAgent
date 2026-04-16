# How to keep `flow.md` in sync with code

## Status

Recommended maintenance guide for APLRET agents that use `flow.md`.

This document explains how to keep the behavioral map in `flow.md` aligned with the agent implementation over time.

---

## Purpose

`flow.md` exists to explain what an agent does over time:

- what starts the flow
- what the agent waits for
- what branches exist
- what causes completion or failure
- how await/resume paths behave across turns

That value disappears quickly if the document drifts from code.

This guide defines the practical discipline needed to keep `flow.md` useful.

---

## Core principle

Treat `flow.md` as a **behavioral companion artifact** to `agent.ts`.

It is not optional prose.
It is not a one-time design note.
It is part of the maintained surface of the agent.

A good rule is:

> If the agent’s behavior changed in a way that would change how you explain it to a new engineer, `flow.md` should change too.

---

## What `flow.md` must stay aligned with

`flow.md` should stay aligned with the following code-level behavior:

- stage vocabulary
- normalized observation vocabulary
- intent vocabulary
- execution result vocabulary
- transition outcomes
- terminal outcomes
- await/resume behavior
- major failure paths
- major repair or retry paths
- code map file references

It does **not** need to mirror every helper or small refactor.

---

## When `flow.md` must be updated

A change SHOULD update `flow.md` if it changes any of the following.

### 1. New or removed major branch

Examples:

- a new validation failure path
- a retry branch added after tool failure
- a fallback branch added after child failure
- a repair-plan path introduced

If the behavior graph changed, `flow.md` must change.

### 2. New or renamed stage

If the agent introduces, removes, or renames a stage that matters for control flow, update:

- `### Stages`
- `## Flow table`
- `## Turn semantics` if needed

### 3. New or renamed normalized observation

If the agent now reasons over a new normalized observation kind, update:

- `### Normalized observations`
- `## Flow summary` if it affects main flow
- `## Branches and failure paths` if it introduces a new branch

### 4. New or renamed intent

If Policy can emit a new intent, update:

- `### Intents`
- `## Flow table`
- `## Flow summary` if it changes dominant behavior

### 5. New or changed execution result kind

If Transition now consumes new execution result categories, update:

- `### Execution result kinds`
- `## Flow table`
- `## Turn semantics` if await/resume behavior changes

### 6. Await/resume semantics changed

Examples:

- sync tool call becomes async
- child dispatch becomes blocking
- a second await stage is introduced
- resume conditions become stricter

This must update:

- `## Flow summary`
- `## Flow table`
- `## Turn semantics`

### 7. Terminal outcomes changed

Examples:

- agent can now complete with partial success
- a previously terminal failure becomes recoverable
- completion payload meaning changes materially

This must update:

- `### Terminal outcomes`
- `## Flow table`
- `## Branches and failure paths`

### 8. Code map no longer points to the right files

If files move or responsibilities shift, update `## Code map`.

---

## When `flow.md` usually does not need an update

These changes usually do **not** require a `flow.md` update unless they affect behavior:

- internal helper extraction
- logging changes
- variable renames
- formatting changes
- schema tightening that does not change the visible flow
- moving code between files when `Code map` remains correct
- performance improvements with no flow impact

The key test is:

> Would a new engineer need a different explanation of how the agent behaves?

If no, `flow.md` probably does not need to change.

---

## The easiest maintenance rule

When a PR touches any of these files, the author should at least check `flow.md`:

- `policy.ts`
- `transition.ts`
- `types.ts`
- `perception.ts`
- `learning.ts`
- `execution.ts`
- `normalizers/*`
- effect handlers under `effects/`

These files are the most likely to change behavior.

A simple team rule:

> If a PR changes behavioral modules, the PR author must confirm whether `flow.md` is still accurate.

That alone catches most drift.

---

## Recommended author workflow

### 1. Change behavior in code

Implement the change normally.

### 2. Re-read `flow.md`

Do not just skim it. Compare it against the behavior you changed.

Ask:

- Does the flow summary still describe the main path?
- Does the flow table still cover the major branches?
- Did I add or rename any stage, observation, intent, or result kind?
- Did await/resume behavior change?
- Did success/failure semantics change?

### 3. Update the minimal required sections

Only update the sections affected by the behavioral change.

Common examples:

- vocabulary changed -> update `State vocabulary`
- branch changed -> update `Flow table` and `Branches and failure paths`
- await behavior changed -> update `Flow summary` and `Turn semantics`
- files moved -> update `Code map`

### 4. Read `flow.md` as if you do not know the code

This is the best quality check.

If you opened only `flow.md`, would you understand the updated behavior correctly?

### 5. Ensure tests still match the described branches

`flow.md` and tests should tell the same story.

If the document says there is a branch, tests should usually cover it.

---

## Recommended reviewer workflow

A reviewer should treat `flow.md` as part of behavior review.

### Reviewer questions

1. Did this PR change the agent’s behavior over time?
2. If yes, was `flow.md` updated?
3. Does the flow table still match the actual control behavior?
4. Are new failure paths documented?
5. Does the vocabulary section match the code names exactly?
6. Does the code map still point to the right files?

A useful reviewer mindset is:

> Could someone understand this new behavior from `flow.md` without reverse-engineering the code?

If not, the document is incomplete.

---

## Strong signals that `flow.md` is stale

These are common drift symptoms.

### Signal 1: vocabulary mismatch

`flow.md` mentions intents, stages, or observations that no longer exist in code.

### Signal 2: missing branch

A branch exists in code but not in the flow table.

### Signal 3: wrong terminal behavior

The document says a path fails terminally, but code now retries or repairs.

### Signal 4: wrong await model

The document implies synchronous behavior, but code now suspends and resumes later.

### Signal 5: code map rot

The document points to files that no longer contain the described responsibility.

### Signal 6: tests and flow disagree

Tests cover a branch that the document never mentions, or the document claims a path that tests do not exercise.

---

## How to write updates efficiently

Do not rewrite the whole document for every change.

Most updates are small.

### Example: new failure branch

Update:

- `## Flow summary` if the branch is major
- `## Flow table`
- `## Branches and failure paths`

### Example: renamed intent

Update:

- `### Intents`
- any flow table rows using the old name
- branch descriptions if they use the old name

### Example: new await step

Update:

- `## Flow summary`
- `## Flow table`
- `## Turn semantics`
- `### Stages` if stage vocabulary changed

Keep updates focused.

---

## Recommended PR checklist item

Add this to the agent PR template:

```md
- [ ] I checked whether `flow.md` needs an update
- [ ] If behavior changed, I updated `flow.md`
- [ ] `flow.md` vocabulary matches the code names used in this PR
```

This is low-friction and highly effective.

---

## Recommended repository conventions

The following conventions reduce drift significantly.

### 1. Keep `flow.md` next to `agent.ts`

Recommended:

```txt
my-agent/
  agent.ts
  flow.md
  ...
```

This makes it visible during normal work.

### 2. Keep code names stable

If code vocabulary is noisy or unstable, `flow.md` will drift faster.

Stable names make the document easier to maintain.

### 3. Keep the `Code map` short and current

Do not try to map every file.
Only map the major behavioral files.

### 4. Use branch IDs

If `flow.md` uses `B1`, `B2`, `B3`, tests and reviews can reference them cleanly.

### 5. Prefer one major behavior story per agent

If an agent has too many unrelated stories, `flow.md` becomes hard to keep short and accurate.

---

## Good maintenance pattern

A healthy pattern looks like this:

1. behavior changes in code
2. author updates `flow.md`
3. reviewer checks behavior against `flow.md`
4. tests cover the updated branches
5. future readers trust the document

This creates a strong loop:

- code defines behavior
- `flow.md` explains behavior
- tests verify behavior

All three reinforce each other.

---

## Bad maintenance patterns

### 1. Write once, never update

This turns `flow.md` into fiction.

### 2. Over-document internals

If `flow.md` tries to mirror every helper, it becomes noisy and fragile.

### 3. Keep the vocabulary loose

If names in the doc do not match code exactly, drift becomes harder to detect.

### 4. Treat it as optional prose

Then nobody owns it.

### 5. Update only the prose summary

If the flow table or branch section stays stale, the document remains misleading.

---

## Minimal maintenance standard

If you want the smallest workable discipline, use this standard:

### Authors must:

- check `flow.md` whenever behavior changes
- update vocabulary when names change
- update the flow table when branches change
- update turn semantics when await/resume behavior changes
- update code map when files move

### Reviewers must:

- verify that major behavior changes are reflected in `flow.md`
- reject stale behavior descriptions

That minimum is enough to keep the document useful.

---

## Stronger standard for important agents

For high-value or complex agents, use a stronger rule:

- `flow.md` is required
- branch IDs are required
- tests should reference the documented branches
- PR template must include a `flow.md` check
- examples should include `flow.md`

This is especially valuable for:

- multi-turn agents
- child-agent orchestration
- LLM planning agents
- agents with repair/retry loops
- agents maintained by multiple teams

---

## Final rule of thumb

Use this simple question:

> If I gave only `flow.md` to a new engineer, would they correctly understand the current behavior of the agent?

If the answer is no, the document is out of sync.

---

## Final recommendation

`flow.md` stays accurate when it becomes part of the normal change loop:

- behavior change
- flow update
- review against flow
- tests aligned to flow

That is the right level of ceremony.

Not heavy.
Not optional.
Just enough discipline to preserve clarity over time.

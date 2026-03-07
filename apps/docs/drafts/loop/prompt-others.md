## 1) Turn Planner (minimal, 3-stage)

```text
Goal: <one sentence business goal>
Context: callagent + A-P-L-R-E-T + minimal 3-stage dispatcher (idle → awaiting_input → completed).

Produce a concise 2–4 turn plan (no code). For each turn include:
- Observation (env → Obs with { text?: string })
- Learning (ONLY writer of M; enforce sensory freshness: if no text, set sensory.current = undefined)
- Policy (pure M → WHAT; if fresh text → answer; else → prompt_user)
- Execution (effects; ctx.vars writes; Stage.setStage after invariants satisfied; save token before awaiting_input)
- Transition (await_input | continue | complete; include exact token lifecycle)
- Success criteria (explicit checks: reply sent, token set, stage moved, no stale sensory)

Constraints:
- Per-agent generics: define `type Sensory = { current?: string }`, `type Obs = { text?: string }`, and use `createAgent<Sensory, Obs>`.
- Stages: exactly 'idle' | 'awaiting_input' | 'completed' unless you prove more are essential.
- Do not roll sensory forward with `?? prev`.
- Prefer ts-pattern matching; Transition also uses ts-pattern.

End with:
- 3–5 risks (e.g., stale sensory, stage set before token)
- 6–8 golden-path assertions for tests.
```

---

## 2) Implementation Prompt (code + tests)

```text
Implement the agent per the approved plan (minimal 3-stage flow).

Requirements:
- Types: define `type Sensory = { current?: string }` and `type Obs = { text?: string }`; call `createAgent<Sensory, Obs>`.
- Stages & invariants: use `createStageFacade<Stage>` with
  awaiting_input: require token, forbid 'completed.called'
  completed: require 'completed.called'
  autoMarks: completed → { 'completed.called': true }
- Perception: read `env.inbox.current` (e.g., latest `{ source:'user' }` observation) to extract `{ text }` or `{}`.
- Learning: ONLY place writing M; enforce **sensory freshness** (if no new text, set undefined).
- Policy (pure): Policy reads only M (no env or ctx.vars). If fresh text → internal/answer_with_llm; else → ask_user.
- Execution: use **ts-pattern** with `.exhaustive()` on action kind (or on {stage,intent} if using full Intents). 
  - ask_user → reply + requestInput → save token → Stage.setStage(ctx, 'awaiting_input')
  - answer_with_llm → ctx.llm.call + replies → Stage.setStage(ctx, 'completed')
- Inputs/Tools/Subagent (optional; pick the minimal variant):
  - Tools (no await, 3-stage): `ctx.tools.invoke(name, args)` and continue in the same turn.
  - Tools (awaiting variant): `requestTool(...){ token }` → Transition `await_tool(token)` → on resume read `env.inbox.current` for the `{ source: 'tool', kind: 'tool.completed' }` observation.
  - Subagent (no await, 3-stage): `sendTaskToAgent(..., { awaitCompletion:false })` and continue in the same turn.
  - Subagent (awaiting variant): `sendTaskToAgent(...){ token }` → Transition `await_child(token)` → on resume read `env.inbox.current` for the `{ source: 'child', kind: 'child.completed' }` observation.
  - Caveat: if child requests input while parent awaited completion, switch to `awaitCompletion:false` and propagate `await_child`.
- Transition: **ts-pattern**; ask_user → await_input(token); internal done → complete; else → continue. Include tool/child awaits only if you used those variants.
- Shield: deterministic (veto > defer > transform > pass). Pass-through OK for now, but scaffold the API.
- Effects: call framework methods directly; only wrap non-framework async work in runEffect.
- No `any`. Use `type` aliases. Shallow control flow.

Deliverables:
1) Code (files/patches).
2) Short explanation of stages, invariants, and resume contract.
3) Tests (show snippets):
   - Golden path: prompt → await_input → respond → complete
   - **Sensory freshness:** after completion, a new turn with no input prompts (no stale text reuse)
   - Invariant enforcement: cannot enter awaiting_input without token; completed requires 'completed.called'
   - Policy purity unit test (depends only on M; no env/ctx.vars reads)
   - Transition mapping correctness
   - If tools awaiting used: tool action → await_tool(token) → resume with `env.inbox.current` containing a tool observation
   - If subagent awaiting used: subagent action → await_child(token) → resume with `env.inbox.current` containing a child observation
```

---

## 3) Shield Draft Prompt (budget/PII/HITL)

```text
Draft a Shield that mediates Policy → Execution with outcomes in priority order:
veto > defer > transform > pass.

Implement:
- Budget check: if estimated effect cost > m.reward.budget → { action:'defer', askUser:'Costs X (budget Y). Proceed?' }
- PII detection: veto or transform (sanitize) and log reason (brief note).
- HITL: for tool calls or sensitive actions, { action:'defer', askUser:'Approve <tool>?' }

Rules:
- Deterministic decisions (same input → same outcome).
- Return one: {action:'veto'|'defer'|'transform'|'pass', ...}
- Keep logic minimal for the current agent; it’s acceptable to `pass` by default but include stubs and TODOs.
```

---

## 4) External Effects Wrapper Prompt

```text
Audit external calls. For every non-framework async call, wrap with:

runEffect(() => /* async work */, { timeoutMs: 10000, maxRetries: 2, retryDelayMs: 800 })

Do NOT wrap: ctx.llm, ctx.reply, ctx.tools, ctx.requestInput (framework methods are already safe).

On error:
- Reply briefly to the user with a safe message.
- Keep handlers idempotent; set/clear tokens and stages carefully.
- (Optional) Use idempotency keys for critical side effects.

Show code diffs only for the calls you change.
```

---

## 5) Test Plan Prompt (have the LLM write tests)

```text
Write tests for this agent.

Must include:
1) Golden path:
   - Turn 1: no input → prompts, saves token, stage = 'awaiting_input'
   - Turn 2: input arrives → answers via LLM, stage = 'completed', complete outcome
2) Sensory freshness:
   - After a successful run, start a new turn with no input → agent prompts (does NOT reuse old text)
3) Invariants:
   - Entering 'awaiting_input' without token throws (or is prevented)
   - 'completed' requires 'completed.called' (autoMarks)
4) Policy purity:
   - Given M with/without `memory.sensory.current`, Policy returns the expected action; no env/ctx.vars usage
5) Transition mapping:
   - ask_user → await_input(token)
   - internal done → complete

Use your usual test harness; keep tests concise and readable.
```

---

## 6) Self-Review Checklist (paste after code)

```text
Run this checklist and correct anything missing:

[Design]
- Minimal stage set ('idle'|'awaiting_input'|'completed') unless extra stages are strictly necessary
- Per-agent generics present: createAgent<Sensory, Obs>
- Sensory freshness enforced (no `?? prev` roll-forward)
- Learning is the ONLY writer of M (immutable)
- Policy pure (M → WHAT), no env/ctx.vars reads
- Invariants satisfied BEFORE Stage.setStage
- ts-pattern used; Transition also uses ts-pattern
- (Optional) Typestate map present only if flow complexity warrants it

[Coding]
- No `any`; prefer `type`
- Shallow control flow; idempotent handlers
- Framework methods used directly; runEffect only for external calls

[Testing]
- Golden path passes
- Sensory freshness test passes (no stale inputs)
- Invariant tests pass
- Policy purity test passes
- Transition mapping test passes

[Docs-in-code]
- Brief comment on stages, resume behavior, and why sensory is fresh-per-turn
```

---

## 7) “Add One More Stage Later” (upgrade-path prompt, optional)

```text
We now need a planning hop. Add exactly one new stage: 'planning'.

Update:
- Stage facade invariants: planning forbids 'completed.called'
- Policy: when text is NOT a question, emit 'plan_and_execute' Intent
- Execution: exhaustive ts-pattern on {stage,intent}
  - {stage:'awaiting_input', intent:'plan_and_execute'} → Stage.setStage('planning') → set plan steps in ctx.vars → return { kind:'internal', done:true }
  - {stage:'planning', intent:P._} → Stage.setStage('executing') or return to awaiting_input if plan invalid
- Transition unchanged unless you add awaits

Keep minimality—only add what’s needed for this single extra stage. Maintain sensory freshness and all invariants.
```

---

## 8) PR Description Template (quick fill-in)

```text
**Summary**
- Minimal callagent agent using A-P-L-R-E-T with 3-stage dispatcher (idle → awaiting_input → completed).
- Learning-only writes to M with **sensory freshness** (no roll-forward).
- Policy pure: fresh text → answer; else → prompt_user.
- Execution uses ts-pattern; Transition uses ts-pattern; invariants enforced via createStageFacade.

**Stages & Invariants**
- awaiting_input requires token; completed requires 'completed.called' (autoMarks)

**Resume Contract**
- ask_user → await_input(token). On resume, Perception normalizes text; Learning sets fresh sensory; Policy decides.

**Safety**
- Shield scaffolded (pass-through for now); effects discipline: framework methods direct; external calls via runEffect (N/A/added).

**Tests**
- Golden path
- Sensory freshness
- Invariants
- Policy purity
- Transition mapping

**Notes**
- Kept minimal. No extra stages/fields unless required.
```
 
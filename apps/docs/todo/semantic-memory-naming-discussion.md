# Discussion: Semantic Memory Naming Collision in APLRET V2

## 1. Context

In the APLRET V2 architecture, there are two distinct mechanical concepts that represent "Semantic Memory" (facts and persistent knowledge):

1. **`ctx.semantic` (in `TaskContext`)**
   - **What it is:** The **asynchronous API facade** connected directly to the persistent database (e.g., PostgreSQL).
   - **Where it is used:** Only inside asynchronous modules (like `execution` or `learning` via the `MemoryWriter` / `MemoryReader`).
   - **Purpose:** Performing heavy I/O operations, such as dynamic database queries, vector similarity searches, and durable writes (`await ctx.semantic.add(...)`).

2. **`M.memory.longTerm.semantic` (in `MentalState`)**
   - **What it is:** The **synchronous, local JSON snapshot** of the agent's mind that is aggregated and serialized between turns.
   - **Where it is used:** Passed synchronously into the `policy`, `shield`, and `transition` modules.
   - **Purpose:** Acting as a high-speed, top-of-mind cache of specific facts retrieved from the database by the `learning` module, allowing `policy` to make instantaneous, deterministic decisions without blocking on database reads.

---

## 2. The Problem

Both the asynchronous database facade and the synchronous local cache share the exact same name: `semantic`. 

While they both deal with the psychological concept of "semantic memory", the mechanical realities of how they are used in the framework are fundamentally different. 

**This naming collision guarantees developer confusion during migration and daily usage:**
* Developers might mistakenly try to read/write `M.memory.longTerm.semantic` assuming it saves to the database.
* Developers might be confused about why they cannot perform dynamic queries on `M.memory.longTerm.semantic`.
* When discussing code or reviewing PRs, uttering "semantic memory" is ambiguous without heavily qualifying whether you mean the "Mental State snapshot" or the "PostgreSQL store".

The separation between the "State" (synchronous cache) and the "Store" (asynchronous DB) needs to be crystal clear.

---

## 3. Possible Solution Ideas

### Idea A: Explicit Storage Terminology (Rename the facade)
We could leave the psychological term (`semantic`) inside the `MentalState`, but append explicit technical terminology to the asynchronous API facade.
* Rename `ctx.semantic` -> `ctx.store.semantic`
* Rename `ctx.semantic` -> `ctx.db.semantic`

*Pros:* Maintains the psychological terminology inside the cognitive `MentalState`.
*Cons:* Still leaves ambiguity about whether `M.memory` contains all memories or just the actively retrieved subset.

### Idea B: Explicit Caching Terminology (Rename the Mental State snapshot)
We could explicitly denote that the `MentalState` property is merely a local cache or snapshot of the wider database.
* Rename `M.memory.longTerm.semantic` -> `M.memory.longTerm.semanticCache`
* Rename `M.memory.longTerm.semantic` -> `M.memory.longTerm.activeFacts`
* Rename `M.memory.longTerm.semantic` -> `M.memory.longTerm.internalizedKnowledge`

*Pros:* Makes it immediately obvious to developers that they are looking at a subset (cache) of data, not the full database.
*Cons:* `semanticCache` feels slightly overly-technical for a purely cognitive model.

### Idea C: Flattening Mental State (Remove "semantic" from M entirely)
Recognize that what we currently call `M.memory.longTerm.semantic` is really just the agent's current "working context" for a specific task. We can remove the "semantic/episodic/procedural" breakdown from the `MentalState` altogether, as the agent simply aggregates relevant facts into a scratchpad before making a decision.
* Remove `M.memory.longTerm.semantic` entirely.
* Replace it with `M.memory.workingContext` (for facts dynamically pulled from the semantic store by the `learning` module).
* Keep `M.memory.scratch` (for mid-task calculations).

*Pros:* Radically simplifies the `MentalState` model. Completely eliminates the naming collision by stripping the word "semantic" out of `MentalState` entirely. 
*Cons:* Loses the strict psychological taxonomy (semantic vs episodic vs procedural) inside the agent's active mind. 

---

## Feedback Requested
Which of these approaches feels the most intuitive for the V2 framework mechanics, or is there an alternative approach to resolving this naming ambiguity?

---

## ✅ Resolution (v2.6)

**Status: RESOLVED**

The naming collision was resolved by **consolidating `ctx.semantic` into `ctx.memory.semantic`**:

- `ctx.semantic` has been **removed** entirely from `TaskContext`.
- `ctx.memory.semantic` now exposes both the low-level adapter methods (`get/set/delete/read/remove`) and the high-level agent API (`add/readItems/removeItem`).
- `M.memory.longTerm.semantic` remains **unchanged**.

This approach is closest to **Idea A** — making the asynchronous store clearly distinct by nesting it under `ctx.memory.semantic`, while keeping the psychological term in `MentalState`.

See: `apps/docs/migration/2.6-ctx-memory-semantic-migration.md`


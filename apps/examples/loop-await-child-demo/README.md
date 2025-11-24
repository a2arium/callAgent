# Loop Await Child Demo

This minimal example reproduces the `await_child` inbox regression. The parent agent
dispatches a cached child agent with `awaitCompletion: false` and expects the
child's completion payload to appear in `env.inbox.current` on the next turn.

## Turn Counter Reset Bug Reproduction

This demo also includes a test script to reproduce the **turn counter reset bug**:

**Bug Description:** When a parent agent resumes after `await_child`, the turn counter
resets to 1 instead of continuing from where it left off (e.g., Turn 3 -> Turn 1 instead of Turn 3 -> Turn 4).

**To reproduce the bug:**

```bash
cd apps/examples/loop-await-child-demo
yarn test:turn-reset
```

The test script will:
1. Start a parent task that dispatches a child agent
2. Track turn numbers from snapshots before/after child completion
3. Detect if the turn counter resets instead of incrementing
4. Report the bug if detected

**Expected behavior:**
- Turn numbers should increment: 1 -> 2 -> 3 -> 4 -> ...
- After `await_child`, next turn should be N+1, not 1

**Actual behavior (bug):**
- Turn counter resets to 1 after `await_child` resume
- This breaks `maxTurns` enforcement and observability
- Logs show confusing turn sequences

## Original Demo

Steps:

1. `ParentAgent` loads a URL from task input. If no HTML is present in its
   working memory it calls the cached `ChildAgent` with `awaitCompletion: false`.
2. The child immediately returns a large HTML payload (either from cache or by
   synthesising it) and the parent transitions with `{ kind: 'await_child' }`.
3. On the resume turn the parent expects to find a `child.completed` observation
   in `env.inbox.current`. Prior to the runtime fix this inbox was empty,
   proving the regression.

To run the parent agent after building:

```bash
yarn workspace loop-await-child-demo build
yarn callagent run apps/examples/loop-await-child-demo/dist/LoopAwaitChildDemoParentAgent.js '{"url":"https://example.com/demo"}'
```

Run the command twice to ensure the child result is served from cache on the
second attempt. The parent logs both inbox contents and the observed HTML
status so it is easy to verify the bug and the eventual fix.


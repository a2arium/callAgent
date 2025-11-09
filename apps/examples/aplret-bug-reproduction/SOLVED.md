# BUG SOLVED: Duplicate runLoop Calls

## The Root Cause

**`runLoop` is being called TWICE for the same task (`local-task-176263946`)**:

1. **First call** (`zvtrf6`):
   - Starts with empty M
   - Learning adds `testCounter` and `testMode`
   - Execution adds `apiTest`, `child`, `stage`
   - Completes successfully with **5 vars**

2. **Second call** (`yfu9xb`):
   - Starts with partial M (only 3 vars: `child`, `stage`, `apiTest`)
   - **Missing** `testCounter` and `testMode`!
   - Runs 10 turns in infinite loop
   - Budget exceeded

## Evidence

```
[runLoop local-task-176263946/zvtrf6] ENTRY
[runLoop local-task-176263946/zvtrf6] AFTER oneTurn turn=0: ['testCounter', 'testMode', 'apiTest', 'child', 'stage']

[runLoop local-task-176263946/yfu9xb] ENTRY  ← DUPLICATE!
[runLoop local-task-176263946/yfu9xb] BEFORE oneTurn turn=0: ['child', 'stage', 'apiTest']  ← PARTIAL!
```

## Why Vars Are Lost

The second `runLoop` call loads a snapshot that was saved DURING the first `runLoop` execution (likely after Execution but before Learning's M was merged).

**Timeline**:
1. First runLoop: oneTurn runs → Learning produces M with 5 vars
2. **TaskEngine saves partial snapshot** (only ctx.vars, missing Learning's vars)
3. Second runLoop: loads partial snapshot → only 3 vars
4. Infinite loop (missing `testMode`)

## The Missing Link: Why 2 Calls?

The TaskEngine must be calling `runLoop` twice:
1. Once for the initial task execution
2. Once after A2A child completes (resume)

**But why doesn't the second call see all 5 vars?**

→ **Bug #1G's "meta-save" path is saving a partial snapshot!**

From `taskEngine.ts` line ~1400:
```typescript
// ✅ FIX Bug #1G: Use mergeVarsIntoMental
let mNextEffective = this.mergeVarsIntoMental(M as any, mNext as any);
const next = { ...baseNow, M: mNextEffective, meta: nextMeta, inbox: nextInbox };
await this.sessionManager.saveSnapshot(...);
```

But there's ANOTHER save path that's NOT using `mergeVarsIntoMental`!

## Solution

Find ALL `sessionManager.saveSnapshot()` calls in `taskEngine.ts` and ensure they ALL use `mergeVarsIntoMental` to properly combine Learning's vars with ctx.vars.

## Next Step

1. Search for `await this.sessionManager.saveSnapshot` in `taskEngine.ts`
2. Identify which call is saving the partial snapshot (the one between first and second runLoop)
3. Fix it to use `mergeVarsIntoMental`

## Expected Fix Location

Look for `saveSnapshot` calls in:
- `handleChildCompleted` (after A2A resume) ← Most likely!
- `startTask` (normal execution)
- `flushContextSnapshot` (periodic saves)

My bet: `handleChildCompleted` at line ~2186 is saving a partial snapshot right after the first runLoop completes.


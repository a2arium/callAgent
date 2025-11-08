# Implementation Summary: Bug Fixes for Memory Persistence

## Overview

During the implementation and testing of fixes for Bug #1 and Bug #2, I discovered **FOUR separate but related bugs** in the framework:

## Bugs Discovered & Fixed

### Bug #1A: `attachWorkingMemory()` Started with Empty Cache (FIXED ✅)
**Location:** `taskEngine.ts:147-189`

**Problem:** 
```typescript
const varCache = new Map<string, unknown>(); // ❌ Always empty!
```

**Fix:**
```typescript
const snapshot = await this.sessionManager.load(tenantId, sessionId);
const M = (snapshot?.snapshot as any)?.M;
const currentVars = ((M?.memory as any)?.vars || {}) as Record<string, unknown>;
const varCache = new Map<string, unknown>(Object.entries(currentVars)); // ✅ Loaded!
```

### Bug #1B: `handleChildCompleted()` Missing `attachWorkingMemory` Call (FIXED ✅)
**Location:** `taskEngine.ts:2167`

**Problem:** Parent agents resuming after A2A had no `ctx.vars` proxy set up.

**Fix:** Added before runLoop:
```typescript
await this.attachWorkingMemory(ctx, tenantId, parentTaskId, agentName || 'default');
```

### Bug #1C: `handleChildCompleted()` Didn't Merge Vars Before Saving (FIXED ✅)
**Location:** `taskEngine.ts:2236`

**Problem:** Snapshot save didn't call `mergeVarsIntoMental`.

**Fix:**
```typescript
const mNextWithVars = this.mergeVarsIntoMental(M as any, mNext as any);
const nextSnap = { ...baseSnap, M: mNextWithVars, ...};
```

### Bug #1D: `mergeVarsIntoMental()` Was Overwriting Instead of Merging (FIXED ✅)
**Location:** `taskEngine.ts:118-136`

**Problem:** 
```typescript
vars: { ...(latestVars as Record<string, unknown>) } // ❌ OVERWRITES!
```

**Fix:**
```typescript
vars: { ...(targetVars as Record<string, unknown>), ...(sourceVars as Record<string, unknown>) } // ✅ MERGES!
```

**Explanation:** 
- `target` (mNext) has Learning's changes to M.memory.vars
- `source` (M) has ctx.vars changes via assignVarsIntoMental
- Need to merge BOTH, not overwrite target with source

### Bug #2: Multiple A2A Calls Not Supported (FIXED ✅)
**Location:** `taskEngine.ts:96-107`

**Problem:** No SessionManager configured in CLI mode, causing A2A to fail.

**Fix:** Created `InMemorySessionManager` and made it the default:
```typescript
if (!opts?.sessionStore) {
    console.warn('[TaskEngine] No SessionStore configured - using IN-MEMORY mode');
    console.warn('[TaskEngine] ⚠️  IN-MEMORY MODE IS NOT SUITABLE FOR PRODUCTION');
    this.sessionManager = new SessionManager(new InMemorySessionManager());
}
```

## Remaining Issue (CRITICAL)

### Bug #1E: Learning's M.memory.vars Not Persisting Through runLoop ⚠️

**Evidence:**
```
[Learning] Initial setup - Writing to M.memory.vars: { testCounter: 1, testMode: 'test-a2a' }
[Policy] M.memory.vars: { testCounter: 1, testMode: 'test-a2a' } // ✅ Visible in Policy!

[TaskEngine] mergeVarsIntoMental: { sourceVars: [], targetVars: [], merged: [] } // ❌ LOST!
```

**Problem:**
Learning creates a NEW MentalState with updated memory.vars and returns it. This M should propagate through the loop and be returned as mNext by runLoop. But mergeVarsIntoMental sees EMPTY vars in both M and mNext!

**Root Cause (Suspected):**
The M that Learning returns might not be properly threaded through oneTurn/runLoop. Possible issues:
1. oneTurn discards Learning's M and uses a different M object
2. runLoop doesn't return the final M from Learning
3. There's a mismatch between what Learning returns and what runLoop uses

**Impact:**
- Vars written by Learning to M.memory.vars are LOST at end of turn
- Only vars written via ctx.vars (Execution) persist
- This breaks APLRET architecture where Learning is the single writer of M

**Next Steps:**
Need to trace through `runLoop` and `oneTurn` to see how Learning's returned M is handled. The fix is likely in `packages/core/src/loop/loopRunner.ts` or `packages/core/src/loop/oneTurn.ts`.

## Test Results

### Bug #1 (Vars Persistence) - PARTIAL ✅
- **Test:** `test-vars` mode
- **Status:** PASSES when writing to ctx.vars
- **Issue:** Fails when writing directly to M.memory.vars (Bug #1E)

### Bug #2 (Multiple A2A) - BLOCKED ⚠️
- **Test:** `test-a2a` mode  
- **Status:** BLOCKED by Bug #1E
- **Reason:** testMode lost during first turn, can't proceed to test second A2A call

## Files Modified

1. **`packages/core/src/core/orchestration/InMemorySessionManager.ts`** - NEW
2. **`packages/core/src/core/orchestration/taskEngine.ts`** - MODIFIED
   - Constructor: Default to InMemorySessionManager
   - `attachWorkingMemory`: Made async, load vars from snapshot
   - `mergeVarsIntoMental`: Fixed to merge instead of overwrite
   - `handleChildCompleted`: Added attachWorkingMemory call and mergeVarsIntoMental call
3. **`packages/core/src/core/orchestration/A2AService.ts`** - MODIFIED
   - Made all `attachWorkingMemory` calls async (3 locations)
4. **`apps/examples/aplret-bug-reproduction/BugReproAgent.ts`** - MODIFIED
   - Fixed ctx.vars access to use property syntax instead of .get()/.set()

## Next Action Required

**CRITICAL:** Fix Bug #1E by ensuring Learning's M.memory.vars propagates through runLoop.

**Files to investigate:**
- `packages/core/src/loop/loopRunner.ts`
- `packages/core/src/loop/oneTurn.ts`

**Expected behavior:**
When Learning returns `MentalState` with `memory.vars = {testCounter: 1, testMode: 'test-a2a'}`, this EXACT M should be returned by runLoop as mNext, so that mergeVarsIntoMental can see these vars and save them to the snapshot.


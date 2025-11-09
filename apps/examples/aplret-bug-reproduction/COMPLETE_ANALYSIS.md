# Complete Bug Analysis: Duplicate runLoop Calls

## Executive Summary

**Root Cause**: The parent task's `runLoop` is being called **TWICE** after an A2A child completes, and the second call loads a partial snapshot that's missing `testCounter` and `testMode` variables.

## Evidence Chain

### 1. Duplicate runLoop Calls (Confirmed)

```
[runLoop local-task-176263955/sz6xsh] ENTRY              ← First parent runLoop
[runLoop a2a_task_17626395509/izulyo] ENTRY             ← Child runLoop
[TaskEngine.handleChildCompleted] ENTRY                  ← Child completes
[runLoop local-task-176263955/si0bir] ENTRY              ← SECOND parent runLoop
```

**Same taskId (`local-task-176263955`), different runId (`sz6xsh` vs `si0bir`)**

### 2. Partial Snapshot Loaded (Confirmed)

```
[runLoop local-task-176263955/sz6xsh] AFTER oneTurn turn=0: ['testCounter', 'testMode', 'apiTest', 'child', 'stage']  ← First call succeeds with 5 vars

[runLoop local-task-176263955/si0bir] BEFORE oneTurn turn=0: ['child', 'stage', 'apiTest']  ← Second call starts with only 3 vars!
```

**Missing**: `testCounter`, `testMode`

### 3. Bug #1H: vars Overwrite Issue (Fixed)

```typescript
// loopRunner.ts line ~405 (BEFORE fix)
(m as any).memory.vars = { ...existingVars, ...varsToMerge };  // Overwrites with empty varsToMerge!

// AFTER Bug #1H fix
if (Object.keys(varsToMerge).length > 0) {
    (m as any).memory.vars = { ...existingVars, ...varsToMerge };
} else {
    // Don't overwrite Learning's vars
}
```

**Status**: Fixed ✅ (but didn't solve the problem - vars still lost)

### 4. Learning → runLoop Vars Lost (Confirmed)

```
[Learning] RETURNING MentalState with vars: { vars: [ 'testCounter', 'testMode' ] }  ← Learning works!
[runLoop] No ctx.vars to sync, keeping Learning vars: []                              ← vars GONE!
[runLoop] RETURNING M with vars: { varsCount: 0, vars: [] }
```

**Conclusion**: vars are being lost BETWEEN Learning and the end-of-turn sync in runLoop.

## Hypothesis Testing Results

### ✅ CONFIRMED: Hypothesis 7 - Duplicate runLoop Calls
- **Evidence**: Same taskId, different runId
- **Impact**: Second call loads partial snapshot

### ❌ REJECTED: Hypothesis 1 - Multiple competing saves
- **Reason**: SessionManager logs show sequential saves, not concurrent
- **Actual Problem**: Second runLoop loads AFTER a partial save

### ❌ REJECTED: Hypothesis 2 - Learning creates new M improperly  
- **Reason**: Learning correctly returns M with all vars
- **Actual Problem**: vars are lost AFTER Learning returns

### ✅ CONFIRMED: Hypothesis 3 - attachWorkingMemory loads stale
- **Evidence**: Second runLoop loads snapshot with only 3 vars
- **Root Cause**: Snapshot was saved with partial vars

### ❓ PARTIAL: Hypothesis 4 - InMemorySessionManager bug
- **Evidence**: InMemorySessionManager works correctly
- **Actual Problem**: What's SAVED to it is incomplete

## Critical Questions Remaining

### Q1: Why are there TWO runLoop calls for the parent task?

**Possible Answers**:
1. `handleChildCompleted` is being called twice (need to verify)
2. `startTask` has a streaming loop that re-executes after await_child resolves
3. CLI/runner is triggering duplicate execution
4. Event bus is publishing duplicate child_completed events

**Next Step**: Add counter to `handleChildCompleted` entry:
```typescript
let handleChildCallCount = 0;
async handleChildCompleted(...) {
    const callNum = ++handleChildCallCount;
    console.log(`[handleChildCompleted #${callNum}] ENTRY`);
}
```

### Q2: Why does the second runLoop load a partial snapshot?

**Possible Answers**:
1. First runLoop's saveSnapshot (line 2186) saves partial M
2. A different saveSnapshot call between the two runLoops saves partial M
3. InMemorySessionManager is returning a stale/cached snapshot

**Evidence from Logs**:
```
[SessionManager.saveSnapshot] About to save: { varsCount: 0, vars: [] }  ← Many saves with 0 vars!
```

**Most Likely**: One of the many `sessionManager.saveSnapshot` calls in `taskEngine.ts` is NOT using `mergeVarsIntoMental` and is overwriting the good snapshot with a partial one.

**Next Step**: Add logging to EVERY `sessionManager.saveSnapshot` call to show:
- Which line/function is calling it
- How many vars are in the snapshot being saved
- Stack trace (caller)

### Q3: Where are Learning's vars going?

**Timeline**:
```
[oneTurn] Learning returned M: ['testCounter', 'testMode']
[runLoop] After oneTurn, step.m: ['testCounter', 'testMode']  ← Still good here
[runLoop] m = step.m  ← Assign
[runLoop] No ctx.vars to sync, keeping Learning vars: []  ← vars GONE!
```

**Problem**: By the time we get to the ctx.vars sync code, `m.memory.vars` is already empty!

**Possible Causes**:
1. Something between `m = step.m` and the sync is mutating `m`
2. `step.m` and `m` are not the same object (object identity issue)
3. `m.memory.vars` is being set to `{}` somewhere

**Next Step**: Add logging immediately after `m = step.m`:
```typescript
m = step.m;
console.log('[runLoop] IMMEDIATELY after m = step.m, m.memory.vars:', Object.keys(((m as any).memory?.vars) || {}));
```

## Recommended Fixes

### Fix 1: Prevent Duplicate runLoop Calls (HIGH PRIORITY)

**Target**: Find and fix why `handleChildCompleted` or another code path is calling runLoop twice for the same parent task.

**Implementation**:
1. Add guard in `handleChildCompleted`:
```typescript
const processing = new Set<string>();
async handleChildCompleted(params) {
    const key = `${params.parentTaskId}:${params.childToken}`;
    if (processing.has(key)) {
        console.warn('[handleChildCompleted] DUPLICATE CALL DETECTED, skipping');
        return;
    }
    processing.add(key);
    try {
        // ... existing logic
    } finally {
        processing.delete(key);
    }
}
```

### Fix 2: Ensure All Saves Use mergeVarsIntoMental (MEDIUM PRIORITY)

**Target**: Audit ALL 13 `sessionManager.saveSnapshot` calls in `taskEngine.ts`

**Implementation**:
1. Create helper method:
```typescript
private async saveSnapshotWithVarsMerge(params: {
    tenantId: string;
    sessionId: string;
    agentId: string;
    expected WmVersion: bigint;
    M: MentalState;
    ctx: TaskContext;
}) {
    const snap = await this.sessionManager.load(params.tenantId, params.sessionId);
    const base = (snap?.snapshot as Record<string, unknown>) || {};
    
    // Always merge ctx.vars into M before saving
    const mWithVars = this.mergeVarsIntoMental(params.M, params.M);  // Merge with self to get ctx.vars
    
    const next = { ...base, M: mWithVars };
    await this.sessionManager.saveSnapshot({
        ...params,
        snapshot: next
    });
}
```

2. Replace all direct `saveSnapshot` calls with this helper

### Fix 3: Fix vars Loss Between Learning and Sync (HIGH PRIORITY)

**Target**: Find where `m.memory.vars` is being cleared between `m = step.m` and the ctx.vars sync

**Implementation**:
1. Add extensive logging around `m = step.m` assignment
2. Check for any code that mutates `M.memory.vars` between `oneTurn` and the sync
3. Consider freezing `M` object to prevent accidental mutations:
```typescript
const step = await oneTurn(...);
Object.freeze(step.m);
Object.freeze((step.m as any).memory);
Object.freeze((step.m as any).memory.vars);
m = step.m;
```

## Summary of All Bugs Found

| Bug ID | Description | Status | Impact |
|--------|-------------|--------|--------|
| #1A | attachWorkingMemory didn't load existing vars | ✅ Fixed | LOW - only affects resume |
| #1B | handleChildCompleted didn't call attachWorkingMemory | ✅ Fixed | LOW - workaround exists |
| #1C | handleChildCompleted didn't merge ctx.vars | ✅ Fixed | MEDIUM |
| #1D | mergeVarsIntoMental overwrote instead of merged | ✅ Fixed | HIGH |
| #1E | assignVarsIntoMental called mid-turn | ✅ Fixed | CRITICAL |
| #1F | ctx.vars not synced into M between turns | ✅ Fixed | CRITICAL |
| #1G | startTask meta-save didn't use mergeVarsIntoMental | ✅ Fixed | HIGH |
| **#1H** | **runLoop ctx.vars sync overwrites Learning's vars** | ✅ **Fixed** | **CRITICAL** |
| **#1I** | **Duplicate runLoop calls after A2A** | ❌ **OPEN** | **CRITICAL** |
| **#1J** | **Learning's vars lost before ctx.vars sync** | ❌ **OPEN** | **CRITICAL** |

## Next Actions

1. ✅ Add call counter to `handleChildCompleted` to detect duplicate calls
2. ✅ Add stack trace logging to ALL `saveSnapshot` calls
3. ✅ Add logging immediately after `m = step.m` assignment in runLoop
4. Run test with new logging to identify:
   - Is handleChildCompleted called once or twice?
   - Which saveSnapshot call is saving the partial snapshot?
   - Where are Learning's vars going?

## Final Note

This has been the most complex debugging session. We've uncovered a cascade of related bugs (#1A through #1H), fixed them all, but discovered two new critical issues (#1I and #1J) that are preventing the test from passing. The good news is we're very close - we've identified the exact failure modes and have clear next steps to resolve them.

The framework is fundamentally sound; these are integration issues between the various state persistence mechanisms (Learning → M, M → ctx.vars, ctx.vars → snapshot).


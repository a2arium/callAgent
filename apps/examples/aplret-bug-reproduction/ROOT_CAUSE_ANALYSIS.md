# Root Cause Analysis: test-api Infinite Loop

## Problem
After an A2A call completes and the parent agent resumes, `testMode` and `testCounter` are lost from `M.memory.vars`, causing the agent to enter an infinite loop.

## Evidence from Logs

### Before A2A Call (Turn 0):
```
[Learning] Initial setup - Writing to M.memory.vars: { testCounter: 1, testMode: 'test-api' }
[runLoop] AFTER oneTurn, step.m.memory.vars: [ 'testCounter', 'testMode', 'apiTest', 'child', 'stage' ]
[runLoop] Synced ctx.vars into m.memory.vars: [ 'apiTest', 'child', 'stage' ] {
[runLoop] After sync, m.memory.vars: [ 'testCounter', 'testMode', 'apiTest', 'child', 'stage' ]
[TaskEngine] AFTER runLoop, mNext.memory.vars: [ 'testCounter', 'testMode', 'apiTest', 'child', 'stage' ]
[TaskEngine] AFTER runLoop, M.memory.vars: [ 'apiTest', 'child', 'stage' ]
```

**Key Observation**: `mNext` has all 5 vars, but `M` only has 3 vars!

### Merge Process:
```
[TaskEngine] mergeVarsIntoMental: {
  sourceVars: [ 'apiTest', 'child', 'stage' ],
  targetVars: [ 'testCounter', 'testMode', 'apiTest', 'child', 'stage' ],
  merged: [ 'testCounter', 'testMode', 'apiTest', 'child', 'stage' ]
}
```

The merge correctly combines both, resulting in 5 vars.

### After Resume:
```
[TaskEngine] attachWorkingMemory: M.memory.vars= {"child":{"token":"..."},"stage":"awaiting_api_test","apiTest":"before"}
```

**Only 3 vars are loaded!** `testMode` and `testCounter` are missing.

## Root Cause

The issue is in **how the snapshot is saved**. There are TWO paths:

### Path 1: Initial startTask (lines 1324-1335)
```typescript
let mNextWithVars = this.mergeVarsIntoMental(M as any, mNext as any);
const nextAfterStart = { ...baseAfterStart, M: mNextWithVars, meta: nextMetaAfterStart, inbox: nextInboxAfterStart };
await this.sessionManager.saveSnapshot({...});
```

This path correctly uses `mNextWithVars` (the merged result with all 5 vars).

### Path 2: flushContextSnapshot (lines 1365-1389)
```typescript
let mNextWithVars = this.mergeVarsIntoMental(M as any, mNext as any);
// ...hygiene...
const next = { ...base, M: mNext }; // ❌ BUG: Uses mNext, not mNextWithVars!
await this.sessionManager!.saveSnapshot({...});
```

**This is the bug!** Line 1389 saves `M: mNext` instead of `M: mNextWithVars`.

So:
- `mNextWithVars` has the merged 5 vars
- But the snapshot is saved with `mNext` which only has 3 vars (from `ctx.vars` proxy)
- When the agent resumes, it loads the snapshot with only 3 vars
- `testMode` and `testCounter` (added by Learning) are lost

## Solution

Change line 1389 in `taskEngine.ts` from:
```typescript
const next = { ...base, M: mNext } as Record<string, unknown>;
```

To:
```typescript
const next = { ...base, M: mNextWithVars } as Record<string, unknown>;
```

This ensures the snapshot includes the merged vars from both Learning (`mNext`) and Execution (`M`/`ctx.vars`).

## Why This Matters

This is a **critical framework bug** that causes:
1. Loss of agent state after A2A calls
2. Infinite loops when agents rely on state that was set before the A2A call
3. Unpredictable behavior in multi-turn A2A workflows

The bug affects ANY agent that:
- Sets vars in Learning module
- Then makes an A2A call
- And expects those vars to persist after the child completes

## Testing the Fix

After applying the fix:
1. `testMode` and `testCounter` should persist across A2A boundaries
2. The wait handler should correctly detect the child completion
3. The API test should execute and pass


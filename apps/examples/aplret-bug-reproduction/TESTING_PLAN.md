# Testing Plan: Diagnose Vars Loss After A2A

## Executive Summary

Created 6 diverse hypotheses for why `testMode` and `testCounter` are lost after A2A resume. This document provides a step-by-step plan to systematically test each hypothesis.

## Pre-Test Checklist

✅ Bug reproduction agent with test-api mode created  
✅ Framework fixes applied (Bug #1A-F)  
✅ Core package built with latest changes  
❌ Vars still being lost - need to diagnose why

## Testing Sequence

### Phase 1: Quick Diagnostics (5 minutes)

**Add logging to InMemorySessionManager** to see save/load patterns:

```typescript
// In packages/core/src/core/orchestration/InMemorySessionManager.ts

// In saveSnapshot():
console.log('[InMemorySessionManager] SAVE:', {
    sessionId: sessionId.substring(0, 20) + '...',
    varsCount: Object.keys(((snapshot as any)?.M?.memory?.vars) || {}).length,
    vars: Object.keys(((snapshot as any)?.M?.memory?.vars) || {}),
    wmVersion: expectedWmVersion.toString()
});

// In load():
console.log('[InMemorySessionManager] LOAD:', {
    sessionId: sessionId.substring(0, 20) + '...',
    varsCount: Object.keys(((stored?.snapshot as any)?.M?.memory?.vars) || {}).length,
    vars: Object.keys(((stored?.snapshot as any)?.M?.memory?.vars) || {}),
    wmVersion: stored?.wmVersion.toString()
});
```

**Expected Results:**
- If SAVE shows 5 vars but LOAD shows 3 → InMemorySessionManager bug (Hypothesis 4)
- If SAVE shows 3 vars → Problem is before save (Hypothesis 1, 5, or 6)

### Phase 2: Test Hypothesis 3 - Stale Snapshot Load (10 minutes)

**Most Likely Cause** - Easy to test and fix.

Add logging in `attachWorkingMemory`:

```typescript
// Line 179 in taskEngine.ts
const snapshot = await this.sessionManager.load(tenantId, sessionId);
console.log('[attachWorkingMemory] DETAILED LOAD:', {
    sessionId: sessionId.substring(0, 20) + '...',
    snapshotExists: !!snapshot,
    wmVersion: snapshot?.wmVersion?.toString(),
    varsInM: Object.keys(((snapshot?.snapshot as any)?.M?.memory?.vars) || {}),
    varsFullData: JSON.stringify(((snapshot?.snapshot as any)?.M?.memory?.vars) || {}, null, 2)
});
```

**Run test:**
```bash
cd /Users/maximantonov/Work/_lab/callagent
node --import tsx packages/core/src/runner/runnerCli.ts \
  apps/examples/aplret-bug-reproduction/dist/BugReproAgent.js \
  '{"testMode":"test-api"}' 2>&1 | grep -E "(SAVE|LOAD|attachWorkingMemory)"
```

**Interpretation:**
- If attached vars ≠ saved vars → Hypothesis 3 CONFIRMED
- If attached vars = saved vars → Hypothesis 3 REJECTED, move to Phase 3

### Phase 3: Test Hypothesis 1 - Multiple Saves (15 minutes)

Track ALL saves with stack traces to see if overwriting occurs.

**Add to every saveSnapshot call:**
```typescript
console.log('[SAVE AUDIT]', {
    location: new Error().stack?.split('\n')[2],
    sessionId: sessionId.substring(0, 15),
    vars: Object.keys(((snapshot as any)?.M?.memory?.vars) || {}),
    timestamp: Date.now()
});
```

**Run test and analyze:**
```bash
node --import tsx packages/core/src/runner/runnerCli.ts \
  apps/examples/aplret-bug-reproduction/dist/BugReproAgent.js \
  '{"testMode":"test-api"}' 2>&1 | grep "SAVE AUDIT" | tail -20
```

**Interpretation:**
- Multiple saves for same session with decreasing var count → Hypothesis 1 CONFIRMED
- All saves show consistent var count → Hypothesis 1 REJECTED

### Phase 4: Test Hypothesis 5 - Hygiene Pruning (5 minutes)

Check if `pruneMentalState` removes vars.

**Add around line 1372:**
```typescript
const varsBeforePrune = JSON.stringify(((mNext as any)?.memory?.vars) || {});
try {
    const { pruneMentalState } = await import('../../loop/hygiene.js');
    pruneMentalState(mNext);
} catch { /* noop */ }
const varsAfterPrune = JSON.stringify(((mNext as any)?.memory?.vars) || {});

if (varsBeforePrune !== varsAfterPrune) {
    console.log('[HYGIENE CHANGED VARS]:', {
        before: Object.keys(JSON.parse(varsBeforePrune)),
        after: Object.keys(JSON.parse(varsAfterPrune)),
        removed: Object.keys(JSON.parse(varsBeforePrune)).filter(
            k => !Object.keys(JSON.parse(varsAfterPrune)).includes(k)
        )
    });
}
```

**Interpretation:**
- If vars disappear → Hypothesis 5 CONFIRMED, check hygiene.ts
- If vars unchanged → Hypothesis 5 REJECTED

### Phase 5: Test Hypothesis 4 - InMemorySessionManager Bug (20 minutes)

Test if the manager has reference issues or serialization bugs.

**Replace InMemorySessionManager save logic:**
```typescript
async saveSnapshot(params: SaveSnapshotParams): Promise<void> {
    const { tenantId, sessionId, agentId, expectedWmVersion, snapshot } = params;
    const key = `${tenantId}:${sessionId}`;
    
    const current = this.snapshots.get(key);
    if (current && current.wmVersion !== expectedWmVersion) {
        throw new Error('CAS_MISMATCH');
    }
    
    // Deep clone to avoid reference issues
    const clonedSnapshot = JSON.parse(JSON.stringify(snapshot));
    const varsInOriginal = Object.keys(((snapshot as any)?.M?.memory?.vars) || {});
    const varsInClone = Object.keys(((clonedSnapshot as any)?.M?.memory?.vars) || {});
    
    console.log('[InMemorySessionManager] CLONE CHECK:', {
        originalVars: varsInOriginal,
        clonedVars: varsInClone,
        match: JSON.stringify(varsInOriginal) === JSON.stringify(varsInClone)
    });
    
    this.snapshots.set(key, {
        snapshot: clonedSnapshot, // Use clone
        wmVersion: expectedWmVersion + BigInt(1)
    });
}
```

**Interpretation:**
- If cloning reveals differences or test now passes → Hypothesis 4 CONFIRMED
- If problem persists → Hypothesis 4 REJECTED

### Phase 6: Test Hypothesis 6 - handleChildCompleted Issues (30 minutes)

Most complex - trace the entire resume flow.

**Add comprehensive logging:**
```typescript
// Around line 2278 in handleChildCompleted
const snapNow = await this.sessionManager!.load(tenantId, parentTaskId);
console.log('[handleChildCompleted] STEP 1 - Loaded snapshot:', {
    parentTaskId,
    wmVersion: snapNow?.wmVersion?.toString(),
    varsInSnapshot: Object.keys(((snapNow?.snapshot as any)?.M?.memory?.vars) || {})
});

let M: MentalState = (baseNow as any).M as MentalState || initialM(ctx);
console.log('[handleChildCompleted] STEP 2 - M initialized:', {
    varsInM: Object.keys(((M as any)?.memory?.vars) || {})
});

await this.attachWorkingMemory(ctx, tenantId, parentTaskId, agentName || 'default');
console.log('[handleChildCompleted] STEP 3 - After attachWorkingMemory:', {
    ctxVarsKeys: (ctx as any).vars?.keys?.() || [],
    MVarsKeys: Object.keys(((M as any)?.memory?.vars) || {})
});

// After runLoop
console.log('[handleChildCompleted] STEP 4 - After runLoop:', {
    mNextVars: Object.keys(((mNext as any)?.memory?.vars) || {}),
    MVars: Object.keys(((M as any)?.memory?.vars) || {})
});
```

**Interpretation:**
- Trace where vars are lost in the sequence
- If lost at a specific step → investigate that step

## Quick Win: Most Likely Fix

Based on evidence, **Hypothesis 3** (stale snapshot load) is most likely. 

**Quick Test:**
```bash
# Add one line in attachWorkingMemory and test
grep -n "attachWorkingMemory.*Loaded vars from snapshot" \
  packages/core/src/core/orchestration/taskEngine.ts
```

If the loaded snapshot has only 3 vars, the problem is what was saved, not how it's loaded.

## Success Criteria

Test passes when:
```
[Bug #3] AFTER A2A - ctx.vars.get(): before
[Bug #3] AFTER A2A - ctx.vars.has(): true  
[Bug #3] AFTER A2A - ctx.vars.keys(): ['apiTest', 'child', 'stage']
[Bug #3] ✅ ALL API METHODS WORK AFTER A2A RESUME!
[Policy] Turn 1, TestCounter 1, Mode: test-api  ← These should be present!
```

## Time Estimates

- Phase 1: 5 min
- Phase 2: 10 min  
- Phase 3: 15 min
- Phase 4: 5 min
- Phase 5: 20 min
- Phase 6: 30 min

**Total: ~90 minutes** for complete diagnosis

## Recommended Approach

1. Start with Phase 1 (quick diagnostics)
2. Based on results, jump to most likely hypothesis
3. If hypothesis rejected, move to next most likely
4. Document findings in INVESTIGATION_COMPLETE.md


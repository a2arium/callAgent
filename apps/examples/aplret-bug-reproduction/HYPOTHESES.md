# Hypotheses: Why Are Vars Lost After A2A Resume?

## Hypothesis 1: Multiple Competing Snapshot Saves (Race Condition)

**Theory**: The parent's snapshot is saved multiple times during the A2A cycle, with a later save using stale/unmerged data that overwrites the correct merged snapshot.

**Evidence For**:
- We see multiple save paths: meta-save (line 1332) and potential final-save (line 1386)
- CAS mismatch warnings in logs suggest concurrent writes
- InMemorySessionManager doesn't have transaction isolation

**Evidence Against**:
- Merge logs show correct data before save

**How to Test**:
```typescript
// Add logging in InMemorySessionManager.saveSnapshot()
console.log('[InMemorySessionManager] SAVE:', {
  sessionId,
  agentId,
  varsInSnapshot: Object.keys(((snapshot as any)?.M?.memory?.vars) || {}),
  stackTrace: new Error().stack?.split('\n').slice(1, 4) // Show caller
});
```

**How to Confirm**: If logs show two saves with different var counts, the second one is overwriting.

**How to Reject**: If all saves consistently show 5 vars, this isn't the cause.

---

## Hypothesis 2: Learning Module Creates New M Without Preserving Vars

**Theory**: When `child_completed` is handled, the Learning module's return statement creates a new MentalState that doesn't properly carry over all vars from the loaded snapshot.

**Evidence For**:
- Learning logs show `prevVars: { child, stage, apiTest }` (only 3)
- The spread operator in Learning might not be deep enough

**Evidence Against**:
- We explicitly preserve `prevVars` in the fix
- The Learning module doesn't run until AFTER attachWorkingMemory loads the snapshot

**How to Test**:
```typescript
// In BugReproAgent.ts Learning module
console.log('[Learning] Child completed - DETAILED STATE:', {
  'prev.memory.vars (keys)': Object.keys(prev.memory.vars || {}),
  'prev.memory.vars (full)': JSON.stringify(prev.memory.vars, null, 2),
  'returning vars (keys)': Object.keys(prevVars),
  'returning vars (full)': JSON.stringify(prevVars, null, 2)
});
```

**How to Confirm**: If `prev.memory.vars` has only 3 vars when Learning runs, the problem is upstream.

**How to Reject**: If `prev.memory.vars` has all 5 vars, Learning is working correctly.

---

## Hypothesis 3: attachWorkingMemory Loads Stale Snapshot

**Theory**: When `handleChildCompleted` calls `attachWorkingMemory` to set up ctx.vars for the resumed parent, it loads an old snapshot that was saved before the A2A call (without testMode/testCounter).

**Evidence For**:
- Log shows: `attachWorkingMemory: M.memory.vars= {"child":...}` (only 3 vars)
- The snapshot might be from before the merge was saved

**Evidence Against**:
- We see merge happening with 5 vars before this

**How to Test**:
```typescript
// In taskEngine.ts attachWorkingMemory (line 179)
const snapshot = await this.sessionManager.load(tenantId, sessionId);
console.log('[attachWorkingMemory] LOADED SNAPSHOT DETAILS:', {
  sessionId,
  snapshotExists: !!snapshot,
  wmVersion: snapshot?.wmVersion?.toString(),
  agentId: snapshot?.agentId,
  varsKeys: Object.keys(((snapshot?.snapshot as any)?.M?.memory?.vars) || {}),
  varsFull: JSON.stringify(((snapshot?.snapshot as any)?.M?.memory?.vars) || {}, null, 2),
  timestamp: Date.now()
});
```

**How to Confirm**: If wmVersion is older than expected or vars are missing, we're loading stale data.

**How to Reject**: If the loaded snapshot has all 5 vars, the problem is elsewhere.

---

## Hypothesis 4: InMemorySessionManager Has a Save/Load Bug

**Theory**: The InMemorySessionManager might have a bug where it:
- Saves by reference but the object gets mutated after save
- Has a serialization issue with nested objects
- Stores the wrong version number causing load to return stale data

**Evidence For**:
- InMemorySessionManager is a new implementation created for A2A testing
- No serialization/deserialization happens (unlike database storage)
- JavaScript object references could be shared

**Evidence Against**:
- The implementation looks straightforward

**How to Test**:
```typescript
// In InMemorySessionManager.ts saveSnapshot()
saveSnapshot(params: SaveSnapshotParams): Promise<void> {
    const { tenantId, sessionId, snapshot, wmVersion } = params;
    const key = `${tenantId}:${sessionId}`;
    
    // Deep clone to avoid reference issues
    const clonedSnapshot = JSON.parse(JSON.stringify(snapshot));
    
    console.log('[InMemorySessionManager] SAVING:', {
        key,
        varsInOriginal: Object.keys(((snapshot as any)?.M?.memory?.vars) || {}),
        varsInClone: Object.keys(((clonedSnapshot as any)?.M?.memory?.vars) || {}),
        wmVersion: wmVersion.toString()
    });
    
    this.snapshots.set(key, { 
        snapshot: clonedSnapshot, // Use clone instead of original
        wmVersion: wmVersion + BigInt(1) 
    });
    
    return Promise.resolve();
}

// In load()
console.log('[InMemorySessionManager] LOADING:', {
    key,
    hasSnapshot: this.snapshots.has(key),
    varsInStored: Object.keys(((this.snapshots.get(key)?.snapshot as any)?.M?.memory?.vars) || {})
});
```

**How to Confirm**: If saved vars differ from loaded vars with same wmVersion, InMemorySessionManager is buggy.

**How to Reject**: If saved and loaded vars match, the manager works correctly.

---

## Hypothesis 5: pruneMentalState (Hygiene) Removes Vars

**Theory**: The hygiene function `pruneMentalState` that runs before saving might be removing `testMode` and `testCounter` based on some pruning rules (e.g., removing "internal" fields, limiting size, removing fields without certain prefixes).

**Evidence For**:
- pruneMentalState is called before save (line 1372)
- Hygiene functions often have aggressive cleanup logic
- Only certain vars survive (child, stage, apiTest) - they might share a pattern

**Evidence Against**:
- Why would it remove Learning-set vars but keep Execution-set vars?

**How to Test**:
```typescript
// In taskEngine.ts before calling pruneMentalState (line 1371)
const varsBeforePrune = Object.keys(((mNext as any)?.memory?.vars) || {});
console.log('[TaskEngine] BEFORE pruneMentalState:', varsBeforePrune);

try {
    const { pruneMentalState } = await import('../../loop/hygiene.js');
    pruneMentalState(mNext);
} catch { /* noop */ }

const varsAfterPrune = Object.keys(((mNext as any)?.memory?.vars) || {});
console.log('[TaskEngine] AFTER pruneMentalState:', varsAfterPrune);
console.log('[TaskEngine] PRUNED VARS:', varsBeforePrune.filter(k => !varsAfterPrune.includes(k)));
```

**How to Confirm**: If vars disappear after pruneMentalState, that's the culprit.

**How to Reject**: If vars are unchanged after pruning, hygiene isn't the problem.

---

## Hypothesis 6: handleChildCompleted Calls runLoop With Wrong Initial M

**Theory**: When `handleChildCompleted` resumes the parent (line 2274-2350), it might be initializing `M` from a snapshot that doesn't have the full vars, or it creates a fresh `M` that overwrites what was saved.

**Evidence For**:
- handleChildCompleted loads snapshot at line 2278: `const snapNow = await this.sessionManager!.load(...)`
- It creates M from baseNow: `let M: MentalState = (baseNow as any).M`
- Then calls runLoop with this M

**Evidence Against**:
- attachWorkingMemory should reload vars from the snapshot

**How to Test**:
```typescript
// In taskEngine.ts handleChildCompleted around line 2278
const snapNow = await this.sessionManager!.load(tenantId, parentTaskId);
let baseNow = (snapNow?.snapshot as Record<string, unknown>) || {};
let M: MentalState = (baseNow as any).M as MentalState || initialM(ctx);

console.log('[handleChildCompleted] RESUME STATE:', {
    parentTaskId,
    snapshotExists: !!snapNow,
    wmVersion: snapNow?.wmVersion?.toString(),
    'M.memory.vars (from snapshot)': Object.keys(((M as any)?.memory?.vars) || {}),
    'M.memory.vars (full)': JSON.stringify(((M as any)?.memory?.vars) || {}, null, 2)
});

// After attachWorkingMemory
await this.attachWorkingMemory(ctx, tenantId, parentTaskId, agentName || 'default');
console.log('[handleChildCompleted] AFTER attachWorkingMemory:', {
    'ctx.vars.keys()': (ctx as any).vars?.keys?.() || [],
    'M.memory.vars': Object.keys(((M as any)?.memory?.vars) || {})
});
```

**How to Confirm**: If M loaded from snapshot has only 3 vars, the issue is in what was saved.

**How to Reject**: If M has all 5 vars when loaded, but loses some later, the issue is downstream.

---

## Recommended Testing Order

1. **Start with Hypothesis 3** (attachWorkingMemory loads stale) - Most likely and easiest to test
2. **Then Hypothesis 4** (InMemorySessionManager bug) - New code, likely to have issues
3. **Then Hypothesis 1** (multiple saves) - Check if overwriting happens
4. **Then Hypothesis 5** (hygiene pruning) - Easy to verify
5. **Finally Hypothesis 6** (handleChildCompleted) - Most complex to trace

## Quick Diagnostic Script

Add this at the END of `mergeVarsIntoMental` to track the merged result:

```typescript
private mergeVarsIntoMental(source: MentalState, target: MentalState): MentalState {
    try {
        const sourceVars = (((source as any)?.memory as any)?.vars) || {};
        const targetVars = (((target as any)?.memory as any)?.vars) || {};
        if ((sourceVars && typeof sourceVars === 'object') || (targetVars && typeof targetVars === 'object')) {
            const mem = (((target as any).memory) || {}) as Record<string, unknown>;
            const merged = { ...(targetVars as Record<string, unknown>), ...(sourceVars as Record<string, unknown>) };
            console.log('[TaskEngine] mergeVarsIntoMental:', {
                sourceVars: Object.keys(sourceVars),
                targetVars: Object.keys(targetVars),
                merged: Object.keys(merged)
            });
            (target as any).memory = { ...mem, vars: merged };
            
            // DIAGNOSTIC: Track this merged object
            (global as any).__LAST_MERGED_VARS = merged;
            (global as any).__LAST_MERGED_TIMESTAMP = Date.now();
        }
    } catch { /* noop */ }
    return target;
}
```

Then check in InMemorySessionManager.saveSnapshot():
```typescript
if ((global as any).__LAST_MERGED_VARS) {
    console.log('[DIAGNOSTIC] Time since merge:', Date.now() - (global as any).__LAST_MERGED_TIMESTAMP, 'ms');
    console.log('[DIAGNOSTIC] Merged vars:', Object.keys((global as any).__LAST_MERGED_VARS));
    console.log('[DIAGNOSTIC] Vars being saved:', Object.keys(((snapshot as any)?.M?.memory?.vars) || {}));
}
```

This will show if the merge result is what's actually being saved.


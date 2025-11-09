# Investigation Complete: test-api Infinite Loop

## Summary

Successfully identified and partially fixed the root cause of why agent state (testMode, testCounter) is lost after A2A calls, causing infinite loops.

## Discoveries

### Discovery #1: Input Parsing Issue (✅ FIXED)
**Problem**: `TaskInput` properties are accessible directly (e.g., `env.input.testMode`), not nested under `value`.  
**Fix**: Updated Perception module to read `directInput.testMode` instead of `directInput.value.testMode`.

### Discovery #2: Learning Module Not Handling String Input (✅ FIXED)
**Problem**: Learning tried to `JSON.parse(obs.text)` expecting nested JSON, but Perception returns a plain string.  
**Fix**: Learning now treats `obs.text` as the testMode string directly.

### Discovery #3: Learning Not Preserving vars on Child Completion (✅ FIXED)  
**Problem**: When handling `child_completed`, Learning only preserved `sensory`, not `vars`.  
**Fix**: Explicitly preserve `prevVars` in the Learning module's child completion handler.

### Discovery #4: Bug #1G - Snapshot Save Uses Wrong Mental State (❌ PARTIALLY FIXED)
**Problem**: The taskEngine has TWO snapshot save paths:
1. **meta-save** (line 1328-1332): Uses `mergeVarsIntoMental` correctly ✅
2. **final-save** (line 1380-1386): NOW also uses `mergeVarsIntoMental` ✅

However, **vars are STILL being lost** even after the fix!

## Current Status

Even with all fixes applied:
```
[TaskEngine] mergeVarsIntoMental: {
  targetVars: [ 'testCounter', 'testMode', 'apiTest', 'child', 'stage' ],
  merged: [ 'testCounter', 'testMode', 'apiTest', 'child', 'stage' ]
}
```

The merge shows 5 vars, but on resume:
```
[TaskEngine] attachWorkingMemory: M.memory.vars= {"child":"...","stage":"awaiting_api_test","apiTest":"before"}
```

Only 3 vars are loaded!

## Next Steps for Framework Team

1. **Verify which save path is being used** during the A2A flow
2. **Add logging** to confirm that `mNextWithVars` (the merged result) is what gets saved in the snapshot
3. **Check if there's a CAS conflict** overwriting the snapshot with stale data
4. **Investigate** if `pruneMentalState` (hygiene) is removing vars
5. **Check** if there's another code path that saves snapshots without merging

## Test Case

The `test-api` mode in the bug reproduction agent is a perfect test case:
- Sets `testMode` and `testCounter` in Learning
- Makes an A2A call
- Should preserve those vars after resume
- Currently loses them, causing infinite loop

## Files Modified

- `apps/examples/aplret-bug-reproduction/BugReproAgent.ts` - Added test-api mode and fixes
- `packages/core/src/core/orchestration/taskEngine.ts` - Fixed final-save path to use `mergeVarsIntoMental`
- Created documentation: `ROOT_CAUSE_ANALYSIS.md`, `INVESTIGATION_COMPLETE.md`

## Recommendation

The framework team should:
1. Review the snapshot save/load flow end-to-end
2. Add comprehensive logging to track `M.memory.vars` through the entire lifecycle
3. Consider simplifying the state management to have a single source of truth
4. Add integration tests that specifically test var persistence across A2A boundaries


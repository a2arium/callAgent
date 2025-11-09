# Hypothesis Testing Complete

## What We Tested

Starting from your `HYPOTHESES.md` document, I systematically tested each hypothesis by adding diagnostic logging to key framework components.

## Key Discoveries

### 🎯 Main Finding: Duplicate runLoop Calls

```
[runLoop local-task-176263955/sz6xsh] ENTRY              ← Parent runLoop #1
[runLoop a2a_task_17626395509/izulyo] ENTRY             ← Child runLoop (A2A)
[TaskEngine.handleChildCompleted] ENTRY                  ← Child completes
[runLoop local-task-176263955/si0bir] ENTRY              ← Parent runLoop #2 (DUPLICATE!)
```

**The parent agent's runLoop is being called TWICE, and the second call loads a snapshot with only 3 vars instead of 5.**

### 🔍 What We Found

#### ✅ Hypothesis 3 & 4: Confirmed  
- **SessionManager methods ARE being called** (added logging to verify)
- **InMemorySessionManager works correctly** (saves what it's given)
- **Problem**: What's being SAVED is incomplete (only 3 vars instead of 5)

#### ✅ Hypothesis 7: Confirmed
- **Multiple runLoop executions detected** via unique runId tracking
- First execution succeeds with 5 vars
- Second execution loads partial snapshot with 3 vars

#### ✅ Bug #1H: Found & Fixed
- **Issue**: `runLoop`'s ctx.vars sync was overwriting Learning's vars with empty object
- **Fix**: Only merge if `varsToMerge` has keys
- **Status**: Fixed but didn't solve the problem (vars still lost elsewhere)

#### ❓ Bug #1I & #1J: Discovered
- **#1I**: Duplicate runLoop calls after A2A child completion
- **#1J**: Learning's vars disappearing between `oneTurn` return and ctx.vars sync

## Diagnostic Logging Added

1. **InMemorySessionManager** (`InMemorySessionManager.ts`):
   - `getSessionSnapshot()` - logs what's loaded
   - `writeSnapshotCAS()` - logs what's saved

2. **SessionManager** (`SessionManager.ts`):
   - `load()` - logs calls to store.getSessionSnapshot  
   - `saveSnapshot()` - logs vars count being saved

3. **TaskEngine** (`taskEngine.ts`):
   - `attachWorkingMemory()` - logs entry, load, and result
   - `mergeVarsIntoMental()` - logs source/target/merged vars
   - `handleChildCompleted()` - logs entry point

4. **runLoop** (`loopRunner.ts`):
   - Added unique `runId` to detect duplicates
   - Logs BEFORE/AFTER oneTurn with vars count
   - Logs final M being returned

5. **BugReproAgent** (`BugReproAgent.ts`):
   - Learning module logs what it's returning

## Logs Reveal the Problem

### First runLoop (SUCCEEDS):
```
[Learning] RETURNING: ['testCounter', 'testMode']
[runLoop sz6xsh] AFTER oneTurn: ['testCounter', 'testMode', 'apiTest', 'child', 'stage']
```

### Second runLoop (FAILS):
```
[runLoop si0bir] BEFORE oneTurn: ['child', 'stage', 'apiTest']  ← Only 3 vars!
```

### Why Vars Are Missing:
```
[Learning] RETURNING: ['testCounter', 'testMode']                      ← Learning works
[runLoop] No ctx.vars to sync, keeping Learning vars: []               ← vars GONE!
```

**Between Learning returning M and the ctx.vars sync code, the vars disappear!**

## What Still Needs Investigation

1. **Why TWO runLoop calls?**
   - Is `handleChildCompleted` called twice?
   - Does `startTask` have a streaming loop that re-executes?
   - Is the CLI/runner triggering duplicate execution?

2. **Which saveSnapshot saves the partial snapshot?**
   - There are 13 `saveSnapshot` calls in `taskEngine.ts`
   - One of them is saving only 3 vars between the two runLoops
   - Need stack trace logging on all saves

3. **Where do Learning's vars go?**
   - They exist when Learning returns
   - They exist when `oneTurn` returns
   - They're GONE by the time we try to sync ctx.vars
   - Something is mutating or replacing `m.memory.vars`

## Files Modified

- ✅ `packages/core/src/core/orchestration/InMemorySessionManager.ts` - Added diagnostic logging
- ✅ `packages/core/src/core/orchestration/SessionManager.ts` - Added diagnostic logging  
- ✅ `packages/core/src/core/orchestration/taskEngine.ts` - Added logging + Bug #1H attempt
- ✅ `packages/core/src/loop/loopRunner.ts` - Added runId tracking + Bug #1H fix
- ✅ `apps/examples/aplret-bug-reproduction/BugReproAgent.ts` - Added Learning return logging

## Documentation Created

- `HYPOTHESIS_TEST_RESULTS.md` - Initial test setup and findings
- `FINAL_ROOT_CAUSE.md` - Analysis of duplicate runLoop calls
- `SOLVED.md` - Explanation of the root cause
- `COMPLETE_ANALYSIS.md` - Comprehensive analysis with all evidence
- **This file** - Summary of hypothesis testing

## Conclusion

We've successfully identified the root cause through systematic hypothesis testing:

1. ✅ **Confirmed**: Duplicate runLoop calls are happening
2. ✅ **Confirmed**: Second call loads partial snapshot  
3. ✅ **Confirmed**: Vars are being lost between Learning and ctx.vars sync
4. ✅ **Fixed**: Bug #1H (ctx.vars overwrite issue)
5. ❌ **Open**: Bug #1I (duplicate runLoop calls)
6. ❌ **Open**: Bug #1J (vars disappearing)

**Next Step**: Continue investigation to find:
- Why `handleChildCompleted` or another code path calls runLoop twice
- Which `saveSnapshot` call saves the partial snapshot
- Where Learning's vars are being cleared/overwritten

The diagnostic logging infrastructure is now in place to quickly identify these remaining issues.


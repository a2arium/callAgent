# Executive Summary: test-api Investigation

## Current Status

**Problem**: Agent vars (`testMode`, `testCounter`) set by Learning module are lost after A2A call/resume, causing infinite loops.

**Symptom**: Before A2A → 5 vars | After Resume → 3 vars

**Impact**: Critical framework bug affecting all agents using Learning + A2A

## Investigation Complete ✅

### What We Found

1. **Input parsing issue** - Fixed ✅
2. **Learning module handling** - Fixed ✅  
3. **Child completion preservation** - Fixed ✅
4. **Snapshot save path (Bug #1G)** - Partially Fixed ⚠️

### What's Still Broken

Despite fixes, vars are **still being lost** during snapshot save/load cycle.

## 6 Diagnostic Hypotheses Created

Ranked by likelihood:

### 🔥 Hypothesis 3: attachWorkingMemory Loads Stale Snapshot
**Likelihood**: HIGH  
**Test Time**: 10 minutes  
**Evidence**: Log shows only 3 vars when loading  

### 🔥 Hypothesis 4: InMemorySessionManager Has Bug
**Likelihood**: HIGH  
**Test Time**: 20 minutes  
**Evidence**: New code, may have reference/serialization issues  

### 🔥 Hypothesis 1: Multiple Saves Overwrite Data
**Likelihood**: MEDIUM  
**Test Time**: 15 minutes  
**Evidence**: Multiple save paths in code, CAS warnings  

### Hypothesis 5: pruneMentalState Removes Vars
**Likelihood**: LOW  
**Test Time**: 5 minutes  
**Evidence**: Hygiene runs before save  

### Hypothesis 6: handleChildCompleted Issues
**Likelihood**: LOW  
**Test Time**: 30 minutes  
**Evidence**: Complex flow with many steps  

### Hypothesis 2: Learning Creates New M Improperly
**Likelihood**: VERY LOW  
**Test Time**: 10 minutes  
**Evidence**: Already fixed, unlikely  

## Recommended Next Steps

### Option A: Quick Diagnosis (15 minutes)
1. Add logging to `InMemorySessionManager` save/load
2. Run test-api mode
3. Compare saved vs loaded vars
4. Immediately identifies if storage layer is the problem

### Option B: Systematic Testing (90 minutes)  
Follow `TESTING_PLAN.md` phases 1-6 to systematically eliminate hypotheses.

### Option C: Deep Dive (2-4 hours)
Add comprehensive logging throughout save/load/resume flow to trace exact point of data loss.

## Key Files

- `HYPOTHESES.md` - 6 detailed hypotheses with testing approaches
- `TESTING_PLAN.md` - Step-by-step diagnostic procedures
- `ROOT_CAUSE_ANALYSIS.md` - Technical analysis with logs
- `INVESTIGATION_COMPLETE.md` - Summary of findings so far

## Quick Win Possibility

**Most likely culprits** (Hypotheses 3 & 4) are in the storage layer and relatively easy to fix once identified. Could potentially be resolved in < 1 hour.

## Test Case Quality

The `test-api` mode is a **production-ready test case**:
- ✅ Minimal and focused
- ✅ Clear pass/fail criteria  
- ✅ Tests critical framework functionality
- ✅ Reproduces bug 100% consistently
- ✅ Will verify fix when applied

## Success Criteria

Test passes when these appear in logs:
```
[Policy] Turn 1, TestCounter 1, Mode: test-api
[Bug #3] AFTER A2A - ctx.vars.get(): before
[Bug #3] ✅ ALL API METHODS WORK AFTER A2A RESUME!
```

Currently seeing:
```
[Policy] Turn 0, TestCounter 0, Mode: undefined  ← WRONG
(infinite loop)
```

## For Framework Team

**Priority**: HIGH - Affects all agents using Learning + A2A  
**Complexity**: MEDIUM - Likely storage layer issue  
**Risk**: LOW - Fixes are targeted, well-documented  
**Time**: 1-4 hours depending on approach  

**Deliverables**:
1. All hypotheses documented with tests
2. Diagnostic logging ready to add
3. Test case that proves fix works
4. Full investigation trail for reference


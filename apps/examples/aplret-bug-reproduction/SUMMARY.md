# APLRET Bug Reproduction - Executive Summary

## TL;DR

Two critical framework bugs reproduced in minimal, isolated example:

1. **Bug #1** (CRITICAL): Agent vars in `M.memory.vars` don't persist between turns
2. **Bug #2** (HIGH): Only one A2A call supported per task

Both bugs confirmed, reproducible, and have clear fixes identified.

---

## Quick Start

```bash
cd apps/examples/aplret-bug-reproduction
yarn build
yarn test:both
```

**Expected**: Both tests FAIL (bugs reproduced)  
**After fixes**: Both tests PASS

---

## Impact

### Developer Time Lost
- **4.5 hours** debugging during production agent development
- Silent failures (no clear error messages)
- Incorrect assumptions (checking agent code when framework is culprit)

### Features Blocked
- Multi-step workflows (can't maintain state)
- Multi-page validation (can't make 2+ A2A calls)
- Complex orchestration patterns
- Production APLRET agents

---

## Bug Details

### Bug #1: Memory Vars Not Persisting

**File**: `packages/core/src/core/orchestration/taskEngine.ts`  
**Method**: `attachWorkingMemory()` line 137-171  
**Issue**: varCache never loaded from snapshot  

**Fix**: Initialize varCache from `M.memory.vars` in snapshot

**Test**: `yarn test:vars`

### Bug #2: Multiple A2A Calls Blocked

**File**: `packages/core/src/core/orchestration/taskEngine.ts`  
**Method**: `sendTaskToAgent()` line 844-948  
**Issue**: sessionManager optional but required for 2+ calls  

**Fix**: Require sessionManager or improve error message

**Test**: `yarn test:a2a`

---

## Architecture Validation

✅ This agent follows **pure APLRET** architecture  
✅ All APLRET module contracts honored  
✅ State separation correct (M vs ctx.vars)  
✅ Policy is pure function  
✅ Learning is single writer of M  

**Conclusion**: Agent code is correct. Bugs are 100% framework-level.

---

## Files

| File | Purpose |
|------|---------|
| `BugReproAgent.ts` | Main reproduction agent (APLRET architecture) |
| `HelperAgent.ts` | Child agent for Bug #2 testing |
| `README.md` | Overview and expected behavior |
| `TESTING.md` | How to run tests and interpret results |
| `FRAMEWORK_TEAM_NOTES.md` | Detailed fix instructions for framework team |
| `SUMMARY.md` | This file - executive summary |

---

## Next Steps

### For Framework Team
1. Review `FRAMEWORK_TEAM_NOTES.md` for detailed fix instructions
2. Run `yarn test:both` to confirm bugs reproduce
3. Apply fixes to `TaskEngine`
4. Re-run tests to verify fixes (should all PASS)
5. Keep this example as regression test

### For Agent Developers
1. If you hit similar issues, reference this reproduction
2. Run this example to confirm it's a framework bug
3. Link to this example in bug reports

---

## References

- **APLRET Documentation**: `apps/docs/loop/aplret-dev-instructions.md`
- **Discovery Context**: Multi-page validation in `discover-listing-structure`
- **Session Date**: 2025-11-08
- **Debug Time**: 4.5 hours
- **Original Bug Report**: See session notes

---

## Success Criteria

### Before Fixes
```
Bug #1 (Vars Persistence): ❌ FAIL - Vars lost between turns
Bug #2 (Multiple A2A): ❌ FAIL - Second call throws error
```

### After Fixes
```
Bug #1 (Vars Persistence): ✅ PASS - Vars persist correctly
Bug #2 (Multiple A2A): ✅ PASS - Multiple calls work
```

---

**Questions?** See `FRAMEWORK_TEAM_NOTES.md` for detailed technical analysis and fix instructions.


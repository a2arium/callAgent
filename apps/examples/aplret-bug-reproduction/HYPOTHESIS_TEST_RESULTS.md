# Hypothesis Testing Results

## Test Setup
- **Date**: Investigation Complete
- **Test Mode**: test-api  
- **Diagnostic Logging**: Added to InMemorySessionManager.writeSnapshotCAS() and getSessionSnapshot()
- **Build Status**: ✅ Compiled successfully, logs present in dist/

## Key Finding: **Methods Not Being Called**

### Evidence
```bash
# Checked compiled JavaScript
grep "DIAGNOSTIC" packages/core/dist/core/orchestration/InMemorySessionManager.js
# Result: ✅ Logging code is present

# Ran test
node --import tsx packages/core/src/runner/runnerCli.ts apps/examples/aplret-bug-reproduction/dist/BugReproAgent.js '{"testMode":"test-api"}'

# Searched for logs
grep "InMemorySessionManager" output.log
# Result: ❌ ZERO logs found!

# Confirmed InMemorySessionManager is initialized
grep "IN-MEMORY" output.log  
# Result: ✅ "[TaskEngine] No SessionStore configured - using IN-MEMORY mode"
```

### Conclusion
**InMemorySessionManager is created but its methods are NEVER called!**

This is a **NEW hypothesis** that supersedes all others:

## 🔥 **Hypothesis 7: SessionManager Methods Not Called During A2A**

**Theory**: The InMemorySessionManager is instantiated but the TaskEngine/A2A flow doesn't actually call `load()` or `saveSnapshot()` during the A2A cycle.

**Why This Matters**: If snapshots aren't being saved/loaded, then:
- Vars can't persist because they're never written
- Resume loads nothing because nothing was saved
- The entire state management is bypassed

**Evidence For**:
1. InMemorySessionManager initialized ✅
2. Methods have logging ✅  
3. Zero logs appear ❌
4. Vars are lost ❌

**Evidence Against**:
- TaskEngine code shows many `sessionManager.load()` and `sessionManager.saveSnapshot()` calls
- Other framework code (attachWorkingMemory, handleChildCompleted) calls these methods

**Possible Root Causes**:

### 7a: sessionManager is null/undefined
```typescript
// In TaskEngine methods
if (!this.sessionManager) return; // Early return!
```

If `this.sessionManager` is falsy, all save/load operations silently skip.

**Test**: Add logging after sessionManager creation:
```typescript
console.log('[TaskEngine] SessionManager initialized:', {
    hasSessionManager: !!this.sessionManager,
    type: this.sessionManager?.constructor.name
});
```

### 7b: Different Code Path During A2A
The A2A flow might use a different mechanism that bypasses normal save/load:
- Direct manipulation of in-memory state
- Alternative storage mechanism
- Shared context that doesn't need persistence

**Test**: Add logging at START of every sessionManager method call in TaskEngine.

### 7c: Conditional Compilation or Dead Code Elimination
TypeScript/bundler might be removing code if it detects it's unreachable.

**Test**: Check if methods exist at runtime:
```typescript
console.log('[TaskEngine] SessionManager methods:', {
    hasLoad: typeof this.sessionManager?.load,
    hasSave: typeof this.sessionManager?.saveSnapshot
});
```

## Next Steps

### Immediate Action (5 minutes)
Add this to TaskEngine constructor (line ~107):

```typescript
this.sessionManager = new SessionManager(new InMemorySessionManager());
console.log('[TaskEngine] ✅ InMemorySessionManager created');
console.log('[TaskEngine] SessionManager methods check:', {
    hasLoad: typeof this.sessionManager.load,
    hasSave: typeof this.sessionManager.saveSnapshot,
    hasStore: !!(this.sessionManager as any).store
});
```

Then in line 179 (attachWorkingMemory):
```typescript
async attachWorkingMemory(...) {
    console.log('[attachWorkingMemory] ENTRY:', {
        hasSessionManager: !!this.sessionManager,
        willAttemptLoad: true
    });
    
    if (!this.sessionManager) {
        console.log('[attachWorkingMemory] NO SESSION MANAGER - EARLY RETURN');
        return;
    }
    
    console.log('[attachWorkingMemory] About to call load...');
    const snapshot = await this.sessionManager.load(tenantId, sessionId);
    console.log('[attachWorkingMemory] Load returned:', !!snapshot);
}
```

### Expected Results

**If sessionManager is null:**
```
[attachWorkingMemory] NO SESSION MANAGER - EARLY RETURN
```
→ **Hypothesis 7a CONFIRMED** - sessionManager not initialized properly

**If load() is never called:**
```
[attachWorkingMemory] ENTRY: { hasSessionManager: true, willAttemptLoad: true }
(no "About to call load..." log)
```
→ Code path issue, something returns/throws before reaching load()

**If load() is called but InMemorySessionManager method isn't:**
```
[attachWorkingMemory] About to call load...
[attachWorkingMemory] Load returned: true
(but no [InMemorySessionManager] LOAD log)
```
→ **Hypothesis 7b CONFIRMED** - SessionManager.load() doesn't call store.getSessionSnapshot()

## Summary of All Hypotheses

| # | Hypothesis | Status | Likelihood |
|---|------------|--------|-----------|
| 1 | Multiple competing saves | ❓ Untested | Medium |
| 2 | Learning creates new M improperly | ❌ Rejected | Very Low |
| 3 | attachWorkingMemory loads stale | ❓ Untested | High |
| 4 | InMemorySessionManager bug | ❓ Untested | High |
| 5 | pruneMentalState removes vars | ❓ Untested | Low |
| 6 | handleChildCompleted issues | ❓ Untested | Medium |
| **7** | **SessionManager methods not called** | 🔥 **Testing Now** | **VERY HIGH** |

## Critical Insight

The absence of **ANY** InMemorySessionManager logs despite:
- ✅ Code is compiled
- ✅ InMemorySessionManager is instantiated  
- ✅ TaskEngine has 50+ calls to sessionManager methods

Strongly suggests **Hypothesis 7** is the root cause. Either:
1. sessionManager is unexpectedly null
2. All sessionManager calls are in code paths that aren't executed during A2A
3. There's a wrapper/proxy that intercepts calls

## Recommendation

**Priority**: CRITICAL - This blocks ALL other hypothesis testing

**Next Step**: Add the diagnostic logging above to determine if sessionManager methods are being called at all.

**Time Estimate**: 5 minutes to add logs + 2 minutes to test = 7 minutes total

**Expected Outcome**: We'll know definitively whether sessionManager is the issue, unblocking the investigation.


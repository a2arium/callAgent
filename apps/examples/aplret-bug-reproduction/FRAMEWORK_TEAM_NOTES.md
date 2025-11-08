# Framework Team: Bug Reproduction Notes

## Purpose

This example provides minimal, isolated reproduction of two critical bugs that block production APLRET agents.

## Why This Matters

**Real-world impact**: Discovered during implementation of `discover-listing-structure` agent for multi-page validation. Developer spent **4.5 hours debugging** what turned out to be framework issues, not agent logic issues.

## Architecture Quality

This agent follows **pure APLRET architecture** per `apps/docs/loop/aplret-dev-instructions.md`:

✅ All modules correctly separated  
✅ Learning is single writer of M  
✅ Policy is pure function (only reads M)  
✅ State separation (cognition in M, control in ctx.vars)  
✅ Typed intents with exhaustive handling  
✅ Stage dispatcher pattern  

**Conclusion**: Agent code is production-ready. Bugs are 100% framework-level.

---

## Bug #1: Memory Vars Not Persisting (CRITICAL)

### Impact
- **Severity**: CRITICAL - Blocks ALL APLRET agents
- **Scope**: Any agent using `M.memory.vars` for custom state
- **Symptom**: State resets between turns, infinite loops, can't track progress

### Root Cause (TWO Issues)

#### Issue 1A: `attachWorkingMemory()` Starts Empty

File: `packages/core/src/core/orchestration/taskEngine.ts`  
Method: `attachWorkingMemory()` (line 137-171)

**Problem**: varCache initialized empty, never loaded from snapshot

```typescript
// Current (BUGGY)
const varCache = new Map<string, unknown>();  // ❌ Always starts empty!
(ctx as any).vars = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => varCache.get(prop),  // ❌ Always returns undefined!
    // ...
});
```

**Compare to `startTask()` (CORRECT)** at line 289-290:
```typescript
const currentVars = ((M.memory as any)?.vars || {}) as Record<string, unknown>;
const varCache = new Map<string, unknown>(Object.entries(currentVars)); // ✅ LOADED!
```

**Result**:
- Turn N: Agent writes vars via Learning → M.memory.vars saved ✅
- Turn N+1: varCache is empty, vars lost ❌

#### Issue 1B: `handleChildCompleted()` Missing Setup

File: `packages/core/src/core/orchestration/taskEngine.ts`  
Method: `handleChildCompleted()` (line 2127-2200)

**Problem**: When resuming parent after A2A, `ctx.vars` proxy is NEVER set up

```typescript
async handleChildCompleted(params: { ... }): Promise<void> {
    const ctx = this.createContext({ id: parentTaskId, input: {} }); // Fresh context
    let M: MentalState = (baseNow as any).M as MentalState || initialM(ctx);
    await this.attachAndRestoreLLM(ctx, agentName, M);
    // ❌ MISSING: this.attachWorkingMemory(ctx, tenantId, parentTaskId, agentName);
    const { M: mNext, outcome, metrics } = await runLoop(ctx, M, env, overrides, loopOpts);
}
```

**Result**:
- Parent resumes after A2A with NO `ctx.vars` proxy
- All working memory lost on resume
- Combined with Issue 1A: complete memory loss during A2A

### The Fix (Part 1: Fix `attachWorkingMemory`)

**Note**: This requires making the method async (update all call sites!)

```typescript
public async attachWorkingMemory(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string): Promise<void> {
    if (!this.sessionManager) return;
    
    // ✅ FIX: Load existing vars from snapshot (like startTask does)
    const snapshot = await this.sessionManager.load(tenantId, sessionId);
    const M = (snapshot?.snapshot as any)?.M;
    const currentVars = ((M?.memory as any)?.vars || {}) as Record<string, unknown>;
    const varCache = new Map<string, unknown>(Object.entries(currentVars)); // ✅ INITIALIZE!
    
    console.log('[TaskEngine] Loaded agent vars from snapshot:', Object.keys(currentVars));
    
    (ctx as any).vars = new Proxy({} as Record<string, unknown>, {
        get: (_t, prop: string) => varCache.get(prop), // ✅ Now returns persisted values!
        set: (_t, prop: string, value: unknown) => {
            varCache.set(prop, value);
            (async () => {
                try {
                    const snapNow = await this.sessionManager!.load(tenantId, sessionId);
                    const base = (snapNow?.snapshot as Record<string, unknown>) || {};
                    let M = (base as any).M;
                    if (!M) {
                        const { initialM } = await import('../../loop/init.js');
                        M = initialM(ctx);
                    }
                    M.memory = M.memory || {};
                    M.memory.vars = M.memory.vars || {};
                    (M.memory.vars as any)[prop] = value;
                    const next = { ...base, M } as Record<string, unknown>;
                    const expected = snapNow?.wmVersion ?? BigInt(0);
                    await this.sessionManager!.saveSnapshot({ 
                        tenantId, 
                        sessionId, 
                        agentId: (ctx as any).agentId || agentId, 
                        expectedWmVersion: expected, 
                        snapshot: next 
                    });
                    await this.sessionManager!.appendEvent(tenantId, sessionId, 'wm.vars_updated', { key: String(prop) });
                } catch { /* best-effort */ }
            })();
            return true;
        },
        has: (_t, prop: string) => varCache.has(prop),
        ownKeys: () => Array.from(varCache.keys()),
        getOwnPropertyDescriptor: (_t, prop: string) =>
            varCache.has(prop as string) ? { enumerable: true, configurable: true } : undefined
    });
}
```

### The Fix (Part 2: Call in `handleChildCompleted`)

```typescript
async handleChildCompleted(params: { ... }): Promise<void> {
    // ... existing code to create ctx and load M ...
    const ctx = this.createContext({ id: parentTaskId, input: {} });
    (ctx as any).tenantId = tenantId;
    if (agentName) (ctx as any).agentId = agentName;
    
    // ... existing code to load snapshot and M ...
    let M: MentalState = (baseNow as any).M as MentalState || initialM(ctx);
    
    // ✅ NEW: Attach working memory proxy before running loop
    await this.attachWorkingMemory(ctx, tenantId, parentTaskId, agentName || 'default');
    
    // Attach and restore LLM before running loop
    await this.attachAndRestoreLLM(ctx, agentName, M);
    
    // ... rest of the method ...
    const { M: mNext, outcome, metrics } = await runLoop(ctx, M, env, overrides, loopOpts);
}
```

**Call Sites to Update (make async):**
- `A2AService.ts:125` - `try { await (eng as any).attachWorkingMemory?.(...); }`
- `A2AService.ts:633` - `try { await (eng as any).attachWorkingMemory?.(...); }`
- `A2AService.ts:643` - `try { await (eng as any).attachWorkingMemory?.(...); }`

### Test Command

```bash
cd apps/examples/aplret-bug-reproduction
yarn test:vars
```

**Expected before fix**: Test FAILS (vars lost)  
**Expected after fix**: Test PASSES (vars persist)

### Verification

After applying fix, the test should show:

```
Turn 0: Writing vars { counter: 1, sessionId: 'abc123' }
Turn 1: Reading vars { counter: 1, sessionId: 'abc123' } ✅
Bug #1 Test: PASS
```

---

## Bug #2: Multiple A2A Calls Not Supported (HIGH)

### Impact
- **Severity**: HIGH - Blocks orchestration patterns
- **Scope**: Any agent needing 2+ sequential sub-agent calls
- **Symptom**: First call works, second call throws error

### Root Cause

File: `packages/core/src/core/orchestration/taskEngine.ts`  
Method: `sendTaskToAgent()` (line 844-948)

**Problem**: sessionManager optional, but required for multiple A2A calls

```typescript
(ctx as any).sendTaskToAgent = async (...) => {
    if (!this.sessionManager) throw new Error('Session manager not configured');  // ← Throws on 2nd call
    // ...
};
```

**Why first call works but second fails**:
1. Basic TaskEngine created without sessionManager
2. First A2A handled synchronously in current context ✅
3. After first child completes, context becomes "stale"
4. Second A2A check finds sessionManager = undefined ❌

### The Fix (Option A: Fail Fast with Clear Error)

**Simplest approach - update `attachWorkingMemory()`:**

```typescript
public async attachWorkingMemory(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string): Promise<void> {
    if (!this.sessionManager) {
        // ✅ Fail fast with clear error
        throw new Error(
            'SessionManager required for A2A calls. ' +
            'Configure TaskEngine with a SessionManager before calling sendTaskToAgent(). ' +
            'See docs/a2a/setup.md for details.'
        );
    }
    // ... rest of method
}
```

**Pros**: Clear error, simple, no silent failures  
**Cons**: CLI demos need DB setup

### The Fix (Option B: In-Memory Fallback)

**Add in-memory storage for CLI/testing:**

```typescript
private inMemorySnapshots?: Map<string, any>;

public async attachWorkingMemory(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string): Promise<void> {
    if (!this.sessionManager) {
        // ✅ In-memory fallback for CLI/testing
        console.warn('[TaskEngine] No SessionManager - using in-memory storage (not for production)');
        this.setupInMemoryVars(ctx, tenantId, sessionId, agentId);
        return;
    }
    // ... persistent implementation
}

private setupInMemoryVars(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string): void {
    if (!this.inMemorySnapshots) {
        this.inMemorySnapshots = new Map<string, any>();
    }
    
    const key = `${tenantId}:${sessionId}`;
    const snapshot = this.inMemorySnapshots.get(key) || { M: { memory: { vars: {} } } };
    const currentVars = snapshot.M?.memory?.vars || {};
    const varCache = new Map<string, unknown>(Object.entries(currentVars));
    
    (ctx as any).vars = new Proxy({} as Record<string, unknown>, {
        get: (_t, prop: string) => varCache.get(prop),
        set: (_t, prop: string, value: unknown) => {
            varCache.set(prop, value);
            snapshot.M = snapshot.M || { memory: { vars: {} } };
            snapshot.M.memory = snapshot.M.memory || { vars: {} };
            snapshot.M.memory.vars = snapshot.M.memory.vars || {};
            snapshot.M.memory.vars[prop] = value;
            this.inMemorySnapshots!.set(key, snapshot);
            return true;
        },
        has: (_t, prop: string) => varCache.has(prop),
        ownKeys: () => Array.from(varCache.keys()),
        getOwnPropertyDescriptor: (_t, prop: string) =>
            varCache.has(prop) ? { enumerable: true, configurable: true } : undefined
    });
}
```

**Pros**: Works out of box, graceful degradation  
**Cons**: Two code paths to maintain

### The Fix (Option C: Auto-Configure InMemorySessionManager) 🌟 RECOMMENDED

**Best developer experience:**

```typescript
// New class in packages/core/src/core/orchestration/InMemorySessionManager.ts
export class InMemorySessionManager implements SessionManager {
    private snapshots = new Map<string, { snapshot: unknown; wmVersion: bigint }>();
    private events = new Map<string, Array<{ type: string; payload: unknown; createdAt: string; seq: number }>>();
    
    async load(tenantId: string, sessionId: string) {
        const key = `${tenantId}:${sessionId}`;
        return this.snapshots.get(key) || null;
    }
    
    async saveSnapshot(params: { tenantId: string; sessionId: string; agentId: string; snapshot: unknown; expectedWmVersion: bigint }) {
        const key = `${params.tenantId}:${params.sessionId}`;
        const current = this.snapshots.get(key);
        const nextVersion = (current?.wmVersion ?? BigInt(0)) + BigInt(1);
        this.snapshots.set(key, { snapshot: params.snapshot, wmVersion: nextVersion });
    }
    
    async appendEvent(tenantId: string, sessionId: string, type: string, payload: unknown) {
        const key = `${tenantId}:${sessionId}`;
        const list = this.events.get(key) || [];
        list.push({ type, payload, createdAt: new Date().toISOString(), seq: list.length });
        this.events.set(key, list);
    }
    
    async listEventsSince(params: { tenantId: string; sessionId: string; sinceSeq: number }) {
        const key = `${params.tenantId}:${params.sessionId}`;
        return this.events.get(key)?.filter(e => e.seq > params.sinceSeq) || [];
    }
    
    // ... implement other SessionManager methods
}

// In TaskEngine constructor:
constructor(opts?: { sessionStore?: IWorkingMemorySessionStore }) {
    if (!opts?.sessionStore) {
        console.warn('[TaskEngine] No SessionStore configured - using in-memory mode (NOT for production)');
        console.warn('[TaskEngine] Configure a database-backed SessionStore for production: docs/a2a/setup.md');
        // ✅ Default to in-memory for testing
        this.sessionManager = new InMemorySessionManager();
    } else {
        this.sessionManager = new SessionManager(opts.sessionStore);
    }
}
```

**Pros**: A2A "just works", clear production path, best UX  
**Cons**: Need to implement InMemorySessionManager (but simple!)

**Recommended**: Option C with loud warnings in logs

### Test Command

```bash
cd apps/examples/aplret-bug-reproduction
yarn test:a2a
```

**Expected before fix**: Test FAILS (second call errors)  
**Expected after fix**: Test PASSES (both calls succeed)

### Verification

After applying fix, the test should show:

```
Turn 0: First A2A call ✅
Turn 2: Second A2A call ✅
Bug #2 Test: PASS
```

---

## Testing Strategy

### Unit Test (Minimal)

```bash
yarn test:vars   # Test Bug #1 only (2 turns)
yarn test:a2a    # Test Bug #2 only (requires helper-agent)
```

### Integration Test (Both Bugs)

```bash
yarn test:both   # Test both bugs in sequence
```

### Success Criteria

After fixes applied, running `yarn test:both` should output:

```
📊 Bug Reproduction Test Results:
Bug #1 (Vars Persistence): ✅ PASS
Bug #2 (Multiple A2A): ✅ PASS
```

---

## Code Review Checklist

Before merging fixes:

- [ ] Bug #1 fix: varCache initialized from snapshot in `attachWorkingMemory()`
- [ ] Bug #2 fix: sessionManager always required OR error message improved
- [ ] Test suite passes: `yarn test:both` shows all PASS
- [ ] No regressions in existing tests
- [ ] Documentation updated in `apps/docs/loop/`
- [ ] Example remains in repo as regression test

---

## Timeline

- **Discovery**: 2025-11-08 during `discover-listing-structure` development
- **Debug time**: ~4.5 hours total
- **Reproduction**: This example created same day
- **Priority**: CRITICAL - Blocks production agent development

---

## Additional Context

### Related Files
- Agent hit by bugs: `apps/examples/discover-listing-structure/`
- Debug report: `BUG_REPORT_MEMORY_VARS_PERSISTENCE.md`
- Session notes: Framework bugs session overview document

### Developer Experience Impact

These bugs manifest as:
- Silent state loss (no error, just wrong behavior)
- Misleading error messages (sounds like init problem, not limitation)
- Hours of debugging (checking agent code when framework is culprit)
- Incorrect workarounds (agent developers trying to fix in wrong layer)

### Recommended Follow-up

1. **Immediate**: Fix both bugs
2. **Short-term**: Add integration tests for multi-turn + multi-A2A patterns
3. **Medium-term**: Document session store requirements clearly
4. **Long-term**: Consider making session store mandatory for all loop agents

---

## Questions?

Contact agent developer who discovered these bugs:
- Session: 2025-11-08
- Context: Multi-page validation feature
- Agent: `discover-listing-structure`


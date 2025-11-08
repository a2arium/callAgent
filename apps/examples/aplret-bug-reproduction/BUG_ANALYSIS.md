# Bug Analysis: Memory Persistence Issues

## Bug #1: Memory Vars Not Persisting Between Turns

### Root Cause Analysis

#### Issue 1A: `attachWorkingMemory()` Starts with Empty Cache

**Location:** `packages/core/src/core/orchestration/taskEngine.ts:137-171`

**Problem:**
```typescript
public attachWorkingMemory(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string): void {
    if (!this.sessionManager) return;
    const varCache = new Map<string, unknown>(); // ❌ STARTS EMPTY!
    (ctx as any).vars = new Proxy({} as Record<string, unknown>, {
        get: (_t, prop: string) => varCache.get(prop), // ❌ Will always return undefined!
        set: (_t, prop: string, value: unknown) => {
            varCache.set(prop, value);
            // ... saves to M.memory.vars in snapshot ...
            return true;
        }
    });
}
```

**Expected Behavior:**
The varCache should be initialized from the existing snapshot's `M.memory.vars`, just like `startTask()` does:

```typescript
// From startTask() at line 289-290 (CORRECT IMPLEMENTATION):
const currentVars = ((M.memory as any)?.vars || {}) as Record<string, unknown>;
const varCache = new Map<string, unknown>(Object.entries(currentVars)); // ✅ LOADED FROM SNAPSHOT!
```

**Impact:**
- Child agents (A2A calls) start with empty `ctx.vars` despite `M.memory.vars` containing persisted data
- Agent code reading `ctx.vars.someKey` gets `undefined` instead of the persisted value
- Creates illusion that vars "don't persist" across turns

**Affected Code Paths:**
- `A2AService.ts:125` - When executing child agents
- `A2AService.ts:633` - Loop-first agents via TaskEngine
- `A2AService.ts:643` - Fallback engine path

---

#### Issue 1B: `handleChildCompleted()` Doesn't Setup `ctx.vars` Proxy

**Location:** `packages/core/src/core/orchestration/taskEngine.ts:2127-2200`

**Problem:**
```typescript
async handleChildCompleted(params: { ... }): Promise<void> {
    // ...
    const ctx = this.createContext({ id: parentTaskId, input: {} }); // ❌ Fresh context
    (ctx as any).tenantId = tenantId;
    // ...
    let M: MentalState = (baseNow as any).M as MentalState || initialM(ctx);
    await this.attachAndRestoreLLM(ctx, agentName, M);
    // ❌ MISSING: this.attachWorkingMemory(ctx, tenantId, parentTaskId, agentName);
    // ...
    const { M: mNext, outcome, metrics } = await runLoop(ctx, M, env, overrides, loopOpts);
}
```

**Expected Behavior:**
Before calling `runLoop()`, the method should set up the `ctx.vars` proxy by calling:
```typescript
this.attachWorkingMemory(ctx, tenantId, parentTaskId, agentName || 'default');
```

**Impact:**
- Parent agents resuming after A2A child completion don't have `ctx.vars` proxy
- Reading `ctx.vars` returns the raw empty object `{}`
- Agents lose all working memory state on resume
- Combined with Issue 1A, this creates complete memory loss during A2A flows

---

### The Fix for Bug #1

#### Part 1: Fix `attachWorkingMemory()` to Load Existing Vars

```typescript
public attachWorkingMemory(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string): void {
    if (!this.sessionManager) return;
    
    // ✅ Load existing vars from snapshot (like startTask does)
    const snapshot = await this.sessionManager.load(tenantId, sessionId);
    const M = (snapshot?.snapshot as any)?.M;
    const currentVars = ((M?.memory as any)?.vars || {}) as Record<string, unknown>;
    const varCache = new Map<string, unknown>(Object.entries(currentVars)); // ✅ INITIALIZE FROM SNAPSHOT!
    
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

**Key Changes:**
1. Load snapshot at the start
2. Extract `M.memory.vars` from snapshot
3. Initialize varCache with these values using `Object.entries(currentVars)`
4. Now `ctx.vars.someKey` will return persisted values!

**Note:** This requires making `attachWorkingMemory()` async, which means updating all call sites.

---

#### Part 2: Call `attachWorkingMemory()` in `handleChildCompleted()`

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

**Impact:**
- Parent agents resuming after A2A now have `ctx.vars` properly set up
- Combined with Part 1, all persisted vars are accessible
- Memory persistence works correctly across A2A boundaries

---

## Bug #2: Multiple Sequential A2A Calls Not Supported

### Root Cause Analysis

**Location:** `packages/core/src/core/orchestration/taskEngine.ts:137-138`

**Problem:**
```typescript
public attachWorkingMemory(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string): void {
    if (!this.sessionManager) return; // ❌ Silent failure if no session manager!
    // ... rest of method ...
}
```

**Context:**
When agents are run via CLI (`runAgentWithStreaming`), the `TaskEngine` is often instantiated without a `SessionManager`. The `sendTaskToAgent` implementation relies on `attachWorkingMemory()` to set up persistence, but this silently fails when `sessionManager` is null.

**From Bug Report:**
> When trying to make two sequential `sendTaskToAgent()` calls within a single turn, the second call fails with: `Error: No session manager configured`

**Expected Behavior:**
1. Either: Ensure TaskEngine always has a SessionManager when A2A is used
2. Or: Provide clear error message when A2A is attempted without SessionManager
3. Or: Implement in-memory fallback for A2A without persistence

**Current Flow:**
```typescript
// In restoreCtx() at line 2753:
(ctx as any).sendTaskToAgent = async (agent: string, childInput: unknown, options?: {...}) => {
    // ... creates minimal context ...
    const minimalCtx = this.createContext({ id: childTaskId, input: childInput });
    // ... A2AService calls back to TaskEngine.attachWorkingMemory() ...
    // ❌ If sessionManager is null, attachWorkingMemory() returns early
    // ❌ Child agent has no persistence, second call fails
};
```

**Impact:**
- First A2A call may work (if no state needed)
- Second A2A call fails because parent's state wasn't persisted after first call
- Multi-step workflows with A2A are impossible in CLI mode
- Production deployments require complex SessionManager setup just to use A2A

---

### The Fix for Bug #2

#### Option A: Require SessionManager for A2A (Fail Fast)

```typescript
public attachWorkingMemory(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string): void {
    if (!this.sessionManager) {
        // ✅ Fail fast with clear error
        throw new Error(
            'SessionManager required for A2A calls. ' +
            'Configure TaskEngine with a SessionManager before calling sendTaskToAgent(). ' +
            'See docs/a2a/setup.md for details.'
        );
    }
    // ... rest of method ...
}
```

**Pros:**
- Clear error message guides developers
- No silent failures
- Simple implementation

**Cons:**
- CLI demos can't use A2A without DB setup
- Higher barrier to entry for testing

---

#### Option B: In-Memory Fallback for CLI/Testing

```typescript
public attachWorkingMemory(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string): void {
    if (!this.sessionManager) {
        // ✅ In-memory fallback for CLI/testing
        console.warn('[TaskEngine] No SessionManager configured - using in-memory storage (not suitable for production)');
        this.setupInMemoryVars(ctx, tenantId, sessionId, agentId);
        return;
    }
    // ... persistent implementation ...
}

private setupInMemoryVars(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string): void {
    // Simple in-memory store for testing
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
            varCache.has(prop as string) ? { enumerable: true, configurable: true } : undefined
    });
}
```

**Pros:**
- CLI demos work out of the box
- Lower barrier to entry
- Testing doesn't require DB setup
- Graceful degradation

**Cons:**
- More complex implementation
- Need to maintain two code paths
- Risk of developers using in-memory mode in production

---

#### Option C: Auto-Configure In-Memory SessionManager

```typescript
constructor() {
    // ✅ Default to in-memory session manager for testing
    this.sessionManager = new InMemorySessionManager();
}

// In runner/streamingRunner.ts:
export async function runAgentWithStreaming(...) {
    // For production, override with real SessionManager:
    if (config.database) {
        const realSessionManager = await createPrismaSessionManager(config.database);
        taskEngine.setSessionManager(realSessionManager);
    }
    // Otherwise uses default in-memory manager
}
```

**Pros:**
- Seamless experience - A2A "just works"
- Clear path to production (configure database)
- Single code path for persistence logic
- Best developer experience

**Cons:**
- Might hide persistence requirements until production
- Need to implement InMemorySessionManager

---

### Recommended Fix: Option C + Clear Warnings

1. Implement lightweight `InMemorySessionManager` for testing/CLI
2. TaskEngine defaults to in-memory mode
3. Log clear warnings when using in-memory mode:
   ```
   [WARN] TaskEngine using in-memory persistence - not suitable for production
   [WARN] Configure a database-backed SessionManager for production deployments
   [WARN] See: docs/a2a/production-setup.md
   ```
4. Production runners explicitly configure real SessionManager

---

## Summary

### Bug #1 Fix: 2 Changes Required
1. ✅ Make `attachWorkingMemory()` async and load vars from snapshot
2. ✅ Call `attachWorkingMemory()` in `handleChildCompleted()` before `runLoop()`

### Bug #2 Fix: Choose One Approach
- **Option A**: Fail fast with clear error (simplest)
- **Option B**: In-memory fallback in `attachWorkingMemory()` (moderate)
- **Option C**: Default InMemorySessionManager (best UX, recommended)

### Verification Steps
After fixes are applied:
1. Run bug reproduction agent with `test-vars` mode → should PASS
2. Run bug reproduction agent with `test-a2a` mode → should PASS (both A2A calls succeed)
3. Run bug reproduction agent with `test-both` mode → should PASS (all tests)
4. Verify production deployments use database-backed SessionManager

---

## Code Patches Ready to Apply

The framework team can apply these patches to fix both bugs. See `FRAMEWORK_TEAM_NOTES.md` for detailed patch code.


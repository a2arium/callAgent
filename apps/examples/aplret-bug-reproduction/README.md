# APLRET Bug Reproduction Agent

This example reproduces two critical framework bugs discovered during production agent development.

## Purpose

Demonstrates framework issues that block production APLRET agents:

1. **Bug #1**: Agent memory vars not persisting between turns (CRITICAL)
2. **Bug #2**: Multiple sequential A2A calls not supported (HIGH)

## Architecture

Pure APLRET implementation following `apps/docs/loop/aplret-dev-instructions.md`:

- **A** - Attention: Focus control
- **P** - Perception: Normalize inbox observations
- **L** - Learning: Update MentalState (single writer of M)
- **R** - Policy: Decide intents (pure function of M)
- **E** - Execution: Stage dispatcher with typed intents
- **T** - Transition: Control flow (continue/await/complete)

## Bug #1: Memory Vars Persistence

### Expected Behavior

```typescript
// Turn 1: Learning writes vars
learning: (prev, _, obs) => ({
  ...prev,
  memory: {
    ...prev.memory,
    vars: { counter: 1, sessionId: 'abc123' }
  }
})

// Turn 2: Policy should read vars from M
policy: (m) => {
  const counter = m.memory.vars?.counter; // Should be 1
  const sessionId = m.memory.vars?.sessionId; // Should be 'abc123'
}
```

### Actual Behavior

```
Turn 1 End: M.memory.vars = { counter: 1, sessionId: 'abc123' } ✅
Turn 2 Start: M.memory.vars = {} ❌ LOST!
```

**Result**: Agent can't maintain state, infinite loops, multi-step workflows impossible.

## Bug #2: Multiple A2A Calls

### Expected Behavior

```typescript
// Turn 1: First A2A call
await ctx.sendTaskToAgent('helper-agent', { task: 1 });
// → await_child

// Turn 3: Second A2A call (after first completes)
await ctx.sendTaskToAgent('helper-agent', { task: 2 });
// → Should work!
```

### Actual Behavior

```
Turn 1: First sendTaskToAgent → SUCCESS ✅
Turn 3: Second sendTaskToAgent → ERROR ❌
  "ctx.sendTaskToAgent is unavailable because TaskEngine was 
   constructed without a working-memory session store."
```

**Result**: Can't do multi-step orchestration with sub-agents.

## Running the Demo

```bash
# Build
cd apps/examples/aplret-bug-reproduction
yarn build

# Run (will demonstrate both bugs)
yarn callagent run dist/BugReproAgent.js '{"mode":"test-both"}'
```

## Expected Output

### Bug #1 Test
```
Turn 1: Writing counter=1 to M.memory.vars
Turn 2: Reading counter from M.memory.vars
  Expected: 1
  Actual: undefined ❌ BUG REPRODUCED
```

### Bug #2 Test
```
Turn 1: Calling helper-agent (first time)
  Status: SUCCESS ✅
Turn 3: Calling helper-agent (second time)
  Status: ERROR ❌ BUG REPRODUCED
  Message: "Session manager not configured"
```

## Framework Fix Required

### Bug #1 Fix
Update `TaskEngine.attachWorkingMemory()` to initialize varCache from snapshot:

```typescript
public attachWorkingMemory(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string): void {
    if (!this.sessionManager) return;
    
    const varCache = new Map<string, unknown>();
    
    // FIX: Load agent vars from snapshot
    const snapshot = await this.sessionManager.load(tenantId, sessionId);
    const M = (snapshot?.snapshot as any)?.M;
    const agentVars = M?.memory?.vars || {};
    for (const [key, value] of Object.entries(agentVars)) {
        varCache.set(key, value);
    }
    
    // ... rest of proxy setup
}
```

### Bug #2 Fix
Enable session store by default:

```typescript
constructor(opts?: { sessionStore?: IWorkingMemorySessionStore }) {
    // Always require session store for multi-A2A support
    if (!opts?.sessionStore) {
        throw new Error('SessionStore required for A2A agents');
    }
    this.sessionManager = new SessionManager(opts.sessionStore);
}
```

## Contact

Created for framework bug tracking - 2025-11-08
Reference: Session implementing multi-page validation in `discover-listing-structure`


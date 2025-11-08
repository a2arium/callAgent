# Testing Guide

## Quick Start

```bash
cd apps/examples/aplret-bug-reproduction
yarn build
```

## Test Scenarios

### Scenario 1: Test Bug #1 Only (Memory Vars Persistence)

```bash
yarn test:vars
```

**Expected Output:**
```
Turn 0: Writing test vars to M.memory.vars
📝 Writing to M.memory.vars:
{
  "counter": 1,
  "sessionId": "test-session-abc123",
  "timestamp": 1699999999999
}

Turn 1: Reading vars from M.memory.vars
❌ Bug #1 Test: FAIL - Vars were lost!

Expected: { counter: 1, sessionId: 'test-session-abc123', timestamp: <number> }
Actual: { counter: undefined, sessionId: undefined, timestamp: undefined }

🐛 BUG REPRODUCED: Agent-defined vars in M.memory.vars do not persist between turns.
```

### Scenario 2: Test Bug #2 Only (Multiple A2A Calls)

```bash
yarn test:a2a
```

**Expected Output:**
```
Turn 0: First A2A call
✅ First A2A call succeeded

Turn 1: (child completes)

Turn 2: Second A2A call
❌ Bug #2 Test: FAIL - Second A2A call failed!

Error: ctx.sendTaskToAgent is unavailable because TaskEngine was 
       constructed without a working-memory session store.

🐛 BUG REPRODUCED: Framework only supports single A2A call per task.
```

### Scenario 3: Test Both Bugs

```bash
yarn test:both
```

**Expected Output:**
```
🧪 Testing Bug #1: Memory vars persistence
[Turn 0] Writing vars...
[Turn 1] Reading vars...
❌ Bug #1: FAIL

🧪 Testing Bug #2: Multiple A2A calls
[Turn 2] First A2A call...
✅ First call succeeded
[Turn 3] Second A2A call...
❌ Bug #2: FAIL

📊 Bug Reproduction Test Results:
Bug #1 (Vars Persistence): ❌ FAIL
Bug #2 (Multiple A2A): ❌ FAIL
```

## Debugging

### Enable Debug Logs

```bash
DEBUG=* yarn test:both
```

### Check Turn-by-Turn State

The agent logs detailed state at each turn:

- `[Perception]` - What inbox observations were received
- `[Learning]` - How mental state was updated
- `[Policy]` - What intent was chosen based on M
- `[Execution]` - What action was performed
- `[Transition]` - What control signal was returned

### Verify Snapshot Persistence

After Bug #1 test (Turn 1), check that vars were written but not restored:

```
[Learning] Turn 0: Writing to M.memory.vars
  counter: 1
  sessionId: 'test-session-abc123'

[Policy] Turn 1: Reading from M.memory.vars
  counter: undefined ← BUG!
  sessionId: undefined ← BUG!
```

## What Success Looks Like

Once the framework bugs are fixed, all tests should pass:

```
📊 Bug Reproduction Test Results:
Bug #1 (Vars Persistence): ✅ PASS
Bug #2 (Multiple A2A): ✅ PASS
```

## Architecture Validation

This agent follows pure APLRET architecture:

✅ **Attention**: Focus control (checks inbox)  
✅ **Perception**: Normalizes observations into typed Obs  
✅ **Learning**: Single writer of MentalState (immutable updates)  
✅ **Policy**: Pure function of M (no env/ctx reads)  
✅ **Execution**: Stage dispatcher with typed intents  
✅ **Transition**: Control flow management  

## Framework Team: Verification Steps

1. Run tests to confirm bugs reproduce
2. Apply fixes to `TaskEngine`
3. Re-run tests to verify fixes
4. All tests should pass after fixes

### Bug #1 Fix Location

`packages/core/src/core/orchestration/taskEngine.ts`
- Method: `attachWorkingMemory()`
- Issue: varCache not initialized from snapshot
- Fix: Load M.memory.vars into varCache on initialization

### Bug #2 Fix Location

`packages/core/src/core/orchestration/taskEngine.ts`
- Method: `constructor()` and `startTask()`
- Issue: sessionManager not required
- Fix: Always initialize sessionManager for A2A support

## Contact

For questions about this reproduction:
- Reference: Framework bugs discovered 2025-11-08
- Original agent: `discover-listing-structure`
- Session: Multi-page validation implementation


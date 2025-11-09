# FINAL ROOT CAUSE: Race Condition in runLoop/oneTurn

## The Smoking Gun

```
[runLoop] BEFORE oneTurn, m.memory.vars: []                                    <-- Call 1 starts
[oneTurn] Learning returned M with memory.vars: [ 'testCounter', 'testMode' ] <-- Call 1: Learning works!
[runLoop] BEFORE oneTurn, m.memory.vars: []                                    <-- Call 2 starts (DUPLICATE!)
[oneTurn] Learning returned M with memory.vars: []                             <-- Call 2: Learning returns empty
[runLoop] AFTER oneTurn, step.m.memory.vars: []                                <-- Call 2 completes FIRST
[runLoop] AFTER oneTurn, step.m.memory.vars: [ ... ]                           <-- Call 1 completes SECOND
```

## Analysis

**`oneTurn` is being called TWICE in parallel!**

1. **First call**: Starts with empty M, Learning correctly adds `testCounter` and `testMode`
2. **Second call**: Also starts with empty M (race condition!), Learning returns empty M
3. **Second call completes FIRST**: Overwrites the good result
4. **First call completes SECOND**: Its result is logged but ignored

## Root Cause Options

### Option A: `runLoop` called twice in parallel
`TaskEngine` might be calling `runLoop` multiple times for the same task concurrently.

**Check**: Add logging at `runLoop` entry point with unique IDs:
```typescript
const runId = Math.random().toString(36).substring(7);
console.log(`[runLoop ${runId}] ENTRY`);
```

### Option B: Async issue in loopRunner for-loop
The `for (let turn = 0; turn < maxTurns; turn++)` loop might not be awaiting properly, causing overlapping `oneTurn` calls.

**Evidence Against**: The code has `await oneTurn(...)` so this should block.

### Option C: Multiple agents running concurrently
Parent and child agents might both be running and their logs are interleaved.

**Check**: Add agent ID to all logs:
```typescript
console.log(`[runLoop ${ctx.task.id}] BEFORE oneTurn...`);
```

## Hypothesis

**Most Likely**: Multiple `runLoop` calls are happening concurrently for the same task. This could be:
1. Helper agent's `runLoop` interleaved with parent's `runLoop`
2. A2A framework accidentally calling `startTask` twice
3. Streaming mode causing duplicate execution

## Verification Steps

1. **Add unique IDs to all logs**:
```typescript
// In loopRunner.ts
export async function runLoop<...>(ctx, M, env, defaults, opts) {
    const runId = Math.random().toString(36).substring(7);
    const taskId = ctx.task.id.substring(0, 15);
    console.log(`[runLoop ${taskId}/${runId}] ENTRY`);
    
    for (let turn = 0; turn < maxTurns; turn++) {
        console.log(`[runLoop ${taskId}/${runId}] BEFORE oneTurn turn=${turn}`);
        const step = await oneTurn(...);
        console.log(`[runLoop ${taskId}/${runId}] AFTER oneTurn turn=${turn}`);
    }
}
```

2. **Filter logs by one agent**:
```bash
grep "local-task-" output.log | grep "BEFORE oneTurn\|AFTER oneTurn"
```

## Expected Outcome

If Option A (duplicate runLoop):
```
[runLoop local-task-123/abc123] ENTRY
[runLoop local-task-123/xyz789] ENTRY  <-- DUPLICATE!
```

If Option C (multiple agents):
```
[runLoop local-task-123/abc123] BEFORE oneTurn
[runLoop a2a_task_456/def456] BEFORE oneTurn  <-- Different task ID
```

## Impact

This race condition explains:
- ✅ Why Learning's vars are lost (second call overwrites first)
- ✅ Why logs show interleaved execution
- ✅ Why Bug #1H fix didn't work (second call has no vars to preserve)
- ✅ Why infinite loop happens (wrong M is used for next turn)

## Next Action

Add the unique ID logging to determine which option is the root cause, then fix accordingly.


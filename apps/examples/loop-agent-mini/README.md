# Loop Agent Mini - LLM History Persistence Demo

This example demonstrates how the CalAgent framework **automatically preserves LLM conversation history across loop turns**.

## What This Demo Shows

The agent conducts a simple 3-turn conversation with the LLM that proves history is preserved:

1. **Turn 1**: Agent asks LLM "Tell me a fun fact about space"
2. **Turn 2**: Agent asks LLM "What's another fun fact?" (LLM has context from Turn 1!)
3. **Turn 3**: Agent asks LLM "Can you combine both facts into a short story?" (LLM has context from Turns 1 & 2!)

**The key point**: The LLM in Turn 3 successfully references BOTH previous facts when creating the story, proving that conversation history persists across loop turns automatically.

## Why This Is Simple

This demo doesn't use `requestInput`, A2A calls, or any async operations. It just runs 3 consecutive loop turns in a single task execution. This proves that:

- **MentalState (including `M.memory.sensory.llmState`) is saved after every loop turn**
- **LLM history persists naturally as part of the loop's cognitive cycle**
- You don't need special async boundaries to benefit from history persistence!

## How It Works

### The Loop Cycle

Every loop turn in the framework follows this pattern:

1. **Load MentalState** - If resuming, load previous `M` from storage
2. **Run Turn** - Execute attention → perception → learning → policy → execution → transition
3. **Update MentalState** - Learning updates `M` with new observations
4. **Update LLM State** - The loop automatically captures current LLM history into `M.memory.sensory.llmState`
5. **Save MentalState** - After `runLoop` completes, save the updated `M` to storage

### In This Demo

- **Turn 1**: LLM answers first question → `M.memory.sensory.llmState` stores message history → Saved
- **Turn 2**: Loop continues → LLM state from Turn 1 is already in `M` → LLM answers with context → Saved
- **Turn 3**: Loop continues → LLM has full history from Turns 1 & 2 → Creates story combining both facts → Saved

No special code needed! The framework handles it automatically.

### The Fix

This demo verifies the fix implemented in `taskEngine.ts`:

```typescript
// New helper that attaches LLM and restores its state
private async attachAndRestoreLLM(
    ctx: TaskContext, 
    agentName: string | undefined, 
    M: MentalState | undefined
): Promise<void>
```

This helper is now called in all context restoration points:
- `restoreCtx` (durable handlers)
- `resumeInput` (user input)
- `handleToolCompleted` (async tools)
- `handleChildCompleted` (child agents)
- `handleExternalEventOccurred` (external events)

## Prerequisites

Set your Anthropic API key:
```bash
export ANTHROPIC_API_KEY=your-key-here
```

Or add it to `.env`:
```
ANTHROPIC_API_KEY=your-key-here
```

## Running the Demo

### Option 1: Using yarn script (from repo root)

```bash
# From /Users/maximantonov/Work/_lab/callagent
yarn build
yarn run:loop-mini
```

### Option 2: Direct runner invocation

```bash
# Build first
cd /Users/maximantonov/Work/_lab/callagent
yarn build

# Run with streaming
node packages/core/dist/runner/runnerCli.js \
  apps/examples/loop-agent-mini/dist/AgentModule.js \
  '{}' \
  --stream \
  --format=console
```

### Option 3: Development mode (TypeScript directly)

```bash
node --loader ts-node/esm packages/core/src/runner/runnerCli.ts \
  apps/examples/loop-agent-mini/AgentModule.ts \
  '{}' \
  --stream \
  --format=console \
  --no-resolve-deps
```

## Expected Output

```
📍 [Policy] Turn 0

💬 [User]: Tell me a fun fact about space.
🤖 [Assistant]: Did you know that a day on Venus is longer than a year on Venus? 
It takes Venus about 243 Earth days to complete one rotation on its axis, 
but only about 225 Earth days to orbit the Sun!

📍 [Policy] Turn 1

💬 [User]: That was interesting! What's another fun fact about space?
🤖 [Assistant]: Here's another cool one: There's a giant cloud of alcohol floating 
in space! Discovered in a star-forming region called Sagittarius B2, this cloud 
contains enough ethyl alcohol to fill 400 trillion trillion pints of beer!

📍 [Policy] Turn 2

💬 [User]: Great! Can you combine both of those facts into a very short 2-sentence story?
🤖 [Assistant]: On Venus, where days outlast years, astronomers gathered under the 
slow-turning sky to celebrate their discovery of Sagittarius B2's cosmic brewery. 
They raised their glasses toward the clouds of space alcohol, knowing they'd have 
plenty of time to toast—each Venusian day lasting longer than their entire orbit 
around the Sun!

✅ Demo Complete!
📝 The LLM successfully referenced previous turns in its final story,
   proving that conversation history was preserved across all turns.
```

## Testing the Fix

To verify LLM history is working:

1. Run the demo
2. Watch for the Turn 3 story - it should reference BOTH space facts from Turns 1 and 2
3. If the story only mentions one fact or is generic, history preservation failed
4. Console logs to watch for (if enabled):
   - Updates to `M.memory.sensory.llmState` after each LLM call
   - MentalState being saved after each loop turn

## Troubleshooting

### LLM history not preserved

Check console logs for:
- `[TaskEngine] Failed to restore LLM state` - restoration failed
- Missing `messages count` logs - history not being captured

### API errors

```bash
# Verify API key is set
echo $ANTHROPIC_API_KEY

# Or check .env file
cat .env | grep ANTHROPIC
```

### Build issues

```bash
# Clean and rebuild
yarn clean
yarn build
```

## Architecture Notes

This example uses the **loop module pattern** where you define:

- `attention`: Focus selection (not used in this simple demo)
- `perception`: Convert environment input to observations
- `learning`: Update mental state with new observations
- `policy`: Decide what action to take based on state
- `shield`: Safety/validation layer for actions
- `execution`: Perform side effects (LLM calls, requestInput, etc.)
- `transition`: Determine loop control flow (continue/await/complete)

The framework handles all the complexity of:
- Persisting mental state between turns
- Saving/restoring LLM conversation history
- Managing async operations (requestInput, tools, child agents)
- Event emission and streaming

## Related Files

- **Framework fix**: `packages/core/src/core/orchestration/taskEngine.ts`
- **LLM adapter**: `packages/core/src/core/llm/LLMCallerAdapter.ts`
- **Loop runner**: `packages/core/src/loop/loopRunner.ts`
- **Types**: `packages/core/src/loop/types.ts`


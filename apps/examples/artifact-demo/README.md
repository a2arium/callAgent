# Artifact Demo - Large Payload Handling

This example demonstrates the **Artifact<T>** pattern for handling large payloads in the A2A framework using the APLRET architecture.

## Problem

When agents generate or receive large data (megabytes of JSON, text, etc.), storing it directly in the mental state causes:
- **Snapshot bloat**: Mental state snapshots exceed size limits (2MB default)
- **Agent amnesia**: Framework drops the entire state when limits are exceeded
- **Performance degradation**: Serialization/deserialization becomes expensive

## Solution: Artifact<T>

The `Artifact<T>` pattern offloads large data to a separate storage layer (database) while keeping only a lightweight **handle** in the mental state.

### Key Features

1. **Explicit Offloading**: Developers use `ctx.artifacts.create()` to explicitly mark large data for offloading
2. **Awaitable Handle**: The `Artifact<T>` is both a storage handle (`.set()`, `.load()`) and a Promise-like object (`await artifact`)
3. **Transparent Hydration**: When snapshots are loaded, artifact markers are automatically re-attached with storage methods
4. **Type Safe**: TypeScript knows that `Artifact<T>` can be awaited to get `T`

## Example Structure

This demo agent can run in two modes:
- **Producer mode** (`mode: 'producer'`): Generates 1MB+ of dummy text and stores it as an artifact
- **Consumer mode** (`mode: 'consumer'`): Spawns a child in producer mode, receives the artifact handle, and loads data on-demand

The agent follows the APLRET pattern:
- **Attention**: Detects child completion events
- **Perception**: Extracts artifact handles from observations
- **Learning**: Updates mental state with received artifacts
- **Policy**: Decides whether to generate data, spawn a child, or process artifacts
- **Execution**: Performs offloading, child spawning, or artifact loading
- **Transition**: Updates mental state based on execution results

## Usage

### Producer Mode (Generate large data)

```typescript
const engine = new TaskEngine({ sessionStore: yourPrismaStore });
await engine.startTask({
    task: { 
        id: 'producer-demo', 
        input: { 
            mode: 'producer', 
            sizeKB: 1024 // Generate 1MB
        } 
    },
    agentId: 'artifact-demo',
    tenantId: 'demo-tenant'
});
```

### Consumer Mode (Spawn child and consume artifacts)

```typescript
const engine = new TaskEngine({ sessionStore: yourPrismaStore });
await engine.startTask({
    task: { 
        id: 'consumer-demo', 
        input: { 
            mode: 'consumer', 
            sizeKB: 2048 // Child will generate 2MB
        } 
    },
    agentId: 'artifact-demo',
    tenantId: 'demo-tenant'
});
```

### In Execution Module (APLRET Pattern)

```typescript
execution: async (intent, ctx, m) => {
    // Generate and offload large data
    if (intent.kind === 'generate-data') {
        const largeText = generateLargeString(intent.sizeKB);
        const artifact = await ctx.artifacts.text(largeText);
        return { kind: 'done', result: { artifact } };
    }
    
    // Load artifact on-demand
    if (intent.kind === 'process-artifact') {
        const artifactHandle = intent.result.artifact;
        const actualData = await artifactHandle; // Load from storage
        // Process the data...
        return { kind: 'done', result: { processed: true } };
    }
}
```

## What to Observe

Check the logs to see:

### Producer Mode
```
🔧 [ARTIFACT-DEMO] Generating large data { sizeKB: 1024 }
✅ [ARTIFACT-DEMO] Generated large text { sizeBytes: 1048576, sizeKB: 1024 }
💾 [ARTIFACT-DEMO] Data offloaded to artifact { artifactId: 'uuid...', estimatedSize: 1048576 }
```

### Consumer Mode
```
🚀 [ARTIFACT-DEMO] Spawning child to generate data { sizeKB: 1024 }
⏳ [ARTIFACT-DEMO] Waiting for child { token: 'token...' }
📬 [ARTIFACT-DEMO] Child completed { status: 'success', message: '...' }
🔍 [ARTIFACT-DEMO] Received artifact handle { artifactId: 'uuid...', estimatedSize: 1048576 }
⏳ [ARTIFACT-DEMO] Loading data from artifact...
✅ [ARTIFACT-DEMO] Data loaded { dataSizeKB: 1024, preview: '...' }
📊 [ARTIFACT-DEMO] Analysis complete { lineCount: 1870, wordCount: 18700 }
```

Key observations:
- **Snapshot size**: Remains small despite 1MB+ payload (only ~200 bytes for the handle)
- **Artifact handle**: Contains only metadata (`id`, `mimeType`, `estimatedSize`)
- **On-demand loading**: Data is loaded explicitly when `await artifact` is called
- **No LIMIT_WM_SNAPSHOT_TOO_LARGE errors**: Framework can save snapshots successfully

## Pruning Safety Net

If you forget to use artifacts and store large data directly, the framework will:
1. Attempt to save the snapshot
2. Hit `LIMIT_WM_SNAPSHOT_TOO_LARGE` error
3. **Truncate** large strings with a **LOUD warning**:
   ```
   LOUD WARNING: Pruned large string at path 'M.memory.vars.result' from 1048576 to 51200 characters.
   Consider using ctx.artifacts.create() for this data.
   ```
4. Retry saving with truncated data

This ensures the agent doesn't lose its entire state, but encourages proper artifact usage.

## Best Practices

1. **Use artifacts for data > 50KB**: This is the pruning threshold
2. **Offload proactively**: Don't wait for errors - use artifacts from the start
3. **Never await if not needed**: Only `await` the artifact when you need the actual data
4. **Type your artifacts**: `Artifact<YourDataType>` for better IntelliSense


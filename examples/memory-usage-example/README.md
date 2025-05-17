# Minimal Memory Example

This example demonstrates the most basic usage of the memory system in the agent framework - just storing and retrieving information.

## What It Does

The agent can:
1. **Remember facts** when you say "Remember that X is Y"
2. **Recall facts** when you ask "What is X?"

That's it! This minimal example shows the core functionality without any complexity.

## Running the Example

1. Set up the PostgreSQL database:
   ```bash
   # Add to .env file
   MEMORY_DATABASE_URL=postgresql://username:password@localhost:5432/memory_example
   ```

2. Create the database:
   ```bash
   createdb memory_example
   ```

3. Run the migrations:
   ```bash
   npx prisma migrate dev
   ```

4. Run the example:
   ```bash
   yarn start
   ```

## How It Works

The example demonstrates two essential memory operations:

```typescript
// 1. Store data in memory
await ctx.memory.set<FactData>(memoryKey, {
    fact: key.trim(),
    value: value.trim()
});

// 2. Retrieve data from memory
const fact = await ctx.memory.get<FactData>(memoryKey);
```

This minimal pattern can be extended to build more complex memory systems in your agents. 
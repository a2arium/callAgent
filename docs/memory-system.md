# Memory System

This document explains how to use the agent framework's memory system to provide durable, long-term storage capabilities for your agents, **with a focus on usage as a library consumer**.

## Overview

The memory system provides a standardized interface (`IMemory`) for agents to store, retrieve, and query data persistently across different executions. It's accessible through the context object passed to agents:

```typescript
// Inside the handleTask function of an agent
async handleTask(ctx: TaskContext) {
  // Access memory through the context
  await ctx.memory.set('conversation-123', { lastMessage: 'Hello' });
  const conversation = await ctx.memory.get('conversation-123');
}
```

Currently, the framework implements a SQL-based memory adapter (`MemorySQLAdapter`) that uses PostgreSQL as its backing store, with Prisma ORM handling database operations.

## Using the Memory System in Your Application

The memory system is designed to be used as a library. This means:
- **You, the application developer, are responsible for managing the database schema and migrations.**
- **You must copy the required Prisma model(s) into your own `schema.prisma`.**
- **You generate and manage your own Prisma Client instance.**
- **You pass your PrismaClient instance to the memory adapter provided by the library.**

### 1. Add the Required Model to Your `schema.prisma`

Copy the following model definition into your application's `schema.prisma`:

```prisma
model AgentMemoryStore {
  key       String   @id
  value     Json
  tags      String[]
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  @@map("agent_memory_store")
}
```

> **Note:**
> - You may add additional models as needed for your application.
> - If the library updates its schema, you must update your own `schema.prisma` accordingly and run a new migration.

### 2. Set Up Your Database and Environment

- Ensure you have a PostgreSQL database available.
- Add a connection string to your `.env` file:

```env
MEMORY_DATABASE_URL="postgresql://username:password@host:port/database_name"
```

### 3. Run Prisma Migrations

Run the following commands in your application root:

```bash
npx prisma migrate dev --name init-memory
npx prisma generate
```

This will create the `agent_memory_store` table in your database and generate the Prisma Client for your app.

### 4. Install Required Dependencies

In your application, install Prisma and the library:

```bash
yarn add @prisma/client
# (and your agent framework library, e.g. 'callagent')
```

### 5. Configure and Use the Memory Adapter

In your application startup code:

```typescript
import { PrismaClient } from '@prisma/client';
import { MemorySQLAdapter } from 'callagent'; // or your library's package name

// Create a singleton PrismaClient for memory operations
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.MEMORY_DATABASE_URL
    }
  }
});

// Pass your PrismaClient instance to the memory adapter
const memory = new MemorySQLAdapter(prisma);

// Use the memory adapter in your agents or services
```

> **Best Practice:**
> - Do **not** export a PrismaClient from the library. The application should always own and manage the PrismaClient instance.

### 6. Example: Using Memory in an Agent

```typescript
import { createAgent } from 'callagent';

export default createAgent({
  manifest: './agent.json',
  handleTask: async (ctx) => {
    // Store information in memory
    await ctx.memory.set('user-preference', {
      theme: 'dark',
      language: 'en-US'
    }, {
      tags: ['preference', 'user-settings']
    });

    // Retrieve information from memory
    const preference = await ctx.memory.get('user-preference');
    ctx.logger.info(`User prefers ${preference.theme} theme`);
    await ctx.reply([{ type: 'text', text: 'Preferences saved!' }]);
    ctx.complete();
  }
}, import.meta.url);
```

## Using Memory in Agents

Agents created with the `createAgent` factory function have access to the memory system through the context object:

```typescript
import { createAgent } from '../core/plugin/index.js';

export default createAgent({
  manifest: './agent.json',
  
  handleTask: async (ctx) => {
    // Store information in memory
    await ctx.memory.set('user-preference', { 
      theme: 'dark',
      language: 'en-US' 
    }, { 
      tags: ['preference', 'user-settings'] 
    });
    
    // Retrieve information from memory
    const preference = await ctx.memory.get('user-preference');
    
    // Use the retrieved data
    ctx.logger.info(`User prefers ${preference.theme} theme`);
    
    // Complete the task
    await ctx.reply([{ type: 'text', text: 'Preferences saved!' }]);
    ctx.complete();
  }
}, import.meta.url);
```

The memory system is automatically injected into the context and ready to use in any agent that needs persistent storage.

## Setting Up MemorySQLAdapter

### Prerequisites

- PostgreSQL database (v12 or later recommended)
- Prisma CLI (`yarn add -D prisma`)
- Prisma Client (`yarn add @prisma/client`)

### Database Initialization

1. Configure your PostgreSQL connection in your environment:

```bash
# Add to your .env file
MEMORY_DATABASE_URL="postgresql://username:password@host:port/database_name"
```

2. Create the database if it doesn't exist:

```bash
createdb database_name
# OR
psql -c "CREATE DATABASE database_name;"
```

3. Run Prisma migrations to create the necessary tables:

```bash
npx prisma migrate dev
```

This will create the `agent_memory_store` table with the correct schema in your PostgreSQL database.

### Framework Configuration

To configure your application to use the `MemorySQLAdapter`:

1. In your application startup code (where you configure dependency injection):

```typescript
import { PrismaClient } from '@prisma/client';
import { MemorySQLAdapter } from './src/core/memory/adapters/MemorySQLAdapter.js';
import { IMemory } from './src/core/memory/IMemory.js';

// Create a singleton PrismaClient for memory operations
const memoryPrisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.MEMORY_DATABASE_URL
    }
  }
});

// Configure your DI container (examples shown for both InversifyJS and a simple factory)

// InversifyJS example:
container.bind<PrismaClient>("MemoryPrismaClient").toConstantValue(memoryPrisma);
container.bind<IMemory>("Memory").to(MemorySQLAdapter);

// OR using a factory approach:
function createMemoryAdapter(): IMemory {
  return new MemorySQLAdapter(memoryPrisma);
}
```

## Basic Usage

### Storing Data

```typescript
// Store simple data
await ctx.memory.set('user-123-settings', { 
  theme: 'dark', 
  fontSize: 'medium' 
});

// Store data with tags for organization
await ctx.memory.set('conversation-456', { 
  messages: [{ role: 'user', content: 'Hello' }]
}, { 
  tags: ['conversation', 'active'] 
});
```

### Retrieving Data

```typescript
// Get a specific value by key
const settings = await ctx.memory.get('user-123-settings');
console.log(settings.theme); // 'dark'

// The value maintains its structure
const conversation = await ctx.memory.get('conversation-456');
console.log(conversation.messages[0].content); // 'Hello'
```

### Querying Data

```typescript
// Find all entries with a specific tag
const activeConversations = await ctx.memory.query({ 
  tag: 'active' 
});

// Query with a result limit
const recentSettings = await ctx.memory.query({ 
  tag: 'settings', 
  limit: 5 
});
```

### Deleting Data

```typescript
// Delete a specific key
await ctx.memory.delete('old-conversation-123');
```

## Advanced Filtering

The `MemorySQLAdapter` supports powerful filtering capabilities, allowing you to search for data based on field values inside the stored JSON objects:

```typescript
// Find active users with high priority
const highPriorityUsers = await ctx.memory.query({
  tag: 'user',
  filters: [
    { path: 'status', operator: '=', value: 'active' },
    { path: 'priority', operator: '>=', value: 8 }
  ]
});

// Search by nested properties
const premiumCustomers = await ctx.memory.query({
  filters: [
    { path: 'subscription.tier', operator: '=', value: 'premium' },
    { path: 'subscription.expiresAt', operator: '>', value: new Date().toISOString() }
  ]
});

// Text search
const smithCustomers = await ctx.memory.query({
  filters: [
    { path: 'name', operator: 'CONTAINS', value: 'Smith' }
  ]
});
```

### Available Filter Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `=` | Equality | `{ path: 'status', operator: '=', value: 'active' }` |
| `!=` | Inequality | `{ path: 'status', operator: '!=', value: 'deleted' }` |
| `>` | Greater than | `{ path: 'priority', operator: '>', value: 5 }` |
| `>=` | Greater than or equal | `{ path: 'priority', operator: '>=', value: 5 }` |
| `<` | Less than | `{ path: 'count', operator: '<', value: 100 }` |
| `<=` | Less than or equal | `{ path: 'count', operator: '<=', value: 100 }` |
| `CONTAINS` | String contains | `{ path: 'name', operator: 'CONTAINS', value: 'John' }` |
| `STARTS_WITH` | String starts with | `{ path: 'code', operator: 'STARTS_WITH', value: 'ABC' }` |
| `ENDS_WITH` | String ends with | `{ path: 'email', operator: 'ENDS_WITH', value: '@example.com' }` |

## Best Practices

### Key Naming Strategies

Use a consistent strategy for key naming to avoid collisions and improve organization:

- **Entity-based keys**: `user:123`, `conversation:456`
- **Namespaced keys**: `settings:user:123`, `history:conversation:456`
- **Agent-specific keys**: `agent-name:conversation:456`

### Effective Use of Tags

Tags provide a powerful way to group related entries without complex key parsing:

- Use broad category tags: `user`, `conversation`, `setting`
- Use status tags: `active`, `archived`, `pending`
- Use agent-specific tags: `agent-name:history`, `agent-name:state`

### Data Structure Consistency

Maintain consistent data structures for similar types of data to make filtering more effective:

```typescript
// Use consistent field names and types
await memory.set('user:123', {
  id: '123',
  name: 'John Smith',
  status: 'active',
  createdAt: new Date().toISOString(),
  metadata: { /* additional properties */ }
});

await memory.set('user:456', {
  id: '456',
  name: 'Jane Doe',
  status: 'inactive',
  createdAt: new Date().toISOString(),
  metadata: { /* additional properties */ }
});
```

### Error Handling

All memory operations should be wrapped in try/catch blocks to handle potential errors:

```typescript
try {
  await ctx.memory.set('important-data', { value: 'critical' });
} catch (error) {
  // Log the error and handle gracefully
  ctx.logger.error('Failed to store memory', error);
  // Implement fallback behavior or report to monitoring
}
```

## Best Practices for Library Consumers

- **Key Naming:** Use structured, namespaced keys to avoid collisions (see [Memory System Guidelines](../planned_architecture/memory/memory-system-guidelines.md)).
- **Tags:** Use tags for grouping and querying related entries.
- **Error Handling:** Always wrap memory operations in try/catch blocks.
- **Schema Updates:** If the library updates its schema, update your own `schema.prisma` and run a new migration.
- **No Automatic Migrations:** The library will never run migrations for you. You are responsible for all schema changes.
- **Multiple Adapters:** You can use different adapters (e.g., in-memory, Redis) by swapping the implementation, but the schema above is required for the SQL adapter.

## FAQ

**Q: Can I use my own models in the same database?**
> Yes! Just add your own models to your `schema.prisma` alongside the required `AgentMemoryStore` model.

**Q: What if the library updates its schema?**
> Update your `schema.prisma` to match, then run `npx prisma migrate dev` again.

**Q: Can I use a different database?**
> The SQL adapter requires PostgreSQL. Other adapters may support different databases in the future.

**Q: Does the library export a PrismaClient?**
> No. You must create and manage your own PrismaClient instance.

**Q: Can I run migrations from the library?**
> No. You must run migrations in your own application context.

## Limitations and Future Enhancements

Currently, the memory system has the following limitations:

- Only SQL-based storage is implemented (PostgreSQL)
- Vector similarity search is not yet supported (planned)
- Sorting by JSON field values is not implemented (planned)
- No built-in caching layer (planned)

Future enhancements will include:

- Vector similarity search using pgvector
- Multiple adapters (Redis, in-memory, etc.)
- Advanced query capabilities (OR conditions, multiple tags with AND/OR)
- Performance optimizations 
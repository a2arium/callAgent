# Memory System

> **Note:** This guide applies to the monorepo structure. See [Monorepo Overview](./monorepo-overview.md) for details. For SQL adapter specifics, see [MemorySQL Adapter](./memory-sql-adapter.md).

This document explains how to use the agent framework's memory system to provide durable, long-term storage capabilities for your agents, **with a focus on usage as a library consumer**.

## Overview

The memory system provides a standardized interface (`IMemory`) for agents to store, retrieve, and query data persistently across different executions. It's accessible through the context object passed to agents:

```typescript
// Inside the handleTask function of an agent
async handleTask(ctx: TaskContext) {
  // Access memory through the context
  await ctx.memory.semantic.set('conversation-123', { lastMessage: 'Hello' });
  const conversation = await ctx.memory.semantic.get('conversation-123');
}
```

Currently, the framework implements a SQL-based memory adapter (`MemorySQLAdapter`) that uses PostgreSQL as its backing store, with Prisma ORM handling database operations.

## Using the Memory System in Your Application

The memory system is designed to be used as a library. This means:
- **You, the application developer, are responsible for managing the database schema and migrations.**
- **You must run the required migrations from the `@callagent/memory-sql` package.**
- **You generate and manage your own Prisma Client instance.**
- **You pass your PrismaClient instance to the memory adapter provided by the package.**

### 1. Add the Required Model to Your Database

The required Prisma model is included in the `@callagent/memory-sql` package. Run the migration from the package root:

```bash
yarn workspace @callagent/memory-sql prisma migrate dev --name init
```

### 2. Set Up Your Database and Environment

- Ensure you have a PostgreSQL database available.
- Add a connection string to your `.env` file:

```env
MEMORY_DATABASE_URL="postgresql://username:password@host:port/database_name"
```

### 3. Install Required Dependencies

In your application, install Prisma and the memory adapter package:

```bash
yarn add @prisma/client
# (and the memory adapter)
yarn add @callagent/memory-sql
```

### 4. Configure and Use the Memory Adapter

In your application startup code:

```typescript
import { PrismaClient } from '@prisma/client';
import { MemorySQLAdapter } from '@callagent/memory-sql';

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

### 5. Example: Using Memory in an Agent

```typescript
import { createAgent } from '@callagent/core';

export default createAgent({
  manifest: './agent.json',
  handleTask: async (ctx) => {
    // Store information in memory
    await ctx.memory.semantic.set('user-preference', {
      theme: 'dark',
      language: 'en-US'
    }, {
      tags: ['preference', 'user-settings']
    });

    // Retrieve information from memory
    const preference = await ctx.memory.semantic.get('user-preference');
    ctx.logger.info(`User prefers ${preference.theme} theme`);
    await ctx.reply([{ type: 'text', text: 'Preferences saved!' }]);
    ctx.complete();
  }
}, import.meta.url);
```

## Using Memory in Agents

Agents created with the `createAgent` factory function have access to the memory system through the context object:

```typescript
import { createAgent } from '@callagent/core';

export default createAgent({
  manifest: './agent.json',
  handleTask: async (ctx) => {
    // Store information in memory
    await ctx.memory.semantic.set('user-preference', { 
      theme: 'dark',
      language: 'en-US' 
    }, { 
      tags: ['preference', 'user-settings'] 
    });
    
    // Retrieve information from memory
    const preference = await ctx.memory.semantic.get('user-preference');
    
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
yarn workspace @callagent/memory-sql prisma migrate dev --name init
```

This will create the `agent_memory_store` table with the correct schema in your PostgreSQL database.

### Framework Configuration

To configure your application to use the `MemorySQLAdapter`:

1. In your application startup code (where you configure dependency injection):

```typescript
import { PrismaClient } from '@prisma/client';
import { MemorySQLAdapter } from '@callagent/memory-sql';
import { IMemory } from '@callagent/types';

// Create a singleton PrismaClient for memory operations
const memoryPrisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.MEMORY_DATABASE_URL
    }
  }
});

// Configure your DI container or use a factory approach
function createMemoryAdapter(): IMemory {
  return new MemorySQLAdapter(memoryPrisma);
}
```

## Basic Usage

### Storing Data

```typescript
// Store simple data
await ctx.memory.semantic.set('user-123-settings', { 
  theme: 'dark', 
  fontSize: 'medium' 
});

// Store data with tags for organization
await ctx.memory.semantic.set('conversation-456', { 
  messages: [{ role: 'user', content: 'Hello' }]
}, { 
  tags: ['conversation', 'active'] 
});
```

### Retrieving Data

```typescript
// Get a specific value by key
const settings = await ctx.memory.semantic.get('user-123-settings');
console.log(settings.theme); // 'dark'

// The value maintains its structure
const conversation = await ctx.memory.semantic.get('conversation-456');
console.log(conversation.messages[0].content); // 'Hello'
```

### Querying Data

The memory system provides a unified `getMany()` method that supports both pattern matching and query objects:

```typescript
// Pattern matching - find all user data
const allUserData = await ctx.memory.semantic.getMany('user:*');

// Pattern matching - specific user's data
const user123Data = await ctx.memory.semantic.getMany('user:123:*');

// Query object - find entries by tag
const activeConversations = await ctx.memory.semantic.getMany({ 
  tag: 'active' 
});

// Query object - with filters and limit (string syntax)
const recentSettings = await ctx.memory.semantic.getMany({ 
  tag: 'settings',
  filters: ['status = "active"'],
  limit: 5 
});

// Pattern with options - combine pattern matching with limits
const limitedUserData = await ctx.memory.semantic.getMany('user:*', { limit: 10 });
```

### Deleting Data

```typescript
// Delete a specific key
await ctx.memory.semantic.delete('old-conversation-123');
```

## Pattern Matching

The `getMany()` method supports powerful pattern matching using wildcards:

```typescript
// Wildcard patterns
const allUsers = await ctx.memory.semantic.getMany('user:*');           // All user keys
const user123 = await ctx.memory.semantic.getMany('user:123:*');       // All data for user 123
const profiles = await ctx.memory.semantic.getMany('user:*:profile');  // All user profiles
const sessions = await ctx.memory.semantic.getMany('session:*');       // All sessions

// Single character wildcard
const items = await ctx.memory.semantic.getMany('item:?');             // item:a, item:b, etc.

// Combine with options
const recentUsers = await ctx.memory.semantic.getMany('user:*', { 
  limit: 10,
  orderBy: { path: 'createdAt', direction: 'desc' }
});
```

### Pattern Syntax

| Pattern | Description | Example | Matches |
|---------|-------------|---------|---------|
| `*` | Zero or more characters | `user:*` | `user:123`, `user:456:profile` |
| `?` | Exactly one character | `item:?` | `item:a`, `item:b` (not `item:ab`) |
| Literal | Exact match | `user:123:profile` | Only `user:123:profile` |

## Advanced Filtering

The `getMany()` method supports powerful filtering capabilities with both **string-based syntax** (recommended) and **object-based syntax** (for programmatic use). You can search for data based on field values inside the stored JSON objects:

### String-Based Filter Syntax (Recommended)

The intuitive string syntax makes filters much more readable and concise:

```typescript
// Find active users with high priority
const highPriorityUsers = await ctx.memory.semantic.getMany({
  tag: 'user',
  filters: [
    'status = "active"',
    'priority >= 8'
  ]
});

// Search by nested properties
const premiumCustomers = await ctx.memory.semantic.getMany({
  filters: [
    'subscription.tier = "premium"',
    `subscription.expiresAt > "${new Date().toISOString()}"`
  ]
});

// Text search
const smithCustomers = await ctx.memory.semantic.getMany({
  filters: ['name contains "Smith"']
});

// Multiple filter types
const engineeringManagers = await ctx.memory.semantic.getMany({
  filters: [
    'department = "Engineering"',
    'isManager = true',
    'salary > 70000',
    'email ends_with "@company.com"'
  ]
});
```

### Object-Based Filter Syntax (Legacy)

The explicit object syntax is still supported for programmatic use:

```typescript
// Find active users with high priority
const highPriorityUsers = await ctx.memory.semantic.getMany({
  tag: 'user',
  filters: [
    { path: 'status', operator: '=', value: 'active' },
    { path: 'priority', operator: '>=', value: 8 }
  ]
});

// Search by nested properties
const premiumCustomers = await ctx.memory.semantic.getMany({
  filters: [
    { path: 'subscription.tier', operator: '=', value: 'premium' },
    { path: 'subscription.expiresAt', operator: '>', value: new Date().toISOString() }
  ]
});

// Text search
const smithCustomers = await ctx.memory.semantic.getMany({
  filters: [
    { path: 'name', operator: 'CONTAINS', value: 'Smith' }
  ]
});
```

### Mixed Syntax (Best of Both Worlds)

You can combine both syntaxes in the same query:

```typescript
const results = await ctx.memory.semantic.getMany({
  filters: [
    'status = "active"',                                    // String syntax
    { path: 'profile.salary', operator: '>', value: 70000 }, // Object syntax
    'department contains "Engineering"'                      // String syntax
  ]
});
```

### Available Filter Operators

| Operator | Description | String Syntax | Object Syntax |
|----------|-------------|---------------|---------------|
| `=` | Equality | `'status = "active"'` | `{ path: 'status', operator: '=', value: 'active' }` |
| `!=` | Inequality | `'status != "deleted"'` | `{ path: 'status', operator: '!=', value: 'deleted' }` |
| `>` | Greater than | `'priority > 5'` | `{ path: 'priority', operator: '>', value: 5 }` |
| `>=` | Greater than or equal | `'priority >= 5'` | `{ path: 'priority', operator: '>=', value: 5 }` |
| `<` | Less than | `'count < 100'` | `{ path: 'count', operator: '<', value: 100 }` |
| `<=` | Less than or equal | `'count <= 100'` | `{ path: 'count', operator: '<=', value: 100 }` |
| `CONTAINS` | String contains | `'name contains "John"'` | `{ path: 'name', operator: 'CONTAINS', value: 'John' }` |
| `STARTS_WITH` | String starts with | `'code starts_with "ABC"'` | `{ path: 'code', operator: 'STARTS_WITH', value: 'ABC' }` |
| `ENDS_WITH` | String ends with | `'email ends_with "@example.com"'` | `{ path: 'email', operator: 'ENDS_WITH', value: '@example.com' }` |

### String Syntax Value Types

The string syntax supports various value types:

| Type | Example | Description |
|------|---------|-------------|
| Numbers | `'count = 42'`, `'price = 19.99'` | Integer and decimal numbers |
| Booleans | `'active = true'`, `'disabled = false'` | Boolean values |
| Null | `'deletedAt = null'` | Null values |
| Quoted Strings | `'status = "active"'`, `"name = 'John'"` | Strings with quotes |
| Unquoted Strings | `'type = user'` | Simple strings without spaces |
| Nested Paths | `'profile.email contains "@example.com"'` | Dot notation for nested properties |

## Entity Alignment

Entity alignment is an advanced feature that automatically aligns similar entities (like venue names, speaker names, etc.) using vector embeddings and semantic similarity. This prevents duplicate entities and ensures consistent data representation across your memory store.

### Overview

When storing data with entity alignment enabled, the system:
1. **Extracts entities** from specified fields using configurable entity types
2. **Generates embeddings** for each entity using an LLM embedding model
3. **Searches for similar entities** using vector similarity (cosine distance)
4. **Aligns to existing entities** if similarity exceeds the threshold, or creates new ones
5. **Returns proxy objects** that behave like strings but provide access to canonical names and metadata

### Prerequisites

Entity alignment requires additional setup beyond basic memory functionality:

1. **pgvector Extension**: Install the pgvector extension in your PostgreSQL database:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

2. **Entity Alignment Schema**: Run the entity alignment migration:
```bash
yarn workspace @callagent/memory-sql prisma migrate dev --name add_entity_alignment
```

3. **Embedding Function**: Configure an embedding provider (OpenAI, etc.) in your environment:
```env
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=your_api_key_here
```

### Basic Entity Alignment Usage

#### Setting Up the Memory Adapter with Embeddings

```typescript
import { PrismaClient } from '@prisma/client';
import { MemorySQLAdapter } from '@callagent/memory-sql';
import { createEmbeddingFunction } from '@callagent/core';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.MEMORY_DATABASE_URL } }
});

// Create embedding function
const embedFunction = await createEmbeddingFunction();

// Create memory adapter with embedding support
const memory = new MemorySQLAdapter(prisma, embedFunction);
```

#### Storing Data with Entity Alignment

```typescript
// Store event data with entity alignment
await ctx.memory.semantic.set('event-001', {
  title: 'AI Conference 2024',
  venue: 'Main Auditorium',        // Will be aligned as 'location' entity
  speaker: 'Dr. Jane Smith',       // Will be aligned as 'person' entity
  date: '2024-03-15'
}, {
  tags: ['event', 'conference'],
  entities: {
    venue: 'location',    // Map 'venue' field to 'location' entity type
    speaker: 'person'     // Map 'speaker' field to 'person' entity type
  }
});

// Store another event - similar entities will be aligned
await ctx.memory.semantic.set('event-002', {
  title: 'Tech Workshop',
  venue: 'Main Hall',              // Will align to 'Main Auditorium' if similar enough
  speaker: 'Jane Smith',           // Will align to 'Dr. Jane Smith' if similar enough
  date: '2024-03-16'
}, {
  tags: ['event', 'workshop'],
  entities: {
    venue: 'location',
    speaker: 'person'
  }
});
```

#### Retrieving Aligned Data

```typescript
// Retrieve data - aligned fields return proxy objects
const event = await ctx.memory.semantic.get('event-002');

// Use aligned values like normal strings
console.log(`Event at ${event.venue}`);                    // "Event at Main Hall"
console.log(`Speaker: ${event.speaker}`);                  // "Speaker: Jane Smith"
console.log(event.venue.toUpperCase());                    // "MAIN HALL"

// Access alignment metadata
console.log(event.venue._canonical);                       // "Main Auditorium" (if aligned)
console.log(event.venue._original);                        // "Main Hall"
console.log(event.venue._wasAligned);                      // true
console.log(event.venue._entity);                          // "location"

// Check if alignment occurred
if (event.speaker._wasAligned) {
  console.log(`"${event.speaker._original}" was aligned to "${event.speaker._canonical}"`);
  // Output: "Jane Smith" was aligned to "Dr. Jane Smith"
}
```

### Advanced Entity Alignment

#### Custom Similarity Thresholds

```typescript
// Configure field-specific thresholds using 'type:threshold' syntax
await ctx.memory.semantic.set('conference-session', {
  session: {
    title: 'Machine Learning Basics',
    presenter: {
      name: 'Dr. John Doe',         // Will use 0.75 threshold
      affiliation: 'MIT'            // Will use 0.8 threshold
    },
    location: {
      building: 'Science Center',   // Will use 0.65 threshold
      room: 'Room 101'
    }
  }
}, {
  entities: {
    'session.presenter.name': 'person:0.75',        // Field-specific threshold
    'session.presenter.affiliation': 'organization:0.8',
    'session.location.building': 'location:0.65'    // Field-specific threshold
  }
});
```

#### Field-Specific Thresholds

```typescript
// Use different thresholds for different fields
await ctx.memory.semantic.set('event-data', {
  venue: 'Main Auditorium',
  speaker: 'Dr. Jane Smith',
  organizer: 'Tech Corp Inc'
}, {
  entities: {
    venue: 'location:0.6',         // Lower threshold for locations (more variation)
    speaker: 'person:0.8',         // Higher threshold for people (avoid false positives)
    organizer: 'organization:0.75'  // Medium threshold for organizations
  }
});

// Mix of fields with and without thresholds
await ctx.memory.semantic.set('meeting-info', {
  location: 'Conference Room A',
  attendee: 'John Smith',
  topic: 'AI Discussion'
}, {
  entities: {
    location: 'location:0.65',     // Custom threshold
    attendee: 'person',            // Uses default threshold
    topic: 'topic:0.9'             // Very high threshold for topics
  }
});
```

#### Manual Entity Management

```typescript
// Access entity management methods
const entityManager = memory.entities;

// Get entity statistics
const stats = await entityManager.stats();
console.log(`Total entities: ${stats.totalEntities}`);
console.log(`By type:`, stats.entitiesByType);
// Output: { location: 5, person: 12, organization: 3 }

// Get statistics for specific entity type
const locationStats = await entityManager.stats('location');

// Unlink an entity alignment
await entityManager.unlink('event-002', 'venue');

// Force realign to a specific entity
await entityManager.realign('event-002', 'speaker', 'entity-id-123');
```

### Entity Alignment Configuration Options

#### Similarity Thresholds

| Threshold | Description | Use Case |
|-----------|-------------|----------|
| `0.9-1.0` | Very high similarity | Exact matches, minor typos |
| `0.8-0.9` | High similarity | Same entity, different formatting |
| `0.7-0.8` | Good similarity | Related entities, abbreviations |
| `0.6-0.7` | Moderate similarity | Loosely related entities |
| `< 0.6` | Low similarity | Likely different entities |

#### Entity Type Examples

| Entity Type | Examples | Typical Threshold |
|-------------|----------|-------------------|
| `person` | "Dr. Jane Smith", "Jane Smith", "J. Smith" | 0.7 |
| `location` | "Main Auditorium", "Main Hall", "Auditorium A" | 0.65 |
| `organization` | "MIT", "Massachusetts Institute of Technology" | 0.8 |
| `product` | "iPhone 15", "iPhone 15 Pro", "Apple iPhone" | 0.75 |
| `event` | "AI Conference 2024", "2024 AI Conference" | 0.7 |

### Best Practices for Entity Alignment

#### 1. Choose Appropriate Thresholds

```typescript
// Use field-specific thresholds for fine-grained control
await memory.set('customer-data', customerInfo, {
  entities: {
    name: 'person:0.75',           // Higher for people (avoid false positives)
    company: 'organization:0.8',   // Higher for orgs (avoid merging different companies)
    city: 'location:0.65',         // Lower for locations (more variation in naming)
    country: 'location:0.7'        // Slightly higher for countries (less variation)
  }
});

// Global threshold override (affects all fields without specific thresholds)
await memory.set('event-info', eventData, {
  alignmentThreshold: 0.7,         // Global override
  entities: {
    venue: 'location',             // Uses global threshold (0.7)
    speaker: 'person:0.8'          // Uses field-specific threshold (0.8)
  }
});
```

#### 2. Use Consistent Entity Types and Thresholds

```typescript
// Define standard entity types with recommended thresholds
const ENTITY_SPECS = {
  PERSON_STRICT: 'person:0.8',      // High threshold for people
  PERSON_FLEXIBLE: 'person:0.65',   // Lower threshold for nicknames/variations
  LOCATION_FLEXIBLE: 'location:0.6', // Lower for location variations
  LOCATION_STRICT: 'location:0.75',  // Higher for exact location matching
  ORGANIZATION: 'organization:0.8',  // High threshold for organizations
  PRODUCT: 'product:0.75',          // Medium-high for products
  EVENT: 'event:0.7'                // Medium threshold for events
} as const;

// Use consistently across your application
await memory.set('meeting-001', data, {
  entities: {
    organizer: ENTITY_SPECS.PERSON_STRICT,     // Exact person matching
    venue: ENTITY_SPECS.LOCATION_FLEXIBLE,     // Allow venue variations
    company: ENTITY_SPECS.ORGANIZATION         // Strict org matching
  }
});
```

#### 3. Monitor Entity Statistics

```typescript
// Regularly check entity alignment effectiveness
const stats = await memory.entities.stats();

// Log statistics for monitoring
console.log('Entity Alignment Stats:', {
  totalEntities: stats.totalEntities,
  totalAlignments: stats.totalAlignments,
  alignmentRatio: stats.totalAlignments / stats.totalEntities,
  entitiesByType: stats.entitiesByType
});

// Alert if alignment ratio is too low (might need threshold adjustment)
if (stats.totalAlignments / stats.totalEntities < 0.3) {
  console.warn('Low entity alignment ratio - consider lowering thresholds');
}
```

#### 4. Handle Alignment Errors Gracefully

```typescript
try {
  await ctx.memory.semantic.set('event-data', eventData, {
    entities: { venue: 'location', speaker: 'person' }
  });
} catch (error) {
  // Fall back to storing without entity alignment
  console.warn('Entity alignment failed, storing without alignment:', error);
  await ctx.memory.semantic.set('event-data', eventData, {
    tags: ['event', 'no-alignment']
  });
}
```

### Troubleshooting Entity Alignment

#### Common Issues

1. **Low Alignment Rates**: If entities aren't being aligned when they should be:
   - Lower the similarity threshold
   - Check embedding model consistency
   - Verify entity type mapping

2. **False Positive Alignments**: If unrelated entities are being aligned:
   - Raise the similarity threshold
   - Use more specific entity types
   - Review entity naming patterns

3. **Performance Issues**: If entity alignment is slow:
   - Ensure vector indexes are created
   - Monitor embedding API rate limits
   - Consider caching embedding results

#### Debugging Entity Alignment

```typescript
// Enable debug logging to see alignment decisions
process.env.DEBUG = 'entity-alignment';

// Check what entities exist for a type
const locationEntities = await memory.entities.stats('location');
console.log('Location entities:', locationEntities);

// Manually test similarity between two strings
const embedding1 = await embedFunction('Main Auditorium');
const embedding2 = await embedFunction('Main Hall');
// Calculate cosine similarity manually if needed
```

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
await memory.semantic.set('user:123', {
  id: '123',
  name: 'John Smith',
  status: 'active',
  createdAt: new Date().toISOString(),
  metadata: { /* additional properties */ }
});

await memory.semantic.set('user:456', {
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
  await ctx.memory.semantic.set('important-data', { value: 'critical' });
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

## API Migration

The memory system has been simplified with a unified `getMany()` method that replaces the previous fragmented API, and now supports intuitive string-based filter syntax:

### New Unified API

```typescript
// Single method for all bulk operations
await ctx.memory.semantic.getMany('user:*');                    // Pattern matching
await ctx.memory.semantic.getMany({ tag: 'user' });             // Query object
await ctx.memory.semantic.getMany('user:*', { limit: 5 });      // Pattern + options
```

### New String-Based Filter Syntax

The filter syntax has been greatly improved with intuitive string-based filters:

```typescript
// ✅ New string syntax (recommended)
await ctx.memory.semantic.getMany({
  filters: [
    'priority >= 8',
    'status = "active"',
    'name contains "John"'
  ]
});

// ✅ Object syntax (still supported)
await ctx.memory.semantic.getMany({
  filters: [
    { path: 'priority', operator: '>=', value: 8 },
    { path: 'status', operator: '=', value: 'active' },
    { path: 'name', operator: 'CONTAINS', value: 'John' }
  ]
});

// ✅ Mixed syntax (best of both worlds)
await ctx.memory.semantic.getMany({
  filters: [
    'priority >= 8',                                    // String syntax
    { path: 'status', operator: '=', value: 'active' }, // Object syntax
    'name contains "John"'                              // String syntax
  ]
});
```

### Legacy API (Deprecated)

The following methods are deprecated and will be removed in a future version:

```typescript
// ❌ Deprecated - use getMany() instead
await ctx.memory.semantic.query({ tag: 'user' });
await ctx.memory.semantic.queryByKeyPattern('user:*');
```

### Migration Guide

| Old API | New API |
|---------|---------|
| `query({ tag: 'user' })` | `getMany({ tag: 'user' })` |
| `queryByKeyPattern('user:*')` | `getMany('user:*')` |
| `query({ tag: 'user', limit: 5 })` | `getMany({ tag: 'user', limit: 5 })` |
| `filters: [{ path: 'priority', operator: '>=', value: 8 }]` | `filters: ['priority >= 8']` |

## FAQ

**Q: Can I use my own models in the same database?**
> Yes! Just add your own models to your `schema.prisma` alongside the required `AgentMemoryStore` model.

**Q: What if the library updates its schema?**
> Update your `schema.prisma` to match, then run `yarn workspace @callagent/memory-sql prisma migrate dev` again.

**Q: Can I use a different database?**
> The SQL adapter requires PostgreSQL. Other adapters may support different databases in the future.

**Q: Does the library export a PrismaClient?**
> No. You must create and manage your own PrismaClient instance.

**Q: Can I run migrations from the library?**
> Yes. Run migrations from the `@callagent/memory-sql` package using Yarn workspaces.

**Q: How do I enable entity alignment?**
> Install the pgvector extension, run the entity alignment migration, configure an embedding provider, and pass an embedding function to the MemorySQLAdapter constructor.

**Q: What embedding models are supported?**
> Currently OpenAI's text-embedding models are supported. The system is designed to work with any embedding function that returns number arrays.

**Q: Can I adjust entity alignment thresholds?**
> Yes. You can set field-specific thresholds using the `'type:threshold'` syntax (e.g., `'person:0.8'`, `'location:0.65'`). You can also set a global threshold override using the `alignmentThreshold` option. Lower thresholds (0.6-0.7) allow more alignments, higher thresholds (0.8-0.9) are more conservative.

**Q: What happens if entity alignment fails?**
> The system gracefully falls back to storing data without alignment. You can catch alignment errors and implement fallback behavior.

**Q: Can I use both string and object filter syntax?**
> Yes! You can mix both syntaxes in the same query. The string syntax (`'priority >= 8'`) is more intuitive and concise, while the object syntax (`{ path: 'priority', operator: '>=', value: 8 }`) is useful for programmatic filter construction. Both are fully supported.

## Limitations and Future Enhancements

Currently, the memory system has the following limitations:

- Only SQL-based storage is implemented (PostgreSQL)
- Sorting by JSON field values is not implemented (planned)
- No built-in caching layer (planned)

Recent additions:

- ✅ **Vector similarity search** - Implemented through entity alignment feature using pgvector
- ✅ **Entity alignment** - Automatic alignment of similar entities using embeddings

Future enhancements will include:

- Multiple adapters (Redis, in-memory, etc.)
- Advanced query capabilities (OR conditions, multiple tags with AND/OR)
- Performance optimizations
- Entity relationship mapping
- Bulk entity operations 
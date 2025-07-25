# Memory System

> **Note:** This guide applies to the monorepo structure. See [Monorepo Overview](./monorepo-overview.md) for details. For SQL adapter specifics, see [MemorySQL Adapter](./memory-sql-adapter.md).

This document explains how to use the agent framework's memory system to provide durable, long-term storage capabilities for your agents, **with a focus on usage as a library consumer**.

## Overview

The memory system provides a standardized interface (`IMemory`) for agents to store, retrieve, and query data persistently across different executions. It's accessible through the context object passed to agents:

> **New:** The framework now also includes a **Working Memory & Cognitive Context API** for managing active cognitive state during task execution. See [Working Memory API](./working-memory-api.md) for details on goal tracking, thought management, and decision making.

> **New:** The framework now supports **Entity-Aware Search** that allows querying memory using entity alignment. You can search for memories by entity names, aliases, and similar entities using fuzzy matching. See [Entity-Aware Search](#entity-aware-search) for details.

```typescript
// Inside the handleTask function of an agent
async handleTask(ctx: TaskContext) {
  // Access memory through the context
  await ctx.memory.semantic.set('conversation-123', { lastMessage: 'Hello' });
  const conversation = await ctx.memory.semantic.get('conversation-123');
  
  // NEW: Search using entity alignment
  const johnMemories = await ctx.memory.semantic.getMany({
    filters: ['speaker ~ "Johnny"']  // Finds memories where speaker is similar to "Johnny"
  });
  
  // NEW: Recognize if data matches existing memories
  const recognition = await ctx.memory.semantic.recognize(newData, {
    entities: { speaker: 'person', topic: 'subject' }
  });
  
  // NEW: Enrich existing memories with additional data
  const enrichment = await ctx.memory.semantic.enrich('memory-key', [additionalData], {
    forceLLMEnrichment: false
  });
}
```

Currently, the framework implements a SQL-based memory adapter (`MemorySQLAdapter`) that uses PostgreSQL as its backing store, with Prisma ORM handling database operations.

## Using the Memory System in Your Application

The memory system is designed to be used as a library. This means:
- **You, the application developer, are responsible for managing the database schema and migrations.**
- **You must run the required migrations from the `@a2arium/memory-sql` package.**
- **You generate and manage your own Prisma Client instance.**
- **You pass your PrismaClient instance to the memory adapter provided by the package.**

### 1. Add the Required Model to Your Database

The required Prisma model is included in the `@a2arium/memory-sql` package. Run the migration from the package root:

```bash
yarn workspace @a2arium/memory-sql prisma migrate dev --name init
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
yarn add @a2arium/memory-sql
```

### 4. Configure and Use the Memory Adapter

In your application startup code:

```typescript
import { PrismaClient } from '@prisma/client';
import { MemorySQLAdapter } from '@a2arium/memory-sql';

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
import { createAgent } from '@a2arium/core';

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
import { createAgent } from '@a2arium/core';

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
yarn workspace @a2arium/memory-sql prisma migrate dev --name init
```

This will create the `agent_memory_store` table with the correct schema in your PostgreSQL database.

### Framework Configuration

To configure your application to use the `MemorySQLAdapter`:

1. In your application startup code (where you configure dependency injection):

```typescript
import { PrismaClient } from '@prisma/client';
import { MemorySQLAdapter } from '@a2arium/memory-sql';
import { IMemory } from '@a2arium/types';

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

// Pattern with options - combine pattern matching with limits (default limit is 1000)
const limitedUserData = await ctx.memory.semantic.getMany('user:*', { limit: 10 });
```

### Deleting Data

```typescript
// Delete a specific key
await ctx.memory.semantic.delete('old-conversation-123');

// Delete multiple entries using pattern matching
const deletedCount = await ctx.memory.semantic.deleteMany('user:123:*');
console.log(`Deleted ${deletedCount} entries`);

// Delete multiple entries using query object
const deletedCount = await ctx.memory.semantic.deleteMany({ 
  tag: 'temporary' 
});

// Delete with filters - remove all inactive users
const deletedCount = await ctx.memory.semantic.deleteMany({
  tag: 'user',
  filters: ['status = "inactive"']
});

// Delete with pattern and limit (deletes first 10 matching entries)
const deletedCount = await ctx.memory.semantic.deleteMany('session:*', { 
  limit: 10 
});
```

## Bulk Deletion with deleteMany

The `deleteMany()` method provides efficient bulk deletion capabilities, supporting the same query patterns as `getMany()`:

### Basic Usage

```typescript
// Delete by pattern - all user data
const deletedCount = await ctx.memory.semantic.deleteMany('user:*');

// Delete by tag - all temporary entries
const deletedCount = await ctx.memory.semantic.deleteMany({ tag: 'temporary' });

// Delete with filters - inactive users only
const deletedCount = await ctx.memory.semantic.deleteMany({
  tag: 'user',
  filters: ['status = "inactive"']
});
```

### Advanced Deletion Patterns

```typescript
// Delete specific user's data
await ctx.memory.semantic.deleteMany('user:123:*');

// Delete old sessions (with date filter)
await ctx.memory.semantic.deleteMany({
  tag: 'session',
  filters: [`lastAccessed < "${thirtyDaysAgo.toISOString()}"`]
});

// Delete all matching entries (limit is ignored for deleteMany - all matches are deleted)
await ctx.memory.semantic.deleteMany('cache:*', { 
  orderBy: { path: 'createdAt', direction: 'asc' }
});

// Delete by multiple criteria
await ctx.memory.semantic.deleteMany({
  filters: [
    'type = "temporary"',
    'expiresAt < "2024-01-01T00:00:00Z"',
    'priority < 5'
  ]
});
```

### Return Value

The `deleteMany()` method returns the number of entries actually deleted:

```typescript
const deletedCount = await ctx.memory.semantic.deleteMany('old-data:*');
if (deletedCount > 0) {
  console.log(`Successfully cleaned up ${deletedCount} old entries`);
} else {
  console.log('No entries found to delete');
}
```

### Performance Considerations

- **Bulk Operations**: `deleteMany()` is optimized for bulk deletions and performs better than multiple individual `delete()` calls
- **Transaction Safety**: All deletions are performed within a database transaction to ensure consistency
- **Entity Alignment**: When entity alignment is enabled, associated entity alignments are automatically cleaned up
- **Filtering**: Complex filters are processed efficiently at the database level

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

**Important**: Embeddings are only created for entity alignment purposes. Regular memory storage does not generate embeddings - they are created per-entity-field only when entity alignment is explicitly requested.

1. **pgvector Extension**: Install the pgvector extension in your PostgreSQL database:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

2. **Entity Alignment Schema**: Run the entity alignment migration:
```bash
yarn workspace @a2arium/memory-sql prisma migrate dev --name add_entity_alignment
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
import { MemorySQLAdapter } from '@a2arium/memory-sql';
import { createEmbeddingFunction } from '@a2arium/core';

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

### Natural Array Support

The entity alignment system now supports **natural array traversal**, allowing you to access fields within arrays using intuitive dot notation without requiring explicit array indexing.

#### Overview

You can use intuitive syntax to work with arrays and nested objects:

```typescript
// ✅ Recommended: Array expansion (matches all array elements)
entities: {
  "titleAndDescription[].title": "event",      // Creates alignments for all titles
  "eventOccurences[].date": "date",            // Creates alignments for all dates
  "speakers[].name": "person",                 // Creates alignments for all speakers
  "venue.name": "location"                     // Works for nested objects
}

// ✅ For non-array nested objects
entities: {
  "venue.name": "location",                    // Works for nested objects
  "user.profile.name": "person",               // Standard object navigation
  "metadata.category": "category"              // Nested object fields
}
```

#### Real-World Example

```typescript
// Store complex event data with nested arrays
await ctx.memory.semantic.set('conference-2024', {
  titleAndDescription: [
    { title: "AI Summit 2024", description: "Annual AI conference", language: "en" },
    { title: "Tech Conference Extraordinaire", description: "Alternative title", language: "en" }
  ],
  venue: {
    name: "Convention Center",
    address: "123 Tech Street"
  },
  eventOccurences: [
    { date: "2024-01-15", time: "19:00", isSoldOut: false },
    { date: "2024-01-16", time: "20:00", isSoldOut: true }
  ],
  speakers: [
    { name: "Dr. Alice Johnson", affiliation: "MIT" },
    { name: "Prof. Bob Wilson", affiliation: "Stanford" }
  ]
}, {
  tags: ['conference', 'ai'],
  entities: {
    // ✅ Array expansion - creates entity alignment for each element
    "titleAndDescription[].title": "event:0.8",       // Aligns both "AI Summit 2024" and "Tech Conference Extraordinaire"
    "eventOccurences[].date": "date",                  // Aligns both "2024-01-15" and "2024-01-16"
    "speakers[].name": "person:0.75",                  // Aligns both "Dr. Alice Johnson" and "Prof. Bob Wilson"
    "speakers[].affiliation": "organization:0.8",     // Aligns both "MIT" and "Stanford"
    
    // ✅ Still works for nested objects
    "venue.name": "location:0.65"                     // Aligns "Convention Center"
  }
});
```

#### Array Expansion Syntax

| Syntax | Behavior | Use Case | Example Result |
|--------|----------|----------|----------------|
| `titleAndDescription[].title` | Expands to **all** array elements | Entity alignment | Creates alignments for all titles |
| `speakers[].name` | Expands to **all** speaker names | Complete entity tracking | Creates alignments for all speakers |
| `sessions[].speakers[].name` | Expands **nested** arrays | Multi-level tracking | Creates alignments for all speakers in all sessions |
| `venue.name` | Standard object navigation | Non-array fields | Direct property access |

#### Advanced Array Scenarios

##### Multiple Nested Arrays
```typescript
// Handle deeply nested arrays with expansion
const conferenceData = {
  sessions: [
    {
      title: "Session 1",
      presenters: [
        { name: "Speaker A", company: "Corp X" },
        { name: "Speaker B", company: "Corp Y" }
      ]
    },
    {
      title: "Session 2", 
      presenters: [
        { name: "Speaker C", company: "Corp Z" }
      ]
    }
  ]
};

await ctx.memory.semantic.set('multi-session-event', conferenceData, {
  entities: {
    "sessions[].title": "topic",                      // Aligns "Session 1" and "Session 2"
    "sessions[].presenters[].name": "person",         // Aligns all presenter names
    "sessions[].presenters[].company": "organization" // Aligns all presenter companies
  }
});
```

##### Mixed Objects and Arrays
```typescript
// Handle combination of objects and arrays
const mixedData = {
  event: {
    details: {
      speakers: [{ name: "John Doe" }],      // Array within nested objects
      venue: { name: "Main Hall" }          // Standard nested object
    }
  }
};

await ctx.memory.semantic.set('mixed-structure', mixedData, {
  entities: {
    "event.details.speakers[].name": "person",    // object.object.array[].field
    "event.details.venue.name": "location"       // object.object.object.field
  }
});
```

#### How Array Expansion Works

1. **Expansion Phase**: `titleAndDescription[].title` gets expanded to:
   - `titleAndDescription[0].title` 
   - `titleAndDescription[1].title`
   - `titleAndDescription[2].title` (etc.)

2. **Entity Alignment**: Each expanded path gets its own entity alignment:
   - `titleAndDescription[0].title` → Entity alignment for "AI Summit 2024"
   - `titleAndDescription[1].title` → Entity alignment for "Tech Conference Extraordinaire"

3. **Cross-Product Recognition**: During recognition, all candidate array elements are compared against all existing array elements for comprehensive matching.

#### Filter Queries with Array Expansion

Array expansion also works with filter queries:

```typescript
// Search using array expansion syntax
const results = await ctx.memory.semantic.getMany({
  filters: [
    'titleAndDescription[].title contains "AI"',    // Searches all title elements
    'speakers[].name ~ "John"',                     // Entity-aware search across all speakers
    'eventOccurences[].date >= "2024-01-01"'       // Date filtering across all occurrences
  ]
});
```

#### Array Expansion Usage

Use array expansion syntax to create entity alignments for all elements in arrays:

```typescript
// ✅ Array expansion - creates alignments for all elements
entities: {
  "titleAndDescription[].title": "event",       // All titles
  "speakers[].name": "person",                  // All speakers
  "sessions[].speakers[].name": "person"        // All speakers in all sessions
}

// ✅ Standard object navigation - for non-array fields
entities: {
  "venue.name": "location",                     // Direct property access
  "metadata.category": "category"               // Nested object fields
}
```

#### Edge Cases and Behavior

- **Empty Arrays**: Return no expanded paths (no error thrown)
- **Mixed Types**: Processes only object elements, ignores primitives
- **Deep Nesting**: Supports unlimited nesting depth (`a[].b[].c[].d...`)
- **Non-String Fields**: For entity alignment, only string values are processed
- **Performance**: Each array element creates a separate entity alignment

#### Best Practices

1. **Use Array Expansion for Arrays**: Use `[]` syntax when you need entity alignment for all array elements
2. **Use Standard Navigation for Objects**: Use dot notation for nested object property access
3. **Consistent Data Structure**: Ensure array elements have consistent schema for best results
4. **Entity Type Consistency**: Use consistent entity types across similar data structures
5. **Performance Consideration**: Array expansion creates more entity alignments, so use thoughtfully for large arrays

#### Array Traversal Behavior

| Syntax | Behavior | Example Result |
|--------|----------|----------------|
| `titleAndDescription[].title` | Expands to all array elements | Creates individual alignments for each title |
| `speakers[].name` | Expands to all array elements | Creates individual alignments for each speaker name |
| `eventOccurences[].date` | Expands to all array elements | Creates individual alignments for each event date |
| `venue.name` | Standard object navigation | Returns venue name (unchanged) |

#### Advanced Entity Alignment

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

## Entity-Aware Search

The memory system now supports **entity-aware search** that leverages the entity alignment system to find memories using entity names, aliases, and similar entities. This allows you to search for memories even when the exact entity name doesn't match what's stored.

### Overview

Entity-aware search works by:
1. **Analyzing your search terms** to identify potential entity references
2. **Finding similar entities** using embedding-based similarity or exact/alias matching
3. **Locating memory records** that are aligned to those entities
4. **Returning matching memories** with full entity alignment information

This is particularly powerful for:
- **Cross-lingual search** - Find "John Smith" when searching for "Johnny"
- **Alias resolution** - Find memories about "NYC" when searching for "New York City"
- **Fuzzy matching** - Handle typos and variations in entity names
- **Relationship discovery** - Find all memories related to similar entities

### Entity-Aware Operators

Three new filter operators enable entity-aware search:

| Operator | Syntax | Description | Use Case |
|----------|--------|-------------|----------|
| `~` | `field ~ "value"` | **Fuzzy entity matching** using embedding similarity | Find similar entities across languages/variations |
| `entity_is` | `field entity_is "value"` | **Exact entity matching** by canonical name | Find memories aligned to a specific canonical entity |
| `entity_like` | `field entity_like "value"` | **Alias matching** within entity aliases | Find memories using any known alias of an entity |

### Basic Usage Examples

#### Fuzzy Entity Search (`~`)

Find memories where the speaker is similar to "Johnny" (might match "John Smith", "John", "J. Smith", etc.):

```typescript
const johnMemories = await ctx.memory.semantic.getMany({
  filters: ['speaker ~ "Johnny"']
});

// Also works with other entity types
const nycMemories = await ctx.memory.semantic.getMany({
  filters: ['location ~ "NYC"']  // Might match "New York City", "New York", etc.
});
```

#### Exact Entity Search (`entity_is`)

Find memories aligned to the exact canonical entity "John Smith":

```typescript
const exactMatches = await ctx.memory.semantic.getMany({
  filters: ['speaker entity_is "John Smith"']
});
```

#### Alias Entity Search (`entity_like`)

Find memories where the speaker field contains any alias of an entity:

```typescript
const aliasMatches = await ctx.memory.semantic.getMany({
  filters: ['speaker entity_like "Johnny"']  // Matches if "Johnny" is an alias
});
```

### Advanced Usage Examples

#### Combining Entity and Regular Filters

```typescript
// Find high-priority memories about John from the last month
const results = await ctx.memory.semantic.getMany({
  filters: [
    'speaker ~ "John"',           // Entity-aware: similar to John
    'priority >= 8',              // Regular filter: high priority
    'date >= "2024-01-01"'        // Regular filter: recent
  ]
});
```

#### Multiple Entity Filters (AND Logic)

```typescript
// Find memories where speaker is like "John" AND location is like "NYC"
const results = await ctx.memory.semantic.getMany({
  filters: [
    'speaker ~ "John"',
    'location ~ "NYC"'
  ]
});
```

#### Cross-Lingual Entity Search

```typescript
// Search for memories about "Jean" (French) that might match "John" (English)
const crossLingualResults = await ctx.memory.semantic.getMany({
  filters: ['speaker ~ "Jean"']  // Might find "John Smith" if embeddings are multilingual
});
```

### Real-World Use Cases

#### Customer Support System

```typescript
// Find all support tickets for a customer, handling name variations
const customerTickets = await ctx.memory.semantic.getMany({
  filters: [
    'customer ~ "J. Smith"',      // Fuzzy match for name variations
    'status = "open"'             // Only open tickets
  ],
  tag: 'support-ticket'
});

// Find tickets about a specific product using aliases
const productIssues = await ctx.memory.semantic.getMany({
  filters: ['product entity_like "iPhone"'],  // Matches "iPhone", "iPhone 15", "Apple iPhone", etc.
  tag: 'support-ticket'
});
```

#### Meeting Notes System

```typescript
// Find all meetings where a person participated (handling name variations)
const personMeetings = await ctx.memory.semantic.getMany({
  filters: [
    'attendees ~ "Sarah"',        // Fuzzy match for "Sarah", "Sara", "Sarah Johnson", etc.
    'date >= "2024-01-01"'        // This year only
  ],
  tag: 'meeting-notes'
});

// Find meetings at similar locations
const locationMeetings = await ctx.memory.semantic.getMany({
  filters: ['venue ~ "Main Conference Room"'],  // Matches similar room names
  tag: 'meeting-notes'
});
```

#### Knowledge Base Search

```typescript
// Find documents about similar topics/entities
const relatedDocs = await ctx.memory.semantic.getMany({
  filters: [
    'topic ~ "machine learning"', // Finds "ML", "AI", "artificial intelligence", etc.
    'status = "published"'
  ],
  tag: 'knowledge-base'
});
```

### Performance Considerations

#### Embedding Requirements

- **Fuzzy search (`~`)** requires an embedding function to be configured
- **Exact/alias search** works without embeddings but requires entity alignment to be enabled
- **Embedding generation** happens at query time for fuzzy search (consider caching)

#### Query Performance

```typescript
// ✅ Efficient: Entity filters first, then regular filters
const efficient = await ctx.memory.semantic.getMany({
  filters: [
    'speaker ~ "John"',           // Entity filter (uses indexes)
    'priority >= 8'               // Regular filter (applied to subset)
  ]
});

// ⚠️ Less efficient: Many regular filters with entity filters
const lessEfficient = await ctx.memory.semantic.getMany({
  filters: [
    'speaker ~ "John"',
    'priority >= 8',
    'status = "active"',
    'category contains "important"',
    'date >= "2024-01-01"'        // Many regular filters applied in memory
  ]
});
```

#### Similarity Thresholds

The fuzzy search (`~`) uses the same similarity threshold as entity alignment (default: 0.6). You can adjust this:

```typescript
// Configure threshold when setting up the adapter
const adapter = new MemorySQLAdapter(prisma, embedFunction, {
  defaultThreshold: 0.7  // Higher threshold = more precise matches
});
```

### Error Handling

```typescript
try {
  const results = await ctx.memory.semantic.getMany({
    filters: ['speaker ~ "John"']
  });
} catch (error) {
  if (error.code === 'ENTITY_SERVICE_UNAVAILABLE') {
    // Entity alignment not configured - fall back to regular search
    const fallback = await ctx.memory.semantic.getMany({
      filters: ['speaker contains "John"']  // Regular text search
    });
  } else if (error.code === 'EMBEDDING_UNAVAILABLE') {
    // Embedding function not available - use exact/alias search instead
    const fallback = await ctx.memory.semantic.getMany({
      filters: ['speaker entity_like "John"']  // Alias search
    });
  }
}
```

### Migration from Regular Search

#### Before (Regular Text Search)

```typescript
// Old approach: literal text matching only
const results = await ctx.memory.semantic.getMany({
  filters: [
    'speaker contains "John"',    // Only finds exact substring matches
    'location = "New York"'       // Only finds exact matches
  ]
});
```

#### After (Entity-Aware Search)

```typescript
// New approach: intelligent entity matching
const results = await ctx.memory.semantic.getMany({
  filters: [
    'speaker ~ "John"',           // Finds "John Smith", "Johnny", "J. Smith", etc.
    'location ~ "New York"'       // Finds "NYC", "New York City", "Manhattan", etc.
  ]
});
```

### Debugging Entity-Aware Search

```typescript
// Check what entities would match your search
const debugSearch = async (searchTerm: string) => {
  // This would be internal to the adapter, but conceptually:
  const embedding = await embedFunction(searchTerm);
  const similarEntities = await findSimilarEntities('person', embedding, 0.6);
  console.log(`"${searchTerm}" matches:`, similarEntities.map(e => e.canonical_name));
};

// Check entity alignment for a specific memory
const memory = await ctx.memory.semantic.get('meeting:123');
console.log('Aligned entities:', memory._alignments); // If available
```

## Cross-Referencing Through Shared Entities

One of the most powerful features of the entity alignment system is its ability to create automatic relationships between different memory keys through shared entities. This enables sophisticated cross-referencing, relationship discovery, and recommendation systems without manual relationship management.

### How Cross-Referencing Works

When you store memories with entity alignment, the system creates an implicit **knowledge graph** where:

1. **Memory keys** become nodes in the graph
2. **Shared entities** create edges between nodes
3. **Entity similarity** enables fuzzy relationship discovery
4. **Query operations** can traverse these relationships

This means that storing `meeting:001` with speaker "Dr. Jane Smith" and `project:ai-research` with lead "Jane Smith" automatically creates a discoverable relationship between the meeting and the project through the shared person entity.

### Setting Up Related Memories

First, let's store related memories that share entities:

```typescript
// Store related memories that will be automatically cross-referenced
async function setupRelatedMemories(ctx) {
  // Meeting 1 - Dr. Jane Smith at Main Auditorium
  await ctx.memory.semantic.set('meeting:2024-001', {
    title: 'AI Research Review',
    date: '2024-03-15',
    speaker: 'Dr. Jane Smith',        // Entity: person
    venue: 'Main Auditorium',        // Entity: location
    attendees: 45,
    topics: ['machine learning', 'neural networks']
  }, {
    tags: ['meeting', 'research'],
    entities: {
      speaker: 'person',
      venue: 'location'
    }
  });

  // Workshop - Same speaker, different venue
  await ctx.memory.semantic.set('workshop:2024-003', {
    title: 'Deep Learning Workshop',
    date: '2024-03-20',
    speaker: 'Jane Smith',           // Same entity (will align to Dr. Jane Smith)
    venue: 'Conference Room A',      // Different location entity
    attendees: 12,
    format: 'hands-on'
  }, {
    tags: ['workshop', 'training'],
    entities: {
      speaker: 'person',
      venue: 'location'
    }
  });

  // Lecture - Same venue, different speaker
  await ctx.memory.semantic.set('lecture:2024-007', {
    title: 'Ethics in AI',
    date: '2024-03-22',
    speaker: 'Prof. Robert Chen',    // Different person entity
    venue: 'Main Hall',              // Similar to Main Auditorium (might align)
    attendees: 200,
    department: 'Philosophy'
  }, {
    tags: ['lecture', 'ethics'],
    entities: {
      speaker: 'person',
      venue: 'location'
    }
  });

  // Project record - mentions same speaker
  await ctx.memory.semantic.set('project:ai-ethics-2024', {
    title: 'AI Ethics Research Project',
    lead: 'Dr. Jane Smith',          // Same person entity
    collaborators: ['Prof. Robert Chen', 'Dr. Sarah Wilson'],
    status: 'active',
    budget: 250000
  }, {
    tags: ['project', 'research'],
    entities: {
      lead: 'person',
      collaborators: 'person'  // Arrays get processed individually
    }
  });
}
```

### Discovering Cross-References

Once memories with shared entities are stored, you can discover relationships in multiple ways:

#### 1. Find All Activities by a Specific Person

```typescript
// Find everything related to Jane Smith (matches name variations)
const janeActivities = await ctx.memory.semantic.getMany({
  filters: ['speaker ~ "Jane Smith" OR lead ~ "Jane Smith" OR collaborators ~ "Jane Smith"']
});

console.log('Jane Smith activities:', janeActivities.map(r => ({
  key: r.key,
  title: r.value.title,
  role: r.value.speaker ? 'speaker' : r.value.lead ? 'lead' : 'collaborator'
})));

// Output:
// [
//   { key: 'meeting:2024-001', title: 'AI Research Review', role: 'speaker' },
//   { key: 'workshop:2024-003', title: 'Deep Learning Workshop', role: 'speaker' },
//   { key: 'project:ai-ethics-2024', title: 'AI Ethics Research Project', role: 'lead' }
// ]
```

#### 2. Find All Events at Similar Venues

```typescript
// Find all events at venues similar to "Main Auditorium"
const mainVenueEvents = await ctx.memory.semantic.getMany({
  filters: ['venue ~ "Main Auditorium"']
});

console.log('Main venue events:', mainVenueEvents.map(r => ({
  key: r.key,
  title: r.value.title,
  venue: r.value.venue,
  speaker: r.value.speaker
})));

// Might include both "Main Auditorium" and "Main Hall" if they're similar enough
```

#### 3. Find Collaborations Between People

```typescript
// Find all activities involving both Jane Smith and Robert Chen
const collaborations = await ctx.memory.semantic.getMany({
  filters: [
    'speaker ~ "Jane Smith" OR lead ~ "Jane Smith" OR collaborators ~ "Jane Smith"',
    'speaker ~ "Robert Chen" OR lead ~ "Robert Chen" OR collaborators ~ "Robert Chen"'
  ]
});

console.log('Jane-Robert collaborations:', collaborations.map(r => r.value.title));
// Output: ['AI Ethics Research Project']
```

### Building a Relationship Discovery System

Here's a comprehensive function that discovers all related memories for any entity:

```typescript
async function findRelatedMemories(entityName: string, entityType: string = 'person') {
  // Step 1: Find all memories directly involving this entity
  const directMemories = await ctx.memory.semantic.getMany({
    filters: [`speaker ~ "${entityName}" OR lead ~ "${entityName}" OR collaborators ~ "${entityName}" OR venue ~ "${entityName}"`]
  });

  // Step 2: Extract other entities from those memories
  const relatedEntities = new Set<string>();
  const entityFrequency = new Map<string, number>();
  
  for (const memory of directMemories) {
    const value = memory.value;
    
    // Collect other people mentioned
    if (value.speaker && !value.speaker.toLowerCase().includes(entityName.toLowerCase())) {
      relatedEntities.add(value.speaker);
      entityFrequency.set(value.speaker, (entityFrequency.get(value.speaker) || 0) + 1);
    }
    
    if (value.lead && !value.lead.toLowerCase().includes(entityName.toLowerCase())) {
      relatedEntities.add(value.lead);
      entityFrequency.set(value.lead, (entityFrequency.get(value.lead) || 0) + 1);
    }
    
    if (value.collaborators) {
      for (const collab of value.collaborators) {
        if (!collab.toLowerCase().includes(entityName.toLowerCase())) {
          relatedEntities.add(collab);
          entityFrequency.set(collab, (entityFrequency.get(collab) || 0) + 1);
        }
      }
    }
    
    // Collect venues
    if (value.venue) {
      relatedEntities.add(value.venue);
      entityFrequency.set(value.venue, (entityFrequency.get(value.venue) || 0) + 1);
    }
  }

  // Step 3: Find memories involving those related entities
  const indirectMemories = new Map<string, any[]>();
  
  for (const entity of relatedEntities) {
    const entityMemories = await ctx.memory.semantic.getMany({
      filters: [`speaker ~ "${entity}" OR venue ~ "${entity}" OR lead ~ "${entity}" OR collaborators ~ "${entity}"`]
    });
    
    // Filter out memories we already found
    const newMemories = entityMemories.filter(m => 
      !directMemories.some(dm => dm.key === m.key)
    );
    
    if (newMemories.length > 0) {
      indirectMemories.set(entity, newMemories);
    }
  }

  // Step 4: Build relationship strength scores
  const relationshipStrength = Array.from(entityFrequency.entries())
    .map(([entity, frequency]) => ({
      entity,
      frequency,
      indirectConnections: indirectMemories.get(entity)?.length || 0,
      strength: frequency + (indirectMemories.get(entity)?.length || 0) * 0.5
    }))
    .sort((a, b) => b.strength - a.strength);

  return {
    query: entityName,
    directMemories,
    relatedEntities: Array.from(relatedEntities),
    indirectMemories: Object.fromEntries(indirectMemories),
    relationshipStrength
  };
}

// Usage
const janeNetwork = await findRelatedMemories('Jane Smith', 'person');
console.log('Jane Smith network:', {
  directConnections: janeNetwork.directMemories.length,
  relatedPeople: janeNetwork.relationshipStrength.filter(r => 
    janeNetwork.directMemories.some(m => 
      m.value.speaker === r.entity || m.value.lead === r.entity
    )
  ),
  strongestRelationships: janeNetwork.relationshipStrength.slice(0, 3)
});
```

### Building a Recommendation System

Use cross-referencing to build intelligent recommendations:

```typescript
async function findRecommendations(memoryKey: string) {
  // Get the source memory
  const sourceMemory = await ctx.memory.semantic.get(memoryKey);
  if (!sourceMemory) return [];

  const recommendations = [];

  // Find memories with same speaker
  if (sourceMemory.speaker) {
    const sameSpeaker = await ctx.memory.semantic.getMany({
      filters: [`speaker ~ "${sourceMemory.speaker}"`]
    });
    
    recommendations.push({
      type: 'same_speaker',
      reason: `Other activities by ${sourceMemory.speaker}`,
      score: 0.9,
      memories: sameSpeaker.filter(m => m.key !== memoryKey).slice(0, 3)
    });
  }

  // Find memories at same venue
  if (sourceMemory.venue) {
    const sameVenue = await ctx.memory.semantic.getMany({
      filters: [`venue ~ "${sourceMemory.venue}"`]
    });
    
    recommendations.push({
      type: 'same_venue',
      reason: `Other events at ${sourceMemory.venue}`,
      score: 0.7,
      memories: sameVenue.filter(m => m.key !== memoryKey).slice(0, 3)
    });
  }

  // Find memories with similar topics/tags
  if (sourceMemory.topics) {
    for (const topic of sourceMemory.topics) {
      const topicMemories = await ctx.memory.semantic.getMany({
        filters: [`topics contains "${topic}"`]
      });
      
      recommendations.push({
        type: 'similar_topic',
        reason: `Related to ${topic}`,
        score: 0.6,
        memories: topicMemories.filter(m => m.key !== memoryKey).slice(0, 2)
      });
    }
  }

  // Find collaborator networks
  if (sourceMemory.collaborators) {
    for (const collaborator of sourceMemory.collaborators) {
      const collabMemories = await ctx.memory.semantic.getMany({
        filters: [`speaker ~ "${collaborator}" OR lead ~ "${collaborator}"`]
      });
      
      recommendations.push({
        type: 'collaborator_network',
        reason: `Other work by ${collaborator}`,
        score: 0.8,
        memories: collabMemories.filter(m => m.key !== memoryKey).slice(0, 2)
      });
    }
  }

  // Sort by score and remove duplicates
  return recommendations
    .sort((a, b) => b.score - a.score)
    .reduce((unique, current) => {
      const existingKeys = new Set(unique.flatMap(r => r.memories.map(m => m.key)));
      current.memories = current.memories.filter(m => !existingKeys.has(m.key));
      
      if (current.memories.length > 0) {
        unique.push(current);
      }
      
      return unique;
    }, []);
}

// Usage
const recs = await findRecommendations('meeting:2024-001');
console.log('Recommendations for AI Research Review:');
recs.forEach(r => {
  console.log(`${r.reason} (${r.memories.length} items, score: ${r.score})`);
  r.memories.forEach(m => console.log(`  - ${m.value.title}`));
});
```

### Cross-Reference Use Cases

#### 1. Academic Conference System

```typescript
// Find all papers by an author
const authorPapers = await ctx.memory.semantic.getMany({
  filters: ['author ~ "Dr. Smith" OR presenter ~ "Dr. Smith"']
});

// Find papers from same institution
const institutionPapers = await ctx.memory.semantic.getMany({
  filters: ['affiliation ~ "MIT"']
});

// Find papers in same session/track
const sessionPapers = await ctx.memory.semantic.getMany({
  filters: ['session ~ "Machine Learning Track"']
});
```

#### 2. Customer Support System

```typescript
// Find all issues reported by a customer
const customerIssues = await ctx.memory.semantic.getMany({
  filters: ['reporter ~ "John Doe" OR customer ~ "John Doe"']
});

// Find similar issues by product
const productIssues = await ctx.memory.semantic.getMany({
  filters: ['product ~ "iPhone 15"']
});

// Find issues handled by same support agent
const agentIssues = await ctx.memory.semantic.getMany({
  filters: ['assignee ~ "Sarah Wilson"']
});
```

#### 3. Project Management System

```typescript
// Find all projects involving a team member
const memberProjects = await ctx.memory.semantic.getMany({
  filters: ['lead ~ "Alice Johnson" OR members ~ "Alice Johnson"']
});

// Find projects using same technology
const techProjects = await ctx.memory.semantic.getMany({
  filters: ['technologies ~ "React"']
});

// Find projects for same client
const clientProjects = await ctx.memory.semantic.getMany({
  filters: ['client ~ "ACME Corp"']
});
```

### Performance Considerations

#### Entity Index Optimization

The cross-referencing system relies on efficient entity lookups. Ensure your database has proper indexes:

```sql
-- Key indexes for entity alignment queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_alignment_entity_field 
  ON entity_alignment(tenant_id, entity_id, field_path);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_alignment_memory 
  ON entity_alignment(tenant_id, memory_key);

-- Vector similarity index for embedding searches
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_store_embedding 
  ON entity_store USING ivfflat (embedding vector_cosine_ops) 
  WITH (lists = 100);
```

#### Query Optimization Strategies

```typescript
// ✅ Efficient: Use specific entity types when possible
const speakers = await ctx.memory.semantic.getMany({
  filters: ['speaker ~ "John"']  // Scoped to speaker field
});

// ⚠️ Less efficient: Broad searches across all fields
const everything = await ctx.memory.semantic.getMany({
  filters: ['speaker ~ "John" OR lead ~ "John" OR collaborators ~ "John" OR venue ~ "John"']
});

// ✅ Efficient: Combine entity filters with regular filters
const recentSpeakers = await ctx.memory.semantic.getMany({
  filters: [
    'speaker ~ "John"',           // Entity filter (uses indexes)
    'date >= "2024-01-01"'        // Regular filter (applied to subset)
  ]
});
```

### Benefits of Cross-Referencing

1. **Automatic Relationship Discovery** - No manual relationship management required
2. **Fuzzy Matching** - Handles variations in entity names and typos
3. **Bidirectional Relationships** - Finding Jane's activities also discovers related venues, people, projects
4. **Query Flexibility** - Search by any entity field, not just predefined relationships
5. **Entity Consolidation** - Similar entities get merged over time, improving relationship quality
6. **Scalable Architecture** - Supports millions of entities and relationships efficiently

This cross-referencing system transforms your memory storage from isolated data silos into an interconnected knowledge graph, enabling powerful relationship discovery and recommendation capabilities without complex graph database management.

## Memory Recognition and Enrichment

> **New:** The framework now supports **Memory Recognition** and **Memory Enrichment** capabilities that leverage entity alignment to automatically identify similar memories and consolidate data from multiple sources.

The memory system provides two powerful methods for intelligent memory management:

- **`recognize()`** - Identifies whether incoming data matches existing memories
- **`enrich()`** - Consolidates and enhances memory data from multiple sources

### Memory Recognition

The `recognize()` method determines whether incoming data matches existing memories using entity alignment and confidence scoring:

```typescript
// Basic recognition
const recognitionResult = await ctx.memory.semantic.recognize(
  {
    title: 'AI Conference 2024',
    speaker: 'Dr. John Smith',
    venue: 'Main Hall'
  },
  {
    entities: {
      title: 'event',
      speaker: 'person', 
      venue: 'location'
    },
    threshold: 0.75  // Confidence threshold for automatic matching
  }
);

console.log(recognitionResult.confidence);      // 0.85
console.log(recognitionResult.isMatch);         // true
console.log(recognitionResult.matchingKey);     // 'existing-conference-key'
console.log(recognitionResult.matchingData);    // The actual memory data
```

#### Recognition Options

```typescript
type RecognitionOptions = {
  /** Task context containing LLM and tenant information (required for LLM operations) */
  taskContext?: any;
  /** Confidence threshold for automatic matching (default: 0.75) */
  threshold?: number;
  /** Lower bound for LLM disambiguation (default: 0.65) */
  llmLowerBound?: number;
  /** Upper bound for LLM disambiguation (default: 0.85) */
  llmUpperBound?: number;
  /** Entity field mappings for alignment matching */
  entities?: Record<string, string>;
  /** Tags to filter potential matches */
  tags?: string[];
  /** Custom LLM prompt for disambiguation */
  customPrompt?: string;
  /** Limit number of potential matches to consider */
  limit?: number;
};
```

#### LLM-Powered Disambiguation

When confidence scores fall into an uncertain range, the system can use LLM for intelligent disambiguation:

```typescript
// Example with LLM configuration
const result = await ctx.memory.semantic.recognize(candidateData, {
  taskContext: ctx,           // Required for LLM operations
  threshold: 0.75,            // High confidence threshold (default: 0.75)
  llmLowerBound: 0.65,        // Below this = no match (default: 0.65) 
  llmUpperBound: 0.85,        // Above this = definite match (default: 0.85)
  entities: { 
    title: 'event', 
    speaker: 'person' 
  },
  customPrompt: 'Focus on event titles and speaker names when comparing'
});

// LLM is used when: llmLowerBound <= confidence <= llmUpperBound
if (result.usedLLM) {
  console.log('LLM explanation:', result.explanation);
}
```

#### LLM Configuration Parameters

| Parameter | Default | Description | When Used |
|-----------|---------|-------------|-----------|
| `taskContext` | `undefined` | TaskContext with LLM access | Required for LLM operations |
| `threshold` | `0.75` | Direct match threshold | Confidence ≥ threshold = automatic match |
| `llmLowerBound` | `0.65` | LLM lower threshold | Confidence < llmLowerBound = no match |
| `llmUpperBound` | `0.85` | LLM upper threshold | Confidence > llmUpperBound = definite match |
| `customPrompt` | `undefined` | Custom LLM prompt | Override default disambiguation prompt |

#### Confidence Decision Flow

```
Confidence Score → Decision Process
├─ ≥ 0.75 (threshold) → ✅ Direct Match (no LLM)
├─ 0.65-0.85 (uncertain) → 🤖 LLM Disambiguation (if taskContext provided)
├─ < 0.65 (llmLowerBound) → ❌ No Match (no LLM)
└─ No LLM configured → Use threshold only
```

#### LLM Integration Examples

```typescript
// Basic LLM recognition (uses all defaults)
const basicResult = await ctx.memory.semantic.recognize(candidateData, {
  taskContext: ctx,  // Enables LLM for uncertain cases
  entities: { title: 'event', venue: 'location' }
});

// Custom LLM thresholds for stricter matching
const strictResult = await ctx.memory.semantic.recognize(candidateData, {
  taskContext: ctx,
  threshold: 0.85,      // Higher threshold for direct matches
  llmLowerBound: 0.75,  // Higher lower bound (less LLM usage)
  llmUpperBound: 0.90,  // Higher upper bound (more LLM usage)
  entities: { name: 'person', company: 'organization' }
});

// Custom LLM prompt for domain-specific disambiguation
const customResult = await ctx.memory.semantic.recognize(candidateData, {
  taskContext: ctx,
  entities: { title: 'event', location: 'venue' },
  customPrompt: `
    Compare these two events focusing on:
    1. Event title similarity (most important)
    2. Venue/location match (secondary)
    3. Date proximity (if available)
    
    Candidate: \${candidateData}
    Existing: \${existingData}
    
    Are these the same event?
  `
});

// Recognition without LLM (confidence-only)
const noLLMResult = await ctx.memory.semantic.recognize(candidateData, {
  // No taskContext = no LLM, pure confidence scoring
  threshold: 0.7,
  entities: { title: 'event' }
});
```

#### Recognition Results

```typescript
type RecognitionResult<T> = {
  /** Whether a confident match was found */
  isMatch: boolean;
  /** Confidence score between 0 and 1 */
  confidence: number;
  /** The memory key of the matching entry (if found) */
  matchingKey?: string;
  /** The matching memory data (if found) */
  matchingData?: T;
  /** Whether LLM was used for disambiguation */
  usedLLM: boolean;
  /** Explanation of the matching decision (if LLM was used) */
  explanation?: string;
};
```

#### How Recognition Works

1. **Entity Alignment Matching** - Compares entity values using the universal entity alignment system
2. **Confidence Scoring** - Calculates confidence based on entity similarity and field coverage
3. **Threshold Evaluation** - Determines if confidence meets the specified threshold
4. **Universal Framework** - Works with any domain or entity types without hardcoded logic

#### Recognition Examples

```typescript
// Conference/event recognition
const eventResult = await ctx.memory.semantic.recognize(
  {
    title: 'Tech Conference 2024',
    speaker: 'Jane Doe',
    location: 'Convention Center'
  },
  {
    entities: {
      title: 'event',
      speaker: 'person',
      location: 'location'
    }
  }
);

// User profile recognition
const userResult = await ctx.memory.semantic.recognize(
  {
    name: 'John Smith',
    email: 'j.smith@example.com',
    company: 'Tech Corp'
  },
  {
    entities: {
      name: 'person',
      company: 'organization'
    },
    tags: ['user-profile']  // Only check user profiles
  }
);

// Document recognition with custom threshold
const docResult = await ctx.memory.semantic.recognize(
  {
    title: 'Project Proposal',
    author: 'Sarah Johnson',
    department: 'Engineering'
  },
  {
    entities: {
      title: 'document',
      author: 'person',
      department: 'organization'
    },
    threshold: 0.8  // Higher threshold for document matching
  }
);
```

### Memory Enrichment

The `enrich()` method consolidates data from multiple sources to enhance existing memories and **automatically saves the enriched data back to memory**:

```typescript
// Basic enrichment - automatically saves enriched data
const enrichmentResult = await ctx.memory.semantic.enrich(
  'conference-2024-key',  // Existing memory key
  [
    { venue: 'Main Auditorium', capacity: 500 },
    { duration: '2 hours', ticketPrice: '$50' },
    { category: 'technology', livestream: true }
  ],
  {
    focusFields: ['venue', 'capacity', 'duration']
  }
);

console.log(enrichmentResult.enrichedData);   // Consolidated data
console.log(enrichmentResult.saved);          // true (data was saved)
console.log(enrichmentResult.changes);        // Array of changes made
```

#### Dry Run Mode

If you want to preview enrichment without saving, use the `dryRun` option:

```typescript
// Preview enrichment without saving
const preview = await ctx.memory.semantic.enrich(
  'conference-2024-key',
  [{ capacity: 500, livestream: true }],
  {
    dryRun: true  // Only preview, don't save
  }
);

console.log(preview.enrichedData);  // Preview of enriched data
console.log(preview.saved);         // false (not saved)
```

#### Enrichment Options

```typescript
type EnrichmentOptions = {
  /** Task context containing LLM and tenant information (required for LLM operations) */
  taskContext?: any;
  /** Custom LLM prompt for enrichment guidance */
  customPrompt?: string;
  /** Specific fields to focus enrichment on */
  focusFields?: string[];
  /** JSON schema for validation of enriched result */
  schema?: any;
  /** Whether to force LLM usage for all conflicts (default: false) */
  forceLLMEnrichment?: boolean;
  /** If true, only return enriched data without saving to memory (default: false) */
  dryRun?: boolean;
};
```

#### LLM-Powered Enrichment

The enrichment system can use LLM for complex data consolidation when conflicts need intelligent resolution:

```typescript
// Example with LLM configuration
const enrichmentResult = await ctx.memory.semantic.enrich(
  'event-key',
  [
    { venue: 'Main Hall', duration: '2 hours' },
    { venue: 'Main Auditorium', duration: '120 minutes' }, // Conflicts with above
    { capacity: 500, hasParking: true }
  ],
  {
    taskContext: ctx,                    // Required for LLM operations
    forceLLMEnrichment: true,            // Force LLM usage for conflicts
    focusFields: ['venue', 'duration'],  // Prioritize these fields
    customPrompt: 'Resolve venue name conflicts by choosing the most official name'
  }
);

if (enrichmentResult.usedLLM) {
  console.log('LLM explanation:', enrichmentResult.explanation);
  console.log('Conflicts resolved:', enrichmentResult.changes);
}
```

#### Enrichment Configuration Parameters

| Parameter | Default | Description | When Used |
|-----------|---------|-------------|-----------|
| `taskContext` | `undefined` | TaskContext with LLM access | Required for LLM operations |
| `forceLLMEnrichment` | `false` | Force LLM usage for all conflicts | `true` forces LLM usage |
| `focusFields` | `undefined` | Fields to prioritize during enrichment | Guides LLM attention |
| `customPrompt` | `undefined` | Custom LLM enrichment prompt | Override default consolidation prompt |
| `schema` | `undefined` | JSON schema for result validation | Ensures output structure |

#### Enrichment Decision Flow

```
Data Conflicts → Resolution Process
├─ Simple conflicts + forceLLMEnrichment=false → ✅ Automatic Resolution
├─ Complex conflicts + LLM available → 🤖 LLM Consolidation  
├─ Complex conflicts + no LLM → ⚠️ Manual resolution needed
└─ No conflicts → ✅ Direct merge
```

#### Enrichment Results

```typescript
type EnrichmentResult<T> = {
  /** The enriched data with consolidated information */
  enrichedData: T;
  /** Whether LLM was used for complex enrichment */
  usedLLM: boolean;
  /** Whether the enriched data was saved back to memory (false only when dryRun=true) */
  saved: boolean;
  /** Explanation of enrichment decisions */
  explanation?: string;
  /** Detailed change log */
  changes: Array<{
    field: string;
    action: 'added' | 'updated' | 'resolved_conflict' | 'combined';
    oldValue?: any;
    newValue: any;
    source: 'llm' | 'automatic';
  }>;
};
```

#### How Enrichment Works

1. **Data Consolidation** - Merges additional data with existing memory
2. **Conflict Resolution** - Automatically resolves simple conflicts or uses LLM for complex cases
3. **Field Prioritization** - Focuses on specified fields if provided
4. **Change Tracking** - Records all changes made during enrichment
5. **Automatic Saving** - Saves enriched data back to memory (unless `dryRun: true`)
6. **Metadata Preservation** - Preserves original tags and entity alignments

#### Enrichment Examples

```typescript
// Conference enrichment with automatic conflict resolution
const conferenceEnrichment = await ctx.memory.semantic.enrich(
  'ai-conference-2024',
  [
    { venue: 'Tech Center Hall A', capacity: 300, hasParking: true },
    { duration: '4 hours', breaks: ['10:30 AM', '3:00 PM'] },
    { registration: 'required', price: '$75', earlyBird: '$60' }
  ],
  {
    forceLLMEnrichment: false,
    focusFields: ['venue', 'capacity', 'duration', 'registration']
  }
);

// User profile enrichment with schema validation
const userEnrichment = await ctx.memory.semantic.enrich(
  'user-profile-123',
  [
    { skills: ['JavaScript', 'Python'], experience: '5 years' },
    { location: 'San Francisco', timezone: 'PST' },
    { preferences: { newsletter: true, notifications: false } }
  ],
  {
    schema: {
      type: 'object',
      properties: {
        skills: { type: 'array', items: { type: 'string' } },
        experience: { type: 'string' },
        location: { type: 'string' }
      }
    }
  }
);

// Document enrichment with focused fields
const documentEnrichment = await ctx.memory.semantic.enrich(
  'project-proposal-doc',
  [
    { version: '2.1', lastModified: '2024-01-15' },
    { reviewers: ['Alice', 'Bob'], status: 'approved' },
    { tags: ['important', 'q1-2024'], priority: 'high' }
  ],
  {
    focusFields: ['version', 'status', 'reviewers'],
    forceLLMEnrichment: true  // Force LLM for all conflicts
  }
);
```

### Recognition and Enrichment Workflow

A common pattern is to use recognition and enrichment together:

```typescript
async function smartMemoryStorage(ctx: TaskContext, newData: any, entityConfig: Record<string, string>) {
  // First, try to recognize if this data matches existing memories
  const recognition = await ctx.memory.semantic.recognize(newData, {
    entities: entityConfig,
    threshold: 0.7
  });

  if (recognition.isMatch && recognition.matchingKey) {
    // If we found a match, enrich the existing memory (automatically saves)
    const enrichment = await ctx.memory.semantic.enrich(
      recognition.matchingKey,
      [newData],
      {
        forceLLMEnrichment: false,
        focusFields: Object.keys(entityConfig)
      }
    );

    console.log(`Enhanced existing memory: ${recognition.matchingKey}`);
    console.log(`Changes made: ${enrichment.changes.length}`);
    console.log(`Data saved: ${enrichment.saved}`);
    
    return {
      action: 'enriched',
      key: recognition.matchingKey,
      data: enrichment.enrichedData
    };
  } else {
    // No match found, store as new memory
    const newKey = `memory-${Date.now()}`;
    await ctx.memory.semantic.set(newKey, newData, { entities: entityConfig });
    
    console.log(`Stored new memory: ${newKey}`);
    
    return {
      action: 'created',
      key: newKey,
      data: newData
    };
  }
}

// Usage example
const result = await smartMemoryStorage(ctx, {
  title: 'Machine Learning Workshop',
  instructor: 'Dr. AI Expert',
  location: 'Innovation Lab'
}, {
  title: 'event',
  instructor: 'person',
  location: 'location'
});
```


### Prerequisites

To use recognition and enrichment features:

1. **Entity Alignment Enabled** - Must provide an embedding function to MemorySQLAdapter
2. **Vector Extension** - Requires pgvector extension for PostgreSQL
3. **Entity Configuration** - Must specify entity types for recognition to work effectively

```typescript
import { MemorySQLAdapter } from '@a2arium/memory-sql';
import { createEmbeddingFunction } from '@a2arium/core';

// Create embedding function (requires API key)
const embedFunction = createEmbeddingFunction({
  provider: 'openai',
  model: 'text-embedding-3-small'
});

// Create adapter with entity alignment enabled
const memoryAdapter = new MemorySQLAdapter(prisma, embedFunction);
```

### Recognition Best Practices for Framework Users

#### Entity Configuration is Critical

⚠️ **Important**: Recognition quality depends heavily on entity configuration. Without proper entity mapping, recognition will have low confidence scores.

```typescript
// ❌ Poor recognition - no entity context
const result = await ctx.memory.semantic.recognize(data);  // Low confidence

// ✅ Good recognition - proper entity mapping  
const result = await ctx.memory.semantic.recognize(data, {
  entities: { title: 'event', speaker: 'person', venue: 'location' }
});
```

#### Understanding Confidence Scores

| Range | Meaning | Recommended Action |
|-------|---------|-------------------|
| 0.9-1.0 | Very high match | Automatic deduplication safe |
| 0.8-0.9 | High match | Good for most use cases |
| 0.7-0.8 | Good match | Review threshold based on domain |
| 0.6-0.7 | Moderate match | Consider LLM disambiguation |
| 0.5-0.6 | Low match | Likely different entities |
| < 0.5 | Very low match | Definitely different entities |

#### LLM Disambiguation Behavior

LLM is **only** used when:
1. `taskContext` is provided
2. Confidence score falls between `llmLowerBound` and `llmUpperBound`
3. LLM configuration is valid in the task context

```typescript
// Example: Confidence = 0.7 with defaults
// ✓ 0.7 is between 0.65 (llmLowerBound) and 0.85 (llmUpperBound)
// → LLM will be triggered for disambiguation
```

#### Common Recognition Patterns

```typescript
// Pattern 1: Strict recognition (no LLM)
const strict = await ctx.memory.semantic.recognize(data, {
  threshold: 0.8,  // High threshold
  // No taskContext = no LLM
  entities: { name: 'person' }
});

// Pattern 2: LLM-assisted recognition
const assisted = await ctx.memory.semantic.recognize(data, {
  taskContext: ctx,     // Enable LLM
  threshold: 0.75,      // Standard threshold
  entities: { name: 'person', company: 'organization' }
});

// Pattern 3: Deduplication mode
const dedup = await ctx.memory.semantic.recognize(data, {
  taskContext: ctx,
  threshold: 0.6,       // Lower threshold 
  llmLowerBound: 0.5,   // More LLM usage
  entities: { title: 'document', author: 'person' }
});
```

#### Recognition Performance

- **Entity alignment queries** are the primary performance factor
- **LLM calls** add 1-3 seconds when triggered  
- **Recognition without LLM** is very fast (< 100ms typically)
- **Entity indexes** are critical for good performance

```typescript
// ✅ Fast recognition - entity alignment based
const fastResult = await ctx.memory.semantic.recognize(data, {
  entities: { title: 'event', speaker: 'person' }
});

// ⚠️ Slower recognition - includes LLM disambiguation
const thoroughResult = await ctx.memory.semantic.recognize(data, {
  taskContext: ctx,  // Enables LLM for uncertain cases
  entities: { title: 'event', speaker: 'person' }
});
```

#### Recognition Error Handling

```typescript
try {
  const result = await ctx.memory.semantic.recognize(data, { 
    taskContext: ctx,
    entities: { name: 'person' }
  });
} catch (error) {
  if (error.code === 'ENTITY_ALIGNMENT_UNAVAILABLE') {
    // Fallback to confidence-only recognition
    const fallback = await ctx.memory.semantic.recognize(data, { 
      threshold: 0.7  // No LLM, pure confidence scoring
    });
  } else if (error.code === 'LLM_UNAVAILABLE') {
    // LLM failed - still get confidence-based results
    console.warn('LLM disambiguation unavailable, using confidence only');
  }
}
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
// Single method for all bulk retrieval operations
await ctx.memory.semantic.getMany('user:*');                    // Pattern matching
await ctx.memory.semantic.getMany({ tag: 'user' });             // Query object
await ctx.memory.semantic.getMany('user:*', { limit: 5 });      // Pattern + options

// Single method for all bulk deletion operations
await ctx.memory.semantic.deleteMany('user:*');                 // Pattern matching
await ctx.memory.semantic.deleteMany({ tag: 'user' });          // Query object
await ctx.memory.semantic.deleteMany('user:*', { limit: 5 });   // Pattern + options
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
> Update your `schema.prisma` to match, then run `yarn workspace @a2arium/memory-sql prisma migrate dev` again.

**Q: Can I use a different database?**
> The SQL adapter requires PostgreSQL. Other adapters may support different databases in the future.

**Q: Does the library export a PrismaClient?**
> No. You must create and manage your own PrismaClient instance.

**Q: Can I run migrations from the library?**
> Yes. Run migrations from the `@a2arium/memory-sql` package using Yarn workspaces.

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

**Q: How do I handle nested arrays in entity alignment?**
> The system now supports **natural array traversal** using intuitive dot notation. Instead of explicit indexing like `"titleAndDescription[0].title"`, you can use `"titleAndDescription.title"` and the system will automatically search within array elements for the first matching string value. This works for deeply nested arrays and mixed object/array structures. The natural syntax works for both entity alignment during storage and filter queries during search. See the [Natural Array Support](#natural-array-support) section for comprehensive examples.

**Q: How do the recognize() and enrich() methods work?**
> The `recognize()` method uses entity alignment to determine if incoming data matches existing memories, returning a confidence score and matching details. The `enrich()` method consolidates data from multiple sources to enhance existing memories. Both methods leverage the universal entity alignment framework and work with any domain or entity types without hardcoded logic.

**Q: What's the difference between recognition and entity-aware search?**
> Entity-aware search (`getMany()` with entity operators like `~`) finds memories containing similar entities. Recognition (`recognize()`) determines if entire data objects represent the same real-world entity or event. Recognition is for deduplication and consolidation, while entity-aware search is for discovery and querying.

**Q: Can I use recognition without enrichment?**
> Yes! The methods are independent. Use `recognize()` for duplicate detection, data validation, or conflict prevention. Use `enrich()` for data consolidation from multiple sources. They work great together but each provides value on its own.

**Q: How accurate is memory recognition?**
> Recognition accuracy depends on entity alignment quality and threshold settings. Typical accuracy ranges from 85-95% with proper entity configuration. The system provides confidence scores and detailed explanations to help you tune thresholds for your specific use case. Lower thresholds (0.6-0.7) catch more potential matches but may have false positives, while higher thresholds (0.8-0.9) are more conservative.

**Q: Are the recognition threshold parameters optional?**
> Yes! All recognition threshold parameters are optional and have sensible defaults: `threshold` (default: 0.75), `llmLowerBound` (default: 0.65), and `llmUpperBound` (default: 0.85). You can override any or all of them based on your specific use case. The system works out-of-the-box with default values, but you can fine-tune them for your domain's accuracy requirements.

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
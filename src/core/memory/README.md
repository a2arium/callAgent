# Memory Module

This module implements the long-term memory abstractions for agents in the framework. It provides a clean interface for storing, retrieving, and querying agent memory data.

## Core Interfaces

### `IMemory`

The primary abstraction for agent memory storage:

```typescript
interface IMemory {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options?: { tags?: string[] }): Promise<void>;
  query<T>(opts: MemoryQueryOptions): Promise<Array<MemoryQueryResult<T>>>;
  delete(key: string): Promise<void>;
}
```

## Available Adapters

### `MemorySQLAdapter`

An SQL-based implementation using Prisma ORM with PostgreSQL:

- Stores data as JSON in PostgreSQL's JSONB column type
- Supports tagging and filtering by tags
- Provides advanced JSON field filtering capabilities
- Provides durable, persistent storage for agent memory

#### Setup

1. Configure your PostgreSQL connection in your environment:

```
MEMORY_DATABASE_URL="postgresql://username:password@localhost:5432/memory_db"
```

2. Run Prisma migrations to create the necessary tables:

```bash
npx prisma migrate dev
```

3. Configure the MemorySQLAdapter in your dependency injection container:

```typescript
// Example with InversifyJS
container.bind<PrismaClient>("MemoryPrismaClient").toDynamicValue(() => {
  return new PrismaClient({
    datasources: {
      db: {
        url: process.env.MEMORY_DATABASE_URL
      }
    }
  });
}).inSingletonScope();

container.bind<IMemory>("Memory").to(MemorySQLAdapter);
```

## Usage Examples

### Basic Usage in an Agent

```typescript
// Inside an agent's handleTask method
async handleTask(task: TaskRequest, ctx: TaskContext): Promise<TaskResponse> {
  // Store data with tags
  await ctx.memory.set('user-preferences', {
    theme: 'dark',
    language: 'en-US'
  }, { tags: ['preferences', 'user-settings'] });

  // Retrieve data by key
  const preferences = await ctx.memory.get('user-preferences');
  
  // Query data by tag
  const allPreferences = await ctx.memory.query({ tag: 'preferences' });
  
  // Delete a key
  await ctx.memory.delete('old-preference-key');
  
  return { status: 'success' };
}
```

### Storing Complex Data Structures

The adapter supports any JSON-serializable value:

```typescript
// Store nested structures
await memory.set('customer-123', {
  profile: {
    name: 'Jane Doe',
    email: 'jane@example.com'
  },
  orders: [
    { id: 'ord-1', items: ['product-1', 'product-2'] },
    { id: 'ord-2', items: ['product-3'] }
  ],
  metadata: {
    lastLogin: new Date().toISOString(),
    preferences: { notifications: true }
  }
});

// Get the entire structure back
const customer = await memory.get('customer-123');
console.log(customer.profile.name); // 'Jane Doe'
```

### Using Tags for Organization

Tags provide a flexible way to query related memory entries:

```typescript
// Store related entries with common tags
await memory.set('website-1', { url: 'example.com', status: 'active' }, 
  { tags: ['website', 'crawled'] });
await memory.set('website-2', { url: 'example.org', status: 'pending' }, 
  { tags: ['website', 'pending'] });

// Query all websites
const allWebsites = await memory.query({ tag: 'website' });
// allWebsites.length === 2

// Query only pending websites
const pendingWebsites = await memory.query({ tag: 'pending' });
// pendingWebsites.length === 1
```

### Advanced Filtering with JSON Fields

The `MemorySQLAdapter` supports powerful filtering on JSON field values:

```typescript
// Query active customers created after a specific date
const activeCustomers = await memory.query({
  tag: 'customer',
  filters: [
    { path: 'status', operator: '=', value: 'active' },
    { path: 'createdAt', operator: '>', value: '2023-01-01T00:00:00Z' }
  ],
  limit: 10
});

// Filter by nested properties
const darkModeUsers = await memory.query({
  filters: [
    { path: 'profile.preferences.darkMode', operator: '=', value: true }
  ]
});

// Use string operators for partial matching
const searchResults = await memory.query({
  filters: [
    { path: 'profile.name', operator: 'CONTAINS', value: 'Smith' }
  ]
});

// Combine multiple filters with different operators
const highPriorityActive = await memory.query({
  filters: [
    { path: 'status', operator: '=', value: 'active' },
    { path: 'priority', operator: '>=', value: 8 },
    { path: 'category', operator: '!=', value: 'maintenance' }
  ]
});
```

#### Available Filter Operators

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

## API Reference

### `get<T>(key: string): Promise<T | null>`

Retrieves a value by its key, or returns null if not found.

- **Parameters**:
  - `key`: String identifier for the memory entry
- **Returns**: Promise resolving to the value (type T) or null
- **Errors**: Throws `MemoryError` if database access fails

### `set<T>(key: string, value: T, options?: { tags?: string[] }): Promise<void>`

Stores or updates a value with the given key.

- **Parameters**:
  - `key`: String identifier for the memory entry
  - `value`: The data to store (must be JSON-serializable)
  - `options`: Optional settings
    - `tags`: Array of string tags for organization and querying
- **Returns**: Promise resolving when the operation completes
- **Errors**: Throws `MemoryError` if database access fails

### `query<T>(opts: MemoryQueryOptions): Promise<Array<MemoryQueryResult<T>>>`

Queries memory entries based on tags, filters, or other criteria.

- **Parameters**:
  - `opts`: Query options
    - `tag`: Optional string tag to filter by
    - `limit`: Optional maximum number of results to return
    - `filters`: Optional array of filter conditions for JSON fields
    - `orderBy`: Optional sorting criteria (not implemented yet)
    - `similarityVector`: Not supported in current version
- **Returns**: Promise resolving to array of `{ key, value }` entries
- **Errors**: 
  - Throws `MemoryError` if database access fails
  - Throws `MemoryError` with code 'NOT_IMPLEMENTED' if similarityVector is provided
  - Throws `MemoryError` with code 'NOT_IMPLEMENTED' if orderBy is provided
  - Throws `MemoryError` with code 'INVALID_FILTER' if filters are invalid

### `delete(key: string): Promise<void>`

Deletes a memory entry by key.

- **Parameters**:
  - `key`: String identifier for the memory entry to delete
- **Returns**: Promise resolving when the operation completes
- **Errors**: Throws `MemoryError` if database access fails (excluding "not found" errors)

## Future Enhancements

- Vector similarity search using pgvector extension
- Advanced querying capabilities (multiple tags with AND/OR logic)
- Sorting by JSON field values
- Performance optimizations with caching layer 
# MemorySQL Adapter

The MemorySQL adapter provides durable, SQL-backed memory for agents using PostgreSQL and Prisma.

## Features
- Persistent key-value storage for agent memory
- Tag and filter support for advanced queries
- **Pattern matching with wildcards** for efficient bulk operations and structured key queries
- Easy integration with the CallAgent framework

## Setup
1. **Install dependencies:**
   ```bash
   yarn workspace @callagent/memory-sql add @prisma/client
   yarn workspace @callagent/memory-sql add prisma --dev
   ```
2. **Configure your database:**
   Set `MEMORY_DATABASE_URL` in your `.env`:
   ```env
   MEMORY_DATABASE_URL=postgresql://user:password@localhost:5432/agent
   ```
3. **Run migrations:**
   ```bash
   yarn workspace @callagent/memory-sql prisma migrate dev --name init
   ```

## Usage Example
```typescript
// In your agent's handleTask function
await ctx.memory.semantic.set('user:123:profile', { name: 'John Doe' }, { tags: ['user', 'profile'] });
const value = await ctx.memory.semantic.get('user:123:profile');
const results = await ctx.memory.semantic.query({ tag: 'profile' });
```

## Querying Memory

### Basic Queries
- Query by tag: `ctx.memory.semantic.query({ tag: 'demo' })`
- Query by filter: `ctx.memory.semantic.query({ filters: [{ path: 'status', operator: '=', value: 'active' }] })`

### Pattern Matching (Advanced)

The MemorySQL adapter supports pattern matching for efficient bulk operations using structured keys. This functionality is available by accessing the underlying SQL adapter directly:

```typescript
// Access the SQL backend for pattern matching
const sqlBackend = (ctx.memory.semantic as any).backends?.sql;

if (sqlBackend && typeof sqlBackend.queryByKeyPattern === 'function') {
    // Basic pattern matching with * wildcard
    const userProfiles = await sqlBackend.queryByKeyPattern('user:*:profile');
    const user123Data = await sqlBackend.queryByKeyPattern('user:123:*');
    const configEntries = await sqlBackend.queryByKeyPattern('config:*');
    
    // Advanced pattern matching with * and ? wildcards
    const specificUsers = await sqlBackend.queryByKeyPatternAdvanced('user:???:*');
}
```

#### Pattern Matching Methods

**`queryByKeyPattern(keyPattern: string)`**
- Uses `*` as a wildcard to match any sequence of characters
- Efficient for finding related data with structured keys
- Falls back to exact match when no wildcards are present

**`queryByKeyPatternAdvanced(keyPattern: string)`** 
- Uses `*` to match any sequence of characters
- Uses `?` to match exactly one character
- Provides more precise pattern control

#### Pattern Examples

| Pattern | Description | Matches |
|---------|-------------|---------|
| `user:*:profile` | All user profiles | `user:123:profile`, `user:456:profile` |
| `user:123:*` | All data for user 123 | `user:123:profile`, `user:123:preferences` |
| `config:*` | All configuration entries | `config:app:database`, `config:api:settings` |
| `user:???:*` | Users with 3-character IDs | `user:123:profile`, `user:abc:preferences` |
| `file:*.txt` | All text files | `file:document.txt`, `file:readme.txt` |

### When to Use Each Approach

**Pattern Matching**: Best for
- Structured key hierarchies (e.g., `user:id:type`)
- Bulk operations on related data
- Efficient queries when you control key naming conventions

**Tags**: Best for
- Cross-cutting categorization
- Portable queries across different backends
- Flexible, schema-less organization

**JSON Filters**: Best for
- Querying based on stored value content
- Complex conditional logic
- Dynamic field-based searches

## See Also
- [Memory Usage Example](../examples/memory-usage/) - Comprehensive demonstration including pattern matching
- [Monorepo Overview](./monorepo-overview.md)
- [Full Memory System Guide](./docs/memory-system.md) 
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
   yarn workspace @a2arium/memory-sql add @prisma/client
   yarn workspace @a2arium/memory-sql add prisma --dev
   ```
2. **Configure your database:**
   Set `MEMORY_DATABASE_URL` in your `.env`:
   ```env
   MEMORY_DATABASE_URL=postgresql://user:password@localhost:5432/agent
   ```
3. **Run migrations:**
   ```bash
   yarn workspace @a2arium/memory-sql prisma migrate dev --name init
   ```

## Usage Example
```typescript
// High-level (recommended): use ctx.semantic facade in agents
await ctx.semantic?.add?.({ id: 'user:123:profile', value: { name: 'John Doe' } });
const profile = (await ctx.semantic?.read?.({}))?.find?.((x: any) => x?.id === 'user:123:profile');

// Adapter-level (advanced): direct semantic adapter via facade
await ctx.semantic?.add({ id: 'user:123:profile', value: { name: 'John Doe' }, tags: ['user', 'profile'] });
const value = (await ctx.semantic?.read?.({ id: 'user:123:profile', limit: 1 }))?.[0]?.value;
const results = await ctx.semantic.read({ tag: 'profile' } as any);
```

## Querying Memory

### Basic Queries
- Query by tag: `ctx.semantic.read({ tag: 'demo' } as any)`
- Query by filter: `ctx.semantic.read({ filters: [{ path: 'status', operator: '=', value: 'active' }] } as any)`

### Querying and Filtering

Use the facade for tags and filters instead of direct key patterns:

```typescript
// By tag
const profiles = await ctx.semantic.read({ tag: 'profile', limit: 50 } as any);

// By filters
const activeUsers = await ctx.semantic.read({ filters: ['status = "active"'] as any });

// Array-aware filters
const speakers = await ctx.semantic.read({ filters: ['speakers[].name contains "John"'] as any });
```

### When to Use Each Approach

**Tags**: Best for
- Cross-cutting categorization
- Portable queries across different backends
- Flexible, schema-less organization

**JSON Filters**: Best for
- Querying based on stored value content
- Complex conditional logic
- Dynamic field-based searches

For low-level, backend-specific operations, use the backend directly only if absolutely necessary.

## See Also
- [Memory Usage Example](../examples/memory-usage/)
- [Binary Data Storage](./memory/binary-data-storage.md) - Store images, files, and other binary content
- [Monorepo Overview](./monorepo-overview.md)
- [Full Memory System Guide](./docs/memory-system.md) 
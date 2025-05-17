# MemorySQL Adapter

The MemorySQL adapter provides durable, SQL-backed memory for agents using PostgreSQL and Prisma.

## Features
- Persistent key-value storage for agent memory
- Tag and filter support for advanced queries
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
await ctx.memory.set('demo-key', { foo: 'bar' }, { tags: ['demo'] });
const value = await ctx.memory.get('demo-key');
const results = await ctx.memory.query({ tag: 'demo' });
```

## Querying Memory
- Query by tag: `ctx.memory.query({ tag: 'demo' })`
- Query by filter: `ctx.memory.query({ filters: [{ path: 'status', operator: '=', value: 'active' }] })`

## See Also
- [Monorepo Overview](./monorepo-overview.md)
- [Full Memory System Guide](./docs/memory-system.md) 
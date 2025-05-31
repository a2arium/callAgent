# @callagent/memory-sql

SQL-backed memory adapter for the CallAgent framework with entity alignment capabilities.

## Features

- ✅ **Persistent Memory Storage**: PostgreSQL-backed memory with JSON support
- ✅ **Entity Alignment**: Automatic entity recognition and alignment using vector embeddings
- ✅ **Advanced Filtering**: Complex JSON path queries with multiple operators
- ✅ **Vector Similarity**: pgvector integration for semantic entity matching
- ✅ **Transaction Support**: Atomic operations for data consistency
- ✅ **TypeScript**: Full type safety with proxy objects for aligned entities

## Installation

```bash
yarn add @callagent/memory-sql
```

## Quick Start

```typescript
import { MemorySQLAdapter } from '@callagent/memory-sql';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const adapter = new MemorySQLAdapter(prisma);

// Basic usage
await adapter.set('user-1', { name: 'John', age: 30 });
const user = await adapter.get('user-1');
```

## Entity Alignment

```typescript
// With entity alignment
const embedFunction = async (text: string) => {
  // Your embedding implementation
  return [0.1, 0.2, 0.3, ...]; // 1536-dimensional vector
};

const adapter = new MemorySQLAdapter(prisma, embedFunction);

await adapter.set('event-1', 
  { venue: 'Main Hall', speaker: 'Dr. Smith' },
  { entities: { venue: 'location', speaker: 'person' } }
);

const event = await adapter.get('event-1');
console.log(event.venue.toString()); // "Main Auditorium" (aligned)
console.log(event.venue._original);  // "Main Hall"
console.log(event.venue._wasAligned); // true
```

## Testing

This package uses Jest with ESM configuration. For detailed testing setup and patterns, see:

**📋 [Jest ESM Testing Rules](../../.cursor/rules/jest-esm-testing.md)**

### Running Tests

```bash
# Run all tests
yarn test

# Run with coverage
yarn test:coverage

# Run in watch mode
yarn test:watch
```

## Documentation

- [Memory System Documentation](../../apps/docs/memory-system.md)
- [Entity Alignment Guide](../../apps/docs/memory-system.md#entity-alignment)
- [Advanced Filtering](../../apps/docs/memory-system.md#advanced-filtering)

## Database Setup

```bash
# Setup database and vectors
yarn db:setup

# Reset database
yarn db:reset

# Development migrations
yarn db:dev
```

## License

MIT 
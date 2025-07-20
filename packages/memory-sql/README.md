# @a2arium/callagent-memory-sql

SQL-backed memory persistence adapter for the CallAgent framework using Prisma.

## Installation

```bash
npm install @a2arium/callagent-memory-sql
```

or with yarn:

```bash
yarn add @a2arium/callagent-memory-sql
```

## Setup

1. **Database Setup**: Configure your database connection in your environment:

```bash
DATABASE_URL="postgresql://username:password@localhost:5432/callagent"
```

2. **Run Migrations**: Set up the database schema:

```bash
npx prisma migrate deploy
```

3. **Generate Client**: Generate the Prisma client:

```bash
npx prisma generate
```

## Usage

### Working Memory

```typescript
import { WorkingMemoryRegistry } from '@a2arium/callagent-memory-sql';

const workingMemory = new WorkingMemoryRegistry({
  tenantId: 'user-123'
});

// Store data
await workingMemory.store('key', 'value');

// Retrieve data
const record = await workingMemory.recall('key');
console.log(record?.content); // 'value'
```

### Episodic Memory

```typescript
import { EpisodicMemoryRegistry } from '@a2arium/callagent-memory-sql';

const episodicMemory = new EpisodicMemoryRegistry({
  tenantId: 'user-123'
});

// Store an event
await episodicMemory.store({
  event: 'user_login',
  timestamp: new Date(),
  context: { userId: '123', ip: '192.168.1.1' }
});
```

### Semantic Memory

```typescript
import { SemanticMemoryRegistry } from '@a2arium/callagent-memory-sql';

const semanticMemory = new SemanticMemoryRegistry({
  tenantId: 'user-123'
});

// Store knowledge
await semanticMemory.store({
  concept: 'AI Agent',
  definition: 'An autonomous software entity...',
  embeddings: vectorData
});

// Semantic search
const results = await semanticMemory.search('artificial intelligence');
```

## Features

- **Multi-tenant Support**: Isolated data per tenant/user
- **Vector Storage**: Semantic search with embeddings
- **ACID Transactions**: Reliable data persistence
- **Binary Data Support**: Store files, images, and binary content
- **Optimized Queries**: Performance-tuned database operations

## Database Support

- PostgreSQL (recommended)
- MySQL
- SQLite (for development)

## License

MIT 
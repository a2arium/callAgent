# @a2arium/callagent-memory-sql

SQL-backed memory persistence adapter for the CallAgent framework using Prisma with PostgreSQL and vector embeddings support.

## Installation

```bash
npm install @a2arium/callagent-memory-sql
```

or with yarn:

```bash
yarn add @a2arium/callagent-memory-sql
```

## Database Requirements

### PostgreSQL with pgvector Extension

This package requires **PostgreSQL 12+** with the **pgvector** extension for vector embeddings support.

#### Ubuntu/Debian Setup
```bash
# Install PostgreSQL 
sudo apt update
sudo apt install postgresql postgresql-contrib

# Install pgvector extension (adjust version number)
sudo apt install postgresql-16-pgvector

# Create database and user
sudo -u postgres psql << 'EOF'
CREATE USER agent WITH PASSWORD 'YourSecurePassword2024!';
CREATE DATABASE agent OWNER agent;
\c agent;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  
GRANT USAGE, CREATE ON SCHEMA public TO agent;
GRANT ALL ON ALL TABLES IN SCHEMA public TO agent;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO agent;
EOF
```

#### Other Systems
- **CentOS/RHEL**: `sudo yum install pgvector`
- **macOS**: `brew install pgvector`
- **Docker**: Use `pgvector/pgvector:pg16` image

## Quick Setup

### 1. Configure Database Connection

**Option A: Create `.env` file (Recommended)**
```bash
# Create .env file in your project root
DATABASE_URL="postgresql://agent:YourSecurePassword2024!@localhost:5432/agent"
```

**Option B: Environment Variable**
```bash
export DATABASE_URL="postgresql://agent:YourSecurePassword2024!@localhost:5432/agent"
# OR
export MEMORY_DATABASE_URL="postgresql://agent:YourSecurePassword2024!@localhost:5432/agent"
```

### 2. Run Database Setup

```bash
# Complete setup (migrations + client generation)
npx @a2arium/callagent-memory-sql setup
```

### 3. View Database (Optional)

```bash
# Open Prisma Studio to view/edit data
npx @a2arium/callagent-memory-sql studio
# Opens at http://localhost:5555
```

## Management Commands

The package includes a helper script for database management:

```bash
# Full setup (recommended for first time)
npx @a2arium/callagent-memory-sql setup

# Run migrations only
npx @a2arium/callagent-memory-sql migrate

# Generate Prisma client only  
npx @a2arium/callagent-memory-sql generate

# Open Prisma Studio database viewer
npx @a2arium/callagent-memory-sql studio

# Show help
npx @a2arium/callagent-memory-sql help
```

### Alternative: Direct Prisma Commands

If you prefer using Prisma directly:

```bash
# From the package directory
cd node_modules/@a2arium/callagent-memory-sql
npx prisma migrate deploy
npx prisma generate  
npx prisma studio
```

## Usage

### Basic Integration

```typescript
import { MemorySQLAdapter } from '@a2arium/callagent-memory-sql';

// Option 1: Use environment variables (recommended)
const adapter = new MemorySQLAdapter();

// Option 2: Provide database URL directly
const adapter = new MemorySQLAdapter({
  databaseUrl: "postgresql://agent:password@localhost:5432/agent"
});

// Option 3: Use pre-configured Prisma client
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const adapter = new MemorySQLAdapter({
  prismaClient: prisma
});
```

### With CallAgent Framework

```typescript
import { createAgent } from '@a2arium/callagent-core';

const agent = createAgent(manifest, handler, {
  memory: {
    database: {
      url: process.env.DATABASE_URL
    }
  }
});
```

### Working Memory

```typescript
import { WorkingMemorySQLAdapter } from '@a2arium/callagent-memory-sql';

const workingMemory = new WorkingMemorySQLAdapter({
  databaseUrl: process.env.DATABASE_URL,
  defaultTenantId: 'user-123'
});

// Store goals, thoughts, decisions, variables
await workingMemory.setGoal({ type: 'task', description: 'Complete analysis' });
await workingMemory.addThought('Processing user input...');
await workingMemory.makeDecision('approach', 'Use analytical method');
await workingMemory.setVariable('status', 'processing');
```

### Semantic Memory with Vectors

```typescript
import { MemorySQLAdapter } from '@a2arium/callagent-memory-sql';

const semanticMemory = new MemorySQLAdapter({
  defaultTenantId: 'user-123',
  embedFunction: async (text) => {
    // Your embedding function (OpenAI, etc.)
    return await generateEmbedding(text);
  }
});

// Store with automatic embedding
await semanticMemory.set('concept', {
  definition: 'AI Agent is an autonomous software entity...',
  examples: ['ChatGPT', 'Claude', 'GPT-4']
});

// Semantic search using vector similarity
const results = await semanticMemory.queryByVector(queryEmbedding, {
  limit: 10,
  threshold: 0.8
});
```

### Binary Data Storage

```typescript
// Store images, files, or any binary data
await semanticMemory.set('user-avatar', {
  type: 'image',
  description: 'User profile picture'
}, {
  binaryData: imageBuffer,
  binaryMetadata: {
    filename: 'avatar.jpg',
    contentType: 'image/jpeg',
    size: imageBuffer.length
  }
});
```

## Automatic Tag Normalization

CallAgent automatically normalizes all tags to lowercase for consistent, case-insensitive searching:

### How it Works
- **Storage**: All tags are automatically converted to lowercase and trimmed
- **Search**: Tag queries are normalized before searching, enabling case-insensitive matching  
- **Deduplication**: Duplicate tags (after normalization) are automatically removed

### Examples

```typescript
// Store with mixed case tags
await memory.set('event-key', eventData, {
  tags: ['RIGA', '  Latvia  ', 'Events', 'riga'] // Mixed case with duplicates
});

// Stored as: ['riga', 'latvia', 'events'] (normalized, deduplicated)

// Search with any case - all find the same result
await memory.getMany({ tag: 'RIGA' });     // ✅ Found
await memory.getMany({ tag: 'Riga' });     // ✅ Found  
await memory.getMany({ tag: 'riga' });     // ✅ Found
await memory.getMany({ tag: '  RIGA  ' }); // ✅ Found (trimmed)
```

### Semantic Search with Tags

```typescript
// Store event with tags
await memory.set('event-1', {
  eventOccurences: [{ date: '2025-07-17' }],
  location: 'Riga'
}, {
  tags: ['RIGA', 'Latvia', 'EVENTS'] // Will be stored as ['riga', 'latvia', 'events']
});

// Search with case-insensitive tag and filters
const results = await memory.getMany({
  tag: 'riga', // Any case works
  filters: [
    {
      path: 'eventOccurences',
      operator: 'CONTAINS',
      value: { date: '2025-07-17' }
    }
  ]
});
```

**Note**: This normalization applies to all memory operations including regular storage, blob storage, and semantic search.

## Features

- ✅ **Multi-tenant Support**: Complete data isolation per tenant
- ✅ **Vector Embeddings**: Semantic search with pgvector
- ✅ **Binary Data Storage**: Store files, images, and binary content  
- ✅ **ACID Transactions**: Reliable data consistency
- ✅ **Working Memory**: Goals, thoughts, decisions, variables
- ✅ **Entity Recognition**: Automatic entity alignment and recognition
- ✅ **Performance Optimized**: Efficient indexes and query patterns
- ✅ **Environment Agnostic**: Works with any database configuration
- ✅ **Development Tools**: Built-in Prisma Studio integration

## Database Schema

The adapter creates these main tables:

- **`agent_memory_store`**: Main semantic memory with vector embeddings
- **`entity_store`**: Entity recognition and canonical naming  
- **`entity_alignment`**: Links between memory entries and entities
- **`working_memory_*`**: Working memory tables (goals, thoughts, decisions, variables)
- **`agent_result_cache`**: Task result caching
- **`blob_storage`**: Binary data storage with metadata

## Configuration Options

```typescript
interface MemorySQLConfig {
  /** Pre-configured Prisma client instance */
  prismaClient?: PrismaClient;
  /** Database connection URL (used if prismaClient not provided) */
  databaseUrl?: string;
  /** Default tenant ID for operations */
  defaultTenantId?: string;
  /** Embedding function for vector operations */
  embedFunction?: (text: string) => Promise<number[]>;
  /** Default query result limit */
  defaultQueryLimit?: number;
}
```

## Troubleshooting

### Common Issues

**"prisma: command not found"**
- Use the helper script: `npx @a2arium/callagent-memory-sql setup`
- The script automatically uses `npx prisma` for all operations

**"vector extension not found"**
- Install pgvector: `sudo apt install postgresql-16-pgvector`
- Enable extension: `CREATE EXTENSION IF NOT EXISTS vector;`

**Connection errors**
- Verify DATABASE_URL format: `postgresql://user:pass@host:port/dbname`
- Check if PostgreSQL is running: `sudo systemctl status postgresql`
- Verify user permissions: `GRANT ALL PRIVILEGES ON DATABASE dbname TO user;`

**Development vs Production**
- The package detects environment automatically
- `.env` files are only loaded in development/library mode
- In production, use your deployment platform's environment variables

## Development

To contribute or modify this package:

```bash
# Clone the repository
git clone <repository-url>

# Install dependencies  
yarn install

# Run tests
yarn test

# Build the package
yarn build
```

## License

MIT 
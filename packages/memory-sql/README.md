# @callagent/memory-sql

SQL-backed memory adapter for the CallAgent framework, using Prisma ORM and PostgreSQL.

## Installation

```bash
yarn add @callagent/memory-sql
```

## Setup

1. **Set up your database connection:**
   - Add a `.env` file or set the `DATABASE_URL` environment variable to your PostgreSQL connection string.

2. **Run migrations:**
   - From the package root:
     ```bash
     npx prisma migrate deploy --schema=./prisma/schema.prisma
     ```
   - Or, for development:
     ```bash
     npx prisma migrate dev --schema=./prisma/schema.prisma
     ```

3. **Generate Prisma client:**
   - This runs automatically on install via the `postinstall` script:
     ```bash
     yarn install
     # or
     npx prisma generate --schema=./prisma/schema.prisma
     ```

## Usage

```typescript
import { MemorySQLAdapter } from '@callagent/memory-sql';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const memory = new MemorySQLAdapter(prisma);

await memory.set('key', { foo: 'bar' }, { tags: ['example'] });
const value = await memory.get('key');
```

## Environment Variables
- `DATABASE_URL`: PostgreSQL connection string (required)

## Migration Flow
- Use `prisma migrate` commands as above to apply schema changes.
- See the `prisma/` directory for schema and migration files.

## Testing
- Run unit tests:
  ```bash
  yarn test
  ```
- Integration tests require a running PostgreSQL instance and `DATABASE_URL` set.

---

See the main CallAgent framework docs for more details on memory adapters and configuration. 
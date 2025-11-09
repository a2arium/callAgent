# OutboxPublisher Race Condition Testing

This directory contains comprehensive tests for the Prisma Outbox Publisher race condition issue where concurrent processes attempt to delete the same outbox records.

## Problem Description

The OutboxPublisher processes outbox records sequentially, but in production environments with multiple application instances, race conditions occur when multiple publishers try to delete the same record simultaneously, resulting in "No record was found for a delete" errors.

## Test Categories

### 1. Unit Tests (`outbox-race-condition.test.ts`)
- Tests individual OutboxPublisher methods
- Mocks Prisma to simulate race conditions
- Verifies idempotent delete behavior
- Tests error handling for various scenarios

### 2. Integration Tests (`outbox-concurrency.integration.test.ts`)
- Tests real concurrent processing scenarios
- Requires test database with outbox table
- Simulates multiple publishers running simultaneously
- Verifies data integrity under load

### 3. Monitoring Tests (`outbox-monitoring.test.ts`)
- Tests database health and accumulation prevention
- Monitors for stale record buildup
- Tests cleanup effectiveness
- Provides alerting thresholds

## Running the Tests

### Prerequisites
```bash
# Set up test database
export TEST_DATABASE_URL="postgresql://test:test@localhost:5432/test_db"

# Install dependencies
yarn install
```

### Run Unit Tests
```bash
# From project root
yarn test packages/core/src/eventbus/__tests__/outbox-race-condition.test.ts
```

### Run Integration Tests
```bash
# Requires running PostgreSQL test database
yarn test packages/core/src/eventbus/__tests__/outbox-concurrency.integration.test.ts
```

### Run Monitoring Tests
```bash
yarn test packages/core/src/eventbus/__tests__/outbox-monitoring.test.ts
```

### Run All Outbox Tests
```bash
yarn test packages/core/src/eventbus/__tests__/
```

## Test Scenarios Covered

### Race Condition Scenarios
1. **Record Already Deleted**: Another process deleted the record between `findMany` and `delete`
2. **Concurrent Publishers**: Multiple OutboxPublisher instances processing the same records
3. **Mixed Success/Failure**: Some records process successfully, others fail race conditions
4. **Idempotent Operations**: Delete operations that don't fail when record is missing

### Performance Scenarios
1. **High Throughput**: Processing large batches of records
2. **Concurrent Load**: Multiple publishers under simultaneous load
3. **Large Payloads**: Records with substantial data

### Monitoring Scenarios
1. **Stale Record Detection**: Identifying records that remain unprocessed
2. **Growth Rate Monitoring**: Detecting unhealthy accumulation
3. **Error Rate Tracking**: Monitoring cleanup operation success rates
4. **Data Integrity**: Ensuring no corruption or duplication

## Test Database Schema

The tests require a PostgreSQL database with the outbox table:

```sql
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  key TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_outbox_tenant_created ON outbox(tenant_id, created_at);
CREATE INDEX idx_outbox_created ON outbox(created_at);
```

## Expected Test Results

### Before Fix
- ❌ Unit tests fail with unhandled "record not found" errors
- ❌ Integration tests show accumulating error logs
- ❌ Monitoring tests detect growing stale record counts

### After Fix
- ✅ Unit tests pass with graceful race condition handling
- ✅ Integration tests show clean concurrent processing
- ✅ Monitoring tests show healthy database state

## Production Monitoring

Based on these tests, implement the following monitoring:

```sql
-- Daily health check
SELECT
  COUNT(*) as total_records,
  COUNT(CASE WHEN created_at < NOW() - INTERVAL '1 hour' THEN 1 END) as records_older_than_1h,
  COUNT(CASE WHEN created_at < NOW() - INTERVAL '24 hours' THEN 1 END) as records_older_than_24h
FROM outbox;

-- Alert thresholds
-- - records_older_than_1h > 1000
-- - records_older_than_24h > 100
-- - total_records growing > 10% per hour
```

## Fix Implementation

The fix implemented in `OutboxPublisher.publishOnce()`:

```typescript
await this.prisma.outbox.delete({ where: { id: row.id } }).catch((deleteError: any) => {
  // Check if it's a "record not found" error (P2025 in Prisma)
  if (deleteError.code === 'P2025' || deleteError.message?.includes('No record was found')) {
    log.debug('Outbox record already deleted by another process', { id: row.id });
    return; // This is expected in concurrent scenarios
  }
  throw deleteError; // Re-throw other errors
});
```

This makes the delete operation idempotent - it's safe to call multiple times even if the record has already been deleted.

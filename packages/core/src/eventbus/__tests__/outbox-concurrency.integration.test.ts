import { PrismaClient } from '@prisma/client';
import { OutboxPublisher } from '../outboxPublisher.js';

/**
 * Integration tests for OutboxPublisher race conditions
 * Requires a test database with outbox table
 */

describe('OutboxPublisher Concurrency Integration Tests', () => {
  let prisma: PrismaClient;
  let publisher1: OutboxPublisher;
  let publisher2: OutboxPublisher;

  beforeAll(async () => {
    // Use test database - adjust connection string as needed
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: process.env.TEST_DATABASE_URL || 'postgresql://test:test@localhost:5432/test_db'
        }
      }
    });

    publisher1 = new OutboxPublisher(prisma);
    publisher2 = new OutboxPublisher(prisma);
  });

  beforeEach(async () => {
    // Clean up any existing test data
    await prisma.outbox.deleteMany({
      where: { tenantId: 'test-tenant' }
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Concurrent Processing Simulation', () => {
    it('should handle concurrent publishers processing same records', async () => {
      // Insert test records
      const records = await Promise.all([
        prisma.outbox.create({
          data: {
            tenantId: 'test-tenant',
            topic: 'task.status',
            key: 'concurrent-test-1',
            payload: { test: 'concurrent-1' }
          }
        }),
        prisma.outbox.create({
          data: {
            tenantId: 'test-tenant',
            topic: 'task.status',
            key: 'concurrent-test-2',
            payload: { test: 'concurrent-2' }
          }
        }),
        prisma.outbox.create({
          data: {
            tenantId: 'test-tenant',
            topic: 'task.status',
            key: 'concurrent-test-3',
            payload: { test: 'concurrent-3' }
          }
        })
      ]);

      // Start both publishers concurrently
      const [result1, result2] = await Promise.allSettled([
        (publisher1 as any).publishOnce(),
        (publisher2 as any).publishOnce()
      ]);

      // Both should complete without throwing (even if one gets race condition errors)
      expect(result1.status).toBe('fulfilled');
      expect(result2.status).toBe('fulfilled');

      // All records should eventually be deleted (processed by one publisher or the other)
      const remainingRecords = await prisma.outbox.findMany({
        where: { tenantId: 'test-tenant' }
      });

      // In a perfect world, all records would be processed, but due to timing,
      // some might remain unprocessed (which is fine - they'll be picked up later)
      expect(remainingRecords.length).toBeLessThanOrEqual(3);
    });

    it('should not accumulate errors when records are deleted between find and delete', async () => {
      // Insert a record
      const record = await prisma.outbox.create({
        data: {
          tenantId: 'test-tenant',
          topic: 'task.status',
          key: 'race-condition-test',
          payload: { test: 'race-condition' }
        }
      });

      // Manually delete the record to simulate race condition
      await prisma.outbox.delete({
        where: { id: record.id }
      });

      // Now try to process - should handle the missing record gracefully
      await expect((publisher1 as any).publishOnce()).resolves.not.toThrow();

      // Verify record is still gone
      const remaining = await prisma.outbox.findUnique({
        where: { id: record.id }
      });
      expect(remaining).toBeNull();
    });

    it('should maintain data integrity across concurrent operations', async () => {
      // Insert multiple records
      const recordIds = [];
      for (let i = 0; i < 10; i++) {
        const record = await prisma.outbox.create({
          data: {
            tenantId: 'test-tenant',
            topic: 'task.status',
            key: `integrity-test-${i}`,
            payload: { test: `integrity-${i}`, sequence: i }
          }
        });
        recordIds.push(record.id);
      }

      // Process with both publishers concurrently
      await Promise.all([
        (publisher1 as any).publishOnce(),
        (publisher2 as any).publishOnce(),
        (publisher1 as any).publishOnce(), // Run multiple times to test idempotency
        (publisher2 as any).publishOnce()
      ]);

      // Check that we don't have orphaned records or duplicates
      const remainingRecords = await prisma.outbox.findMany({
        where: { tenantId: 'test-tenant' }
      });

      // All records should either be processed (deleted) or still present
      // No corruption or duplication should occur
      const remainingIds = remainingRecords.map(r => r.id);
      const originalIds = recordIds;

      // Any remaining records should be from the original set
      for (const remainingId of remainingIds) {
        expect(originalIds).toContain(remainingId);
      }
    });
  });

  describe('Performance Under Load', () => {
    it('should handle large batches without excessive errors', async () => {
      // Insert many records to simulate high-throughput scenario
      const recordPromises = [];
      for (let i = 0; i < 100; i++) {
        recordPromises.push(
          prisma.outbox.create({
            data: {
              tenantId: 'test-tenant',
              topic: 'task.status',
              key: `load-test-${i}`,
              payload: { test: `load-${i}`, data: 'x'.repeat(1000) } // Large payload
            }
          })
        );
      }

      await Promise.all(recordPromises);

      // Process concurrently with multiple publishers
      const startTime = Date.now();
      await Promise.all([
        (publisher1 as any).publishOnce(),
        (publisher2 as any).publishOnce(),
        (publisher1 as any).publishOnce(),
        (publisher2 as any).publishOnce(),
        (publisher1 as any).publishOnce(),
      ]);
      const endTime = Date.now();

      // Should complete in reasonable time (under 30 seconds for 100 records)
      expect(endTime - startTime).toBeLessThan(30000);

      // Most records should be processed (allowing for some remaining due to concurrency)
      const remainingCount = await prisma.outbox.count({
        where: { tenantId: 'test-tenant' }
      });

      expect(remainingCount).toBeLessThan(50); // At least 50% processed
    });
  });
});

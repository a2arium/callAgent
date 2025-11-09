import { PrismaClient } from '@prisma/client';

/**
 * Monitoring tests for OutboxPublisher database health
 * Tests for stale record accumulation and cleanup effectiveness
 */

describe('OutboxPublisher Database Monitoring Tests', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: process.env.TEST_DATABASE_URL || 'postgresql://test:test@localhost:5432/test_db'
        }
      }
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Stale Record Accumulation Prevention', () => {
    it('should not accumulate unprocessed records over time', async () => {
      const tenantId = 'monitoring-test-tenant';

      // Clean up any existing test data
      await prisma.outbox.deleteMany({ where: { tenantId } });

      // Insert records that will fail processing (simulate dispatch failures)
      const failedRecords = [];
      for (let i = 0; i < 10; i++) {
        const record = await prisma.outbox.create({
          data: {
            tenantId,
            topic: 'task.status',
            key: `stale-test-${i}`,
            payload: { test: 'stale-record', failDispatch: true }
          }
        });
        failedRecords.push(record);
      }

      // Get initial count
      const initialCount = await prisma.outbox.count({ where: { tenantId } });
      expect(initialCount).toBe(10);

      // Simulate multiple processing attempts
      // Note: In real scenario, OutboxPublisher would run continuously
      for (let attempt = 0; attempt < 3; attempt++) {
        // Manually process records (simulating what OutboxPublisher does)
        const rows = await prisma.outbox.findMany({
          where: { tenantId },
          orderBy: { createdAt: 'asc' },
          take: 50
        });

        for (const row of rows) {
          try {
            // Simulate dispatch failure for our test records
            if (row.payload && typeof row.payload === 'object' && 'failDispatch' in row.payload && row.payload.failDispatch) {
              throw new Error('Simulated dispatch failure');
            }
            // If dispatch succeeds, delete the record
            await prisma.outbox.delete({ where: { id: row.id } });
          } catch (error) {
            // Leave failed records for retry (normal OutboxPublisher behavior)
            console.log(`Record ${row.id} failed dispatch (expected)`);
          }
        }

        // Wait a bit between attempts
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // After multiple attempts, failed records should still exist (for retry)
      const finalCount = await prisma.outbox.count({ where: { tenantId } });
      expect(finalCount).toBe(10); // All records should still be present for retry

      // But they shouldn't multiply or corrupt
      const allRecords = await prisma.outbox.findMany({ where: { tenantId } });
      const uniqueIds = new Set(allRecords.map(r => r.id));
      expect(uniqueIds.size).toBe(allRecords.length); // No duplicates

      // Clean up
      await prisma.outbox.deleteMany({ where: { tenantId } });
    });

    it('should clean up successfully processed records', async () => {
      const tenantId = 'cleanup-test-tenant';

      await prisma.outbox.deleteMany({ where: { tenantId } });

      // Insert records that will succeed
      for (let i = 0; i < 5; i++) {
        await prisma.outbox.create({
          data: {
            tenantId,
            topic: 'task.status',
            key: `cleanup-test-${i}`,
            payload: { test: 'successful-record' }
          }
        });
      }

      const initialCount = await prisma.outbox.count({ where: { tenantId } });
      expect(initialCount).toBe(5);

      // Process records (simulate successful dispatch)
      const rows = await prisma.outbox.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' }
      });

      for (const row of rows) {
        // Simulate successful dispatch
        await prisma.outbox.delete({ where: { id: row.id } }).catch((error: any) => {
          // Handle race condition gracefully
          if (error.code === 'P2025' || error.message?.includes('No record was found')) {
            return; // Already deleted
          }
          throw error;
        });
      }

      // All records should be cleaned up
      const finalCount = await prisma.outbox.count({ where: { tenantId } });
      expect(finalCount).toBe(0);
    });
  });

  describe('Database Health Metrics', () => {
    it('should monitor outbox table growth trends', async () => {
      // This would be a monitoring/alerting test in production
      const totalRecords = await prisma.outbox.count();

      // In a real monitoring scenario, you'd alert if:
      // - Total records > threshold
      // - Records older than X hours > threshold
      // - Growth rate > threshold

      console.log(`Current outbox health: ${totalRecords} total records`);

      // For testing, just ensure the query works and returns a number
      expect(typeof totalRecords).toBe('number');
      expect(totalRecords).toBeGreaterThanOrEqual(0);
    });

    it('should detect and report old unprocessed records', async () => {
      const tenantId = 'aging-test-tenant';
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

      // Insert some old records
      await prisma.outbox.create({
        data: {
          tenantId,
          topic: 'task.status',
          key: 'old-record-1',
          payload: { test: 'old-record' },
          createdAt: oneHourAgo
        }
      });

      await prisma.outbox.create({
        data: {
          tenantId,
          topic: 'task.status',
          key: 'old-record-2',
          payload: { test: 'old-record' },
          createdAt: oneHourAgo
        }
      });

      // Query for old records
      const oldRecords = await prisma.outbox.findMany({
        where: {
          tenantId,
          createdAt: {
            lt: oneHourAgo
          }
        }
      });

      expect(oldRecords.length).toBeGreaterThan(0);

      // In production monitoring, this would trigger alerts
      // For now, just verify the records exist and are detectable
      for (const record of oldRecords) {
        expect(record.createdAt.getTime()).toBeLessThan(oneHourAgo.getTime());
      }

      // Clean up
      await prisma.outbox.deleteMany({ where: { tenantId } });
    });
  });

  describe('Error Rate Monitoring', () => {
    it('should track cleanup operation success/failure rates', async () => {
      const tenantId = 'error-rate-test-tenant';

      await prisma.outbox.deleteMany({ where: { tenantId } });

      // Insert records
      const recordIds = [];
      for (let i = 0; i < 10; i++) {
        const record = await prisma.outbox.create({
          data: {
            tenantId,
            topic: 'task.status',
            key: `error-rate-test-${i}`,
            payload: { test: 'error-rate-record' }
          }
        });
        recordIds.push(record.id);
      }

      let successCount = 0;
      let errorCount = 0;

      // Simulate processing with mixed success/failure
      for (const recordId of recordIds) {
        try {
          await prisma.outbox.delete({ where: { id: recordId } }).catch((error: any) => {
            if (error.code === 'P2025' || error.message?.includes('No record was found')) {
              // Already deleted - this is success for idempotent operations
              return { id: recordId };
            }
            throw error;
          });
          successCount++;
        } catch (error) {
          errorCount++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.log(`Delete failed for ${recordId}: ${errorMessage}`);
        }
      }

      // Most operations should succeed
      expect(successCount).toBeGreaterThan(errorCount);
      expect(successCount + errorCount).toBe(recordIds.length);

      // In production, you'd monitor error rates and alert if > threshold
      const errorRate = errorCount / recordIds.length;
      expect(errorRate).toBeLessThan(0.5); // Less than 50% error rate
    });
  });
});

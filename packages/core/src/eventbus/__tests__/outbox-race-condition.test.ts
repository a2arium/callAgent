import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import { OutboxPublisher } from '../outboxPublisher.js';

type OutboxRow = { id: string; tenantId: string; topic: string; key: string; payload: any; createdAt: Date };

// Mock Prisma to simulate race conditions
const mockPrisma = {
  outbox: {
    findMany: jest.fn() as jest.MockedFunction<() => Promise<OutboxRow[]>>,
    delete: jest.fn() as jest.MockedFunction<(args: { where: { id: string } }) => Promise<{ id: string }>>,
  },
};

describe('OutboxPublisher Race Condition Tests', () => {
  let publisher: OutboxPublisher;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
    };

    // Mock the logger
    jest.mock('@a2arium/callagent-utils', () => ({
      logger: {
        createLogger: () => mockLogger,
      },
    }));

    publisher = new OutboxPublisher(mockPrisma as any);
  });

  describe('Concurrent Delete Handling', () => {
    it('should handle record already deleted gracefully', async () => {
      const testRow = {
        id: 'test-id-123',
        tenantId: 'default',
        topic: 'task.status',
        key: 'session-123',
        payload: { status: 'completed' },
        createdAt: new Date(),
      };

      // Mock findMany to return our test row
      mockPrisma.outbox.findMany.mockResolvedValue([testRow]);

      // Mock delete to simulate "record not found" error (P2025)
      mockPrisma.outbox.delete.mockRejectedValue({
        code: 'P2025',
        message: 'No record was found for a delete',
      });

      // This should not throw
      await (publisher as any).publishOnce();

      // Should have attempted dispatch
      expect(mockLogger.info).toHaveBeenCalledWith('Dispatch', expect.any(Object));

      // Should have logged debug message about already deleted record
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Outbox record already deleted by another process',
        { id: 'test-id-123' }
      );

      // Should NOT have logged an error
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should re-throw non-P2025 delete errors', async () => {
      const testRow = {
        id: 'test-id-456',
        tenantId: 'default',
        topic: 'task.status',
        key: 'session-456',
        payload: { status: 'failed' },
        createdAt: new Date(),
      };

      mockPrisma.outbox.findMany.mockResolvedValue([testRow]);
      mockPrisma.outbox.delete.mockRejectedValue(new Error('Database connection lost'));

      await expect((publisher as any).publishOnce()).rejects.toThrow('Database connection lost');

      // Should still attempt dispatch
      expect(mockLogger.info).toHaveBeenCalledWith('Dispatch', expect.any(Object));

      // Should log the error
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to dispatch outbox row',
        expect.any(Error),
        expect.objectContaining({ id: 'test-id-456', topic: 'task.status' })
      );
    });

    it('should handle generic "No record was found" message', async () => {
      const testRow = {
        id: 'test-id-789',
        tenantId: 'default',
        topic: 'task.input_required',
        key: 'session-789',
        payload: { prompt: 'test' },
        createdAt: new Date(),
      };

      mockPrisma.outbox.findMany.mockResolvedValue([testRow]);
      mockPrisma.outbox.delete.mockRejectedValue(new Error('No record was found for a delete'));

      await (publisher as any).publishOnce();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Outbox record already deleted by another process',
        { id: 'test-id-789' }
      );
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('Successful Processing', () => {
    it('should process and delete records normally', async () => {
      const testRow = {
        id: 'success-id',
        tenantId: 'default',
        topic: 'task.status',
        key: 'session-success',
        payload: { status: 'completed' },
        createdAt: new Date(),
      };

      mockPrisma.outbox.findMany.mockResolvedValue([testRow]);
      mockPrisma.outbox.delete.mockResolvedValue({ id: 'success-id' });

      await (publisher as any).publishOnce();

      expect(mockLogger.info).toHaveBeenCalledWith('Dispatch', expect.any(Object));
      expect(mockLogger.debug).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('Multiple Records Processing', () => {
    it('should handle mixed success/failure scenarios', async () => {
      const rows = [
        { id: 'success-1', tenantId: 'default', topic: 'task.status', key: 's1', payload: {}, createdAt: new Date() },
        { id: 'already-deleted', tenantId: 'default', topic: 'task.status', key: 's2', payload: {}, createdAt: new Date() },
        { id: 'success-2', tenantId: 'default', topic: 'task.status', key: 's3', payload: {}, createdAt: new Date() },
      ];

      mockPrisma.outbox.findMany.mockResolvedValue(rows);

      // Mock delete: success, P2025 error, success
      mockPrisma.outbox.delete
        .mockResolvedValueOnce({ id: 'success-1' })
        .mockRejectedValueOnce({ code: 'P2025', message: 'No record was found' })
        .mockResolvedValueOnce({ id: 'success-2' });

      await (publisher as any).publishOnce();

      // Should have dispatched all 3 records
      expect(mockLogger.info).toHaveBeenCalledTimes(3);

      // Should have logged one debug message for the already-deleted record
      expect(mockLogger.debug).toHaveBeenCalledTimes(1);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Outbox record already deleted by another process',
        { id: 'already-deleted' }
      );

      // Should not have logged any errors
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });
});

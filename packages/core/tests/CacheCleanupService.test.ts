import { CacheCleanupService, type CacheStats } from '../src/core/cache/CacheCleanupService.js';
import type { PrismaClient } from '@prisma/client';

// Mock PrismaClient
const mockPrismaClient = {
    agentResultCache: {
        deleteMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        groupBy: jest.fn(),
    },
} as unknown as PrismaClient;

describe('CacheCleanupService', () => {
    let cleanup: CacheCleanupService;

    beforeEach(() => {
        cleanup = new CacheCleanupService(mockPrismaClient);
        jest.clearAllMocks();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('should create CacheCleanupService instance', () => {
            expect(cleanup).toBeInstanceOf(CacheCleanupService);
        });

        it('should initialize with service not running', () => {
            expect(cleanup.isActive()).toBe(false);
        });
    });

    describe('cleanup', () => {
        it('should remove expired cache entries', async () => {
            (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mockResolvedValue({ count: 5 });

            const result = await cleanup.cleanup();

            expect(result).toBe(5);
            expect(mockPrismaClient.agentResultCache.deleteMany).toHaveBeenCalledWith({
                where: {
                    expiresAt: { lt: expect.any(Date) }
                }
            });
        });

        it('should return 0 when no expired entries exist', async () => {
            (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

            const result = await cleanup.cleanup();

            expect(result).toBe(0);
        });

        it('should handle database errors gracefully', async () => {
            (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mockRejectedValue(
                new Error('Database deletion failed')
            );

            const result = await cleanup.cleanup();

            expect(result).toBe(0);
        });
    });

    describe('getStats', () => {
        it('should return comprehensive cache statistics', async () => {
            const mockStats = {
                totalCount: 100,
                expiredCount: 15,
                oldestEntry: { createdAt: new Date('2024-01-01T00:00:00Z') },
                newestEntry: { createdAt: new Date('2024-01-02T00:00:00Z') },
                agentStats: [
                    { agentName: 'llm-agent', _count: { id: 45 } },
                    { agentName: 'data-agent', _count: { id: 30 } },
                    { agentName: 'calc-agent', _count: { id: 25 } },
                ]
            };

            // Mock all the parallel queries
            (mockPrismaClient.agentResultCache.count as jest.Mock)
                .mockResolvedValueOnce(mockStats.totalCount) // Total count
                .mockResolvedValueOnce(mockStats.expiredCount); // Expired count

            (mockPrismaClient.agentResultCache.findFirst as jest.Mock)
                .mockResolvedValueOnce(mockStats.oldestEntry) // Oldest entry
                .mockResolvedValueOnce(mockStats.newestEntry); // Newest entry

            (mockPrismaClient.agentResultCache.groupBy as jest.Mock)
                .mockResolvedValue(mockStats.agentStats);

            const result = await cleanup.getStats();

            const expectedStats: CacheStats = {
                totalEntries: 100,
                expiredEntries: 15,
                activeEntries: 85,
                oldestEntry: new Date('2024-01-01T00:00:00Z'),
                newestEntry: new Date('2024-01-02T00:00:00Z'),
                agentBreakdown: {
                    'llm-agent': 45,
                    'data-agent': 30,
                    'calc-agent': 25,
                }
            };

            expect(result).toEqual(expectedStats);
        });

        it('should handle empty cache gracefully', async () => {
            (mockPrismaClient.agentResultCache.count as jest.Mock)
                .mockResolvedValueOnce(0) // Total count
                .mockResolvedValueOnce(0); // Expired count

            (mockPrismaClient.agentResultCache.findFirst as jest.Mock)
                .mockResolvedValueOnce(null) // Oldest entry
                .mockResolvedValueOnce(null); // Newest entry

            (mockPrismaClient.agentResultCache.groupBy as jest.Mock)
                .mockResolvedValue([]);

            const result = await cleanup.getStats();

            expect(result).toEqual({
                totalEntries: 0,
                expiredEntries: 0,
                activeEntries: 0,
                oldestEntry: null,
                newestEntry: null,
                agentBreakdown: {}
            });
        });

        it('should handle database errors gracefully', async () => {
            (mockPrismaClient.agentResultCache.count as jest.Mock).mockRejectedValue(
                new Error('Database query failed')
            );

            const result = await cleanup.getStats();

            expect(result).toEqual({
                totalEntries: 0,
                expiredEntries: 0,
                activeEntries: 0,
                oldestEntry: null,
                newestEntry: null,
                agentBreakdown: {}
            });
        });
    });

    describe('start and stop', () => {
        it('should start background cleanup', async () => {
            const intervalMinutes = 5;
            (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mockResolvedValue({ count: 3 });

            cleanup.start(intervalMinutes);

            expect(cleanup.isActive()).toBe(true);

            // Fast-forward past the initial cleanup
            await jest.runOnlyPendingTimersAsync();

            // Allow for initial cleanup call(s)
            expect(mockPrismaClient.agentResultCache.deleteMany).toHaveBeenCalled();
            const initialCallCount = (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mock.calls.length;

            // Fast-forward 5 minutes to trigger periodic cleanup
            jest.advanceTimersByTime(5 * 60 * 1000);
            await jest.runOnlyPendingTimersAsync();

            // Should have at least one more call after the interval
            expect(mockPrismaClient.agentResultCache.deleteMany).toHaveBeenCalledTimes(initialCallCount + 1);

            cleanup.stop();
        });

        it('should stop background cleanup', () => {
            cleanup.start(5);
            expect(cleanup.isActive()).toBe(true);

            cleanup.stop();
            expect(cleanup.isActive()).toBe(false);

            // Advance timers - no additional cleanup should occur
            jest.advanceTimersByTime(10 * 60 * 1000);
            expect(mockPrismaClient.agentResultCache.deleteMany).toHaveBeenCalledTimes(1); // Only initial cleanup
        });

        it('should not start multiple intervals', async () => {
            const intervalMinutes = 2;
            (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

            cleanup.start(intervalMinutes);
            cleanup.start(intervalMinutes); // Should warn and not create duplicate interval

            expect(cleanup.isActive()).toBe(true);

            // Fast-forward past initial cleanup
            await jest.runOnlyPendingTimersAsync();

            const callCountAfterStart = (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mock.calls.length;

            // Should only have one interval running
            jest.advanceTimersByTime(2 * 60 * 1000);
            await jest.runOnlyPendingTimersAsync();

            // Should have exactly one more call (not double due to duplicate intervals)
            const finalCallCount = (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mock.calls.length;
            expect(finalCallCount).toBe(callCountAfterStart + 1);

            cleanup.stop();
        });

        it('should use default interval when none specified', async () => {
            (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });

            cleanup.start(); // No interval specified, should use default (5 minutes)

            expect(cleanup.isActive()).toBe(true);

            // Fast-forward past initial cleanup
            await jest.runOnlyPendingTimersAsync();

            const initialCallCount = (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mock.calls.length;
            expect(initialCallCount).toBeGreaterThan(0);

            // Fast-forward default interval (5 minutes)
            jest.advanceTimersByTime(5 * 60 * 1000);
            await jest.runOnlyPendingTimersAsync();

            const finalCallCount = (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mock.calls.length;
            expect(finalCallCount).toBe(initialCallCount + 1);

            cleanup.stop();
        });

        it('should handle cleanup errors in background', async () => {
            (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mockRejectedValue(
                new Error('Background cleanup failed')
            );

            cleanup.start(1);
            expect(cleanup.isActive()).toBe(true);

            // Fast-forward and allow error to occur
            await jest.runOnlyPendingTimersAsync();

            // Service should still be running despite error
            expect(cleanup.isActive()).toBe(true);

            cleanup.stop();
        });
    });

    describe('clearTenantCache', () => {
        it('should clear all cache entries for specific tenant', async () => {
            const tenantId = 'tenant-123';
            (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mockResolvedValue({ count: 12 });

            const result = await cleanup.clearTenantCache(tenantId);

            expect(result).toBe(12);
            expect(mockPrismaClient.agentResultCache.deleteMany).toHaveBeenCalledWith({
                where: { tenantId }
            });
        });

        it('should handle database errors gracefully', async () => {
            const tenantId = 'tenant-456';
            (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mockRejectedValue(
                new Error('Database deletion failed')
            );

            const result = await cleanup.clearTenantCache(tenantId);

            expect(result).toBe(0);
        });
    });

    describe('clearAgentCache', () => {
        it('should clear all cache entries for specific agent', async () => {
            const agentName = 'llm-agent';
            (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mockResolvedValue({ count: 25 });

            const result = await cleanup.clearAgentCache(agentName);

            expect(result).toBe(25);
            expect(mockPrismaClient.agentResultCache.deleteMany).toHaveBeenCalledWith({
                where: { agentName }
            });
        });

        it('should handle database errors gracefully', async () => {
            const agentName = 'data-agent';
            (mockPrismaClient.agentResultCache.deleteMany as jest.Mock).mockRejectedValue(
                new Error('Database deletion failed')
            );

            const result = await cleanup.clearAgentCache(agentName);

            expect(result).toBe(0);
        });
    });

    describe('isActive', () => {
        it('should return false when service is not running', () => {
            expect(cleanup.isActive()).toBe(false);
        });

        it('should return true when service is running', () => {
            cleanup.start(5);
            expect(cleanup.isActive()).toBe(true);
            cleanup.stop();
        });

        it('should return false after service is stopped', () => {
            cleanup.start(5);
            expect(cleanup.isActive()).toBe(true);

            cleanup.stop();
            expect(cleanup.isActive()).toBe(false);
        });
    });
}); 
import type { PrismaClient } from '@prisma/client';
import { logger } from '@callagent/utils';

/**
 * Cache Cleanup Service
 * 
 * Provides background cleanup of expired cache entries with:
 * - Automatic periodic cleanup
 * - Manual cleanup on demand
 * - Statistics and monitoring
 */
export class CacheCleanupService {
    private logger = logger.createLogger({ prefix: 'CacheCleanup' });
    private intervalId?: NodeJS.Timeout;
    private isRunning = false;

    constructor(private prisma: PrismaClient) { }

    /**
     * Remove all expired cache entries
     */
    async cleanup(): Promise<number> {
        try {
            const now = new Date();
            const result = await this.prisma.agentResultCache.deleteMany({
                where: {
                    expiresAt: { lt: now }
                }
            });

            if (result.count > 0) {
                this.logger.info(`Removed ${result.count} expired cache entries`);
            } else {
                this.logger.debug('No expired cache entries to remove');
            }

            return result.count;
        } catch (error) {
            this.logger.error('Cache cleanup failed', error);
            return 0;
        }
    }

    /**
     * Get cache statistics
     */
    async getStats(): Promise<CacheStats> {
        try {
            const now = new Date();

            const [totalCount, expiredCount, oldestEntry, newestEntry, agentStats] = await Promise.all([
                // Total cache entries
                this.prisma.agentResultCache.count(),

                // Expired entries count
                this.prisma.agentResultCache.count({
                    where: { expiresAt: { lt: now } }
                }),

                // Oldest entry
                this.prisma.agentResultCache.findFirst({
                    orderBy: { createdAt: 'asc' }
                }),

                // Newest entry
                this.prisma.agentResultCache.findFirst({
                    orderBy: { createdAt: 'desc' }
                }),

                // Per-agent statistics
                this.prisma.agentResultCache.groupBy({
                    by: ['agentName'],
                    _count: { id: true }
                })
            ]);

            const stats: CacheStats = {
                totalEntries: totalCount,
                expiredEntries: expiredCount,
                activeEntries: totalCount - expiredCount,
                oldestEntry: oldestEntry?.createdAt || null,
                newestEntry: newestEntry?.createdAt || null,
                agentBreakdown: agentStats.reduce((acc, stat) => {
                    acc[stat.agentName] = stat._count.id;
                    return acc;
                }, {} as Record<string, number>)
            };

            return stats;
        } catch (error) {
            this.logger.error('Failed to get cache statistics', error);
            return {
                totalEntries: 0,
                expiredEntries: 0,
                activeEntries: 0,
                oldestEntry: null,
                newestEntry: null,
                agentBreakdown: {}
            };
        }
    }

    /**
     * Start background cleanup with specified interval
     */
    start(intervalMinutes: number = 5): void {
        if (this.isRunning) {
            this.logger.warn('Cache cleanup service is already running');
            return;
        }

        this.stop(); // Ensure no multiple intervals
        this.isRunning = true;

        this.logger.info(`Starting background cache cleanup every ${intervalMinutes} minutes`);

        // Run initial cleanup
        this.cleanup().catch(error => {
            this.logger.error('Initial cache cleanup failed', error);
        });

        // Schedule periodic cleanup
        this.intervalId = setInterval(() => {
            this.cleanup().catch(error => {
                this.logger.error('Scheduled cache cleanup failed', error);
            });
        }, intervalMinutes * 60 * 1000);
    }

    /**
     * Stop background cleanup
     */
    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }

        this.isRunning = false;
        this.logger.info('Stopped background cache cleanup');
    }

    /**
     * Check if cleanup service is running
     */
    isActive(): boolean {
        return this.isRunning;
    }

    /**
     * Clear all cache entries for a specific tenant
     */
    async clearTenantCache(tenantId: string): Promise<number> {
        try {
            const result = await this.prisma.agentResultCache.deleteMany({
                where: { tenantId }
            });

            this.logger.info(`Cleared ${result.count} cache entries for tenant ${tenantId}`);
            return result.count;
        } catch (error) {
            this.logger.error(`Failed to clear cache for tenant ${tenantId}`, error);
            return 0;
        }
    }

    /**
     * Clear all cache entries for a specific agent across all tenants
     */
    async clearAgentCache(agentName: string): Promise<number> {
        try {
            const result = await this.prisma.agentResultCache.deleteMany({
                where: { agentName }
            });

            this.logger.info(`Cleared ${result.count} cache entries for agent ${agentName}`);
            return result.count;
        } catch (error) {
            this.logger.error(`Failed to clear cache for agent ${agentName}`, error);
            return 0;
        }
    }
}

/**
 * Cache statistics interface
 */
export interface CacheStats {
    totalEntries: number;
    expiredEntries: number;
    activeEntries: number;
    oldestEntry: Date | null;
    newestEntry: Date | null;
    agentBreakdown: Record<string, number>;
} 
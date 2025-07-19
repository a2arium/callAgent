import type { PrismaClient } from '@prisma/client';
/**
 * Cache Cleanup Service
 *
 * Provides background cleanup of expired cache entries with:
 * - Automatic periodic cleanup
 * - Manual cleanup on demand
 * - Statistics and monitoring
 */
export declare class CacheCleanupService {
    private prisma;
    private logger;
    private intervalId?;
    private isRunning;
    constructor(prisma: PrismaClient);
    /**
     * Remove all expired cache entries
     */
    cleanup(): Promise<number>;
    /**
     * Get cache statistics
     */
    getStats(): Promise<CacheStats>;
    /**
     * Start background cleanup with specified interval
     */
    start(intervalMinutes?: number): void;
    /**
     * Stop background cleanup
     */
    stop(): void;
    /**
     * Check if cleanup service is running
     */
    isActive(): boolean;
    /**
     * Clear all cache entries for a specific tenant
     */
    clearTenantCache(tenantId: string): Promise<number>;
    /**
     * Clear all cache entries for a specific agent across all tenants
     */
    clearAgentCache(agentName: string): Promise<number>;
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

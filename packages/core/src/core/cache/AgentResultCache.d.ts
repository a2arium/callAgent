import type { PrismaClient } from '@prisma/client';
import type { TaskInput } from '../../shared/types/index.js';
/**
 * Agent Result Cache Service
 *
 * Provides caching for agent execution results with:
 * - Robust cache key generation using sorted object hashing
 * - Path-based field exclusion for cache keys
 * - TTL-based expiration
 * - Tenant isolation
 */
export declare class AgentResultCache {
    private prisma;
    private logger;
    constructor(prisma: PrismaClient);
    /**
     * Get cached result for an agent execution
     */
    getCachedResult<T>(agentName: string, input: TaskInput, excludePaths: string[] | undefined, tenantId: string): Promise<T | null>;
    /**
     * Set cached result for an agent execution
     */
    setCachedResult<T>(agentName: string, input: TaskInput, result: T, ttlSeconds: number, excludePaths: string[] | undefined, tenantId: string): Promise<void>;
    /**
     * Clear all cached results for a specific agent
     */
    clearAgentCache(agentName: string, tenantId?: string): Promise<number>;
    /**
     * Generate a consistent cache key from input, excluding specified paths
     */
    private generateCacheKey;
    /**
     * Remove excluded paths from input object using dot notation
     */
    private removeExcludedPaths;
    /**
     * Delete a path from an object using dot notation
     */
    private deletePath;
    /**
     * Recursively sort object keys for consistent serialization
     */
    private sortObjectKeys;
}

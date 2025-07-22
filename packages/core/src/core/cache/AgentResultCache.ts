import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { TaskInput } from '../../shared/types/index.js';
import { logger } from '@a2arium/callagent-utils';

/**
 * Agent Result Cache Service
 * 
 * Provides caching for agent execution results with:
 * - Robust cache key generation using sorted object hashing
 * - Path-based field exclusion for cache keys
 * - TTL-based expiration
 * - Tenant isolation
 */
export class AgentResultCache {
    private logger = logger.createLogger({ prefix: 'AgentCache' });

    constructor(private prisma: PrismaClient) { }

    /**
     * Get cached result for an agent execution
     */
    async getCachedResult<T>(
        agentName: string,
        input: TaskInput,
        excludePaths: string[] = [],
        tenantId: string
    ): Promise<T | null> {
        const cacheKey = this.generateCacheKey(input, excludePaths);

        try {
            const cached = await this.prisma.agentResultCache.findUnique({
                where: {
                    tenantId_agentName_cacheKey: {
                        tenantId,
                        agentName,
                        cacheKey,
                    }
                }
            });

            // Check if cache entry exists and is not expired
            if (cached && cached.expiresAt > new Date()) {
                this.logger.info(`Cache hit for agent ${agentName}`, {
                    tenantId,
                    cacheKey: cacheKey.substring(0, 16) + '...',
                    ageSeconds: Math.round((Date.now() - cached.createdAt.getTime()) / 1000)
                });
                return cached.result as T;
            } else if (cached && cached.expiresAt <= new Date()) {
                // Remove expired entry
                await this.prisma.agentResultCache.delete({
                    where: { id: cached.id }
                });
                this.logger.debug(`Removed expired cache entry for agent ${agentName}`, { tenantId });
            }

            this.logger.debug(`Cache miss for agent ${agentName}`, { tenantId, cacheKey: cacheKey.substring(0, 16) + '...' });
            return null;
        } catch (error) {
            this.logger.error(`Error getting cached result for agent ${agentName}`, error, { tenantId });
            return null;
        }
    }

    /**
     * Set cached result for an agent execution
     */
    async setCachedResult<T>(
        agentName: string,
        input: TaskInput,
        result: T,
        ttlSeconds: number,
        excludePaths: string[] = [],
        tenantId: string
    ): Promise<void> {
        const cacheKey = this.generateCacheKey(input, excludePaths);
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

        try {
            await this.prisma.agentResultCache.upsert({
                where: {
                    tenantId_agentName_cacheKey: { tenantId, agentName, cacheKey }
                },
                update: {
                    result: result as any,
                    expiresAt,
                    createdAt: new Date() // Update creation time on upsert
                },
                create: {
                    tenantId,
                    agentName,
                    cacheKey,
                    result: result as any,
                    expiresAt
                }
            });

            this.logger.info(`Result cached for agent ${agentName}`, {
                tenantId,
                cacheKey: cacheKey.substring(0, 16) + '...',
                ttlSeconds
            });
        } catch (error) {
            this.logger.error(`Error setting cached result for agent ${agentName}`, error, { tenantId });
        }
    }

    /**
     * Clear all cached results for a specific agent
     */
    async clearAgentCache(agentName: string, tenantId?: string): Promise<number> {
        try {
            const whereClause = tenantId
                ? { agentName, tenantId }
                : { agentName };

            const result = await this.prisma.agentResultCache.deleteMany({
                where: whereClause
            });

            this.logger.info(`Cleared ${result.count} cache entries for agent ${agentName}`, { tenantId });
            return result.count;
        } catch (error) {
            this.logger.error(`Error clearing cache for agent ${agentName}`, error, { tenantId });
            return 0;
        }
    }

    /**
     * Generate a consistent cache key from input, excluding specified paths
     */
    private generateCacheKey(input: TaskInput, excludePaths: string[]): string {
        // Deep clone the input to avoid modifying the original
        const filteredInput = this.removeExcludedPaths(JSON.parse(JSON.stringify(input)), excludePaths);

        // Sort object keys recursively for consistent hashing
        const sortedInput = this.sortObjectKeys(filteredInput);

        // Generate SHA-256 hash
        return crypto.createHash('sha256')
            .update(JSON.stringify(sortedInput))
            .digest('hex');
    }

    /**
     * Remove excluded paths from input object using dot notation
     */
    private removeExcludedPaths(obj: any, paths: string[]): any {
        for (const path of paths) {
            this.deletePath(obj, path);
        }
        return obj;
    }

    /**
     * Delete a path from an object using dot notation
     */
    private deletePath(obj: any, path: string): void {
        const keys = path.split('.');
        let current = obj;

        // Navigate to the parent of the target key
        for (let i = 0; i < keys.length - 1; i++) {
            if (current === null || current === undefined || typeof current !== 'object') {
                return; // Path doesn't exist
            }
            current = current[keys[i]];
        }

        // Delete the target key if parent exists
        if (current && typeof current === 'object') {
            delete current[keys[keys.length - 1]];
        }
    }

    /**
     * Recursively sort object keys for consistent serialization
     */
    private sortObjectKeys(obj: any): any {
        if (obj === null || obj === undefined || typeof obj !== 'object') {
            return obj;
        }

        if (Array.isArray(obj)) {
            return obj.map(item => this.sortObjectKeys(item));
        }

        return Object.keys(obj)
            .sort()
            .reduce((result, key) => {
                result[key] = this.sortObjectKeys(obj[key]);
                return result;
            }, {} as any);
    }
} 
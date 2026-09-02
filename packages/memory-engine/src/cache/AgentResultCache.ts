import crypto from 'crypto';
import { PrismaClient } from '@a2arium/callagent-memory-sql/generated';
import type { PrismaClient as PrismaClientType } from '@a2arium/callagent-memory-sql/generated';
import type { TaskInput } from '../shared/types/index.js';
import { logger } from '@a2arium/callagent-utils';

export class ArtifactPublicationConflictError extends Error {
    readonly code = 'ARTIFACT_PUBLICATION_CONFLICT';

    constructor(public readonly artifactId: string) {
        super(`ARTIFACT_PUBLICATION_CONFLICT: artifact ${artifactId} was already published with different content`);
        this.name = 'ArtifactPublicationConflictError';
        Object.setPrototypeOf(this, ArtifactPublicationConflictError.prototype);
    }
}

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

    constructor(private prisma: PrismaClientType | any) { }

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
                if (agentName === 'artifact_store') {
                    const retained = await this.prisma.artifactReference.count({
                        where: { cacheEntryId: cached.id },
                    });
                    if (retained > 0) return cached.result as T;
                }
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
     * Store a raw artifact directly.
     * Used by ArtifactImpl and offloadArtifacts to store large blobs.
     */
    async storeArtifact(
        tenantId: string,
        artifactId: string | undefined,
        value: unknown,
        mimeType?: string
    ): Promise<{ size: number; artifactId: string }> {
        const id = artifactId || crypto.randomUUID();
        // We use the virtual agent 'artifact_store' and cacheKey = artifactId
        // This reuses the existing table structure without changes.
        const size = JSON.stringify(value).length;
        const agentName = 'artifact_store';
        const cacheKey = this.generateCacheKey({ artifactId: id }, []);
        const expiresAt = new Date(Date.now() + 86400 * 30 * 1000);

        // Artifact publication is not a best-effort cache write. Returning an ID
        // after a rejected write creates an unusable durable marker, so propagate
        // the storage error to the persistence boundary.
        await this.prisma.agentResultCache.upsert({
            where: {
                tenantId_agentName_cacheKey: { tenantId, agentName, cacheKey }
            },
            update: {
                result: value as any,
                expiresAt,
                createdAt: new Date()
            },
            create: {
                tenantId,
                agentName,
                cacheKey,
                result: value as any,
                expiresAt
            },
            // Artifact payloads can be several MiB. Prisma otherwise returns
            // and JSON-parses the complete JSONB value after every upsert even
            // though this path only needs durable-write confirmation.
            select: { id: true },
        });

        return { size, artifactId: id };
    }

    /**
     * Publishes an immutable local artifact. Repeated publication of identical
     * cloned content reuses the row; conflicting content fails closed.
     */
    async publishArtifact(
        tenantId: string,
        artifactId: string,
        value: unknown,
        _mimeType?: string
    ): Promise<{ size: number; artifactId: string }> {
        const size = JSON.stringify(value).length;
        const agentName = 'artifact_store';
        const cacheKey = this.generateCacheKey({ artifactId }, []);
        const expiresAt = new Date(Date.now() + 86400 * 30 * 1000);
        const stored = await this.prisma.agentResultCache.upsert({
            where: {
                tenantId_agentName_cacheKey: { tenantId, agentName, cacheKey }
            },
            update: { expiresAt },
            create: {
                tenantId,
                agentName,
                cacheKey,
                result: value as any,
                expiresAt
            }
        });
        if (!this.jsonValuesEqual(stored.result, value)) {
            throw new ArtifactPublicationConflictError(artifactId);
        }
        return { size, artifactId };
    }

    /**
     * Load a raw artifact directly.
     */
    async loadArtifact<T>(tenantId: string, artifactId: string): Promise<T> {
        const result = await this.getCachedResult<T>(
            'artifact_store',
            { artifactId },
            [],
            tenantId
        );
        if (result === null) {
            throw new Error(`Artifact ${artifactId} not found`);
        }
        return result;
    }

    /** Protect one stored artifact while a durable checkpoint owner references it. */
    async retainArtifact(tenantId: string, artifactId: string, ownerId: string): Promise<void> {
        this.assertArtifactIdentity(artifactId, ownerId);
        const cacheKey = this.generateCacheKey({ artifactId }, []);
        await this.prisma.$transaction(async (tx: any) => {
            const entry = await tx.agentResultCache.findUnique({
                where: { tenantId_agentName_cacheKey: { tenantId, agentName: 'artifact_store', cacheKey } },
                select: { id: true },
            });
            if (!entry) throw new Error(`Artifact ${artifactId} not found`);
            await tx.artifactReference.upsert({
                where: { tenantId_artifactId_ownerId: { tenantId, artifactId, ownerId } },
                update: { cacheEntryId: entry.id },
                create: { tenantId, artifactId, ownerId, cacheEntryId: entry.id },
            });
        });
    }

    /**
     * Protect many stored artifacts under one owner without opening one
     * interactive transaction per artifact. All requested artifacts are
     * validated before the reference writes, and the batched writes commit in
     * one database transaction.
     */
    async retainArtifacts(tenantId: string, artifactIds: readonly string[], ownerId: string): Promise<number> {
        this.assertArtifactIdentity('bulk-retain', ownerId);
        const uniqueIds = [...new Set(artifactIds)];
        for (const artifactId of uniqueIds) this.assertArtifactIdentity(artifactId, ownerId);
        if (uniqueIds.length === 0) return 0;

        const batchSize = 1_000;
        const entries: Array<{ id: string; cacheKey: string }> = [];
        const idByCacheKey = new Map(uniqueIds.map((artifactId) => [
            this.generateCacheKey({ artifactId }, []),
            artifactId,
        ]));
        const cacheKeys = [...idByCacheKey.keys()];
        for (let offset = 0; offset < cacheKeys.length; offset += batchSize) {
            const page = await this.prisma.agentResultCache.findMany({
                where: {
                    tenantId,
                    agentName: 'artifact_store',
                    cacheKey: { in: cacheKeys.slice(offset, offset + batchSize) },
                },
                select: { id: true, cacheKey: true },
            });
            entries.push(...page);
        }

        const foundKeys = new Set(entries.map((entry) => entry.cacheKey));
        const missing = cacheKeys.find((cacheKey) => !foundKeys.has(cacheKey));
        if (missing) throw new Error(`Artifact ${idByCacheKey.get(missing)} not found`);

        const data = entries.map((entry) => ({
            tenantId,
            artifactId: idByCacheKey.get(entry.cacheKey)!,
            ownerId,
            cacheEntryId: entry.id,
        }));
        const writes = [];
        for (let offset = 0; offset < data.length; offset += batchSize) {
            writes.push(this.prisma.artifactReference.createMany({
                data: data.slice(offset, offset + batchSize),
                skipDuplicates: true,
            }));
        }
        await this.prisma.$transaction(writes);
        return uniqueIds.length;
    }

    /**
     * Copy an existing checkpoint owner's references to a successor owner in
     * one transaction. The artifact payloads are immutable, so successor
     * checkpoints can inherit their protection without loading every payload.
     */
    async inheritArtifactOwner(tenantId: string, fromOwnerId: string, toOwnerId: string, excludedArtifactIds: readonly string[] = []): Promise<readonly string[]> {
        this.assertArtifactIdentity('owner-inherit', fromOwnerId);
        this.assertArtifactIdentity('owner-inherit', toOwnerId);
        if (fromOwnerId === toOwnerId) {
            const existing: Array<{ artifactId: string }> = await this.prisma.artifactReference.findMany({
                where: { tenantId, ownerId: fromOwnerId },
                select: { artifactId: true },
            });
            return existing.map((reference) => reference.artifactId);
        }
        const excluded = [...new Set(excludedArtifactIds)];
        for (const artifactId of excluded) this.assertArtifactIdentity(artifactId, toOwnerId);
        return this.prisma.$transaction(async (tx: any) => {
            const existing: Array<{ artifactId: string; cacheEntryId: string }> = await tx.artifactReference.findMany({
                where: { tenantId, ownerId: fromOwnerId, ...(excluded.length ? { artifactId: { notIn: excluded } } : {}) },
                select: { artifactId: true, cacheEntryId: true },
            });
            if (existing.length) {
                await tx.artifactReference.createMany({
                    data: existing.map((reference) => ({ tenantId, artifactId: reference.artifactId, ownerId: toOwnerId, cacheEntryId: reference.cacheEntryId })),
                    skipDuplicates: true,
                });
            }
            return existing.map((reference) => reference.artifactId);
        });
    }

    /** Release exactly one owner; other owners continue to protect the artifact. */
    async releaseArtifact(tenantId: string, artifactId: string, ownerId: string): Promise<void> {
        this.assertArtifactIdentity(artifactId, ownerId);
        await this.prisma.artifactReference.deleteMany({ where: { tenantId, artifactId, ownerId } });
    }

    /** Release every artifact held by a terminal checkpoint owner. Idempotent. */
    async releaseArtifactOwner(tenantId: string, ownerId: string): Promise<number> {
        this.assertArtifactIdentity('owner-release', ownerId);
        const result = await this.prisma.artifactReference.deleteMany({ where: { tenantId, ownerId } });
        return result.count;
    }

    /** Delete an artifact only when no durable owner still references it. */
    async deleteArtifact(tenantId: string, artifactId: string): Promise<boolean> {
        this.assertArtifactIdentity(artifactId);
        const cacheKey = this.generateCacheKey({ artifactId }, []);
        return this.prisma.$transaction(async (tx: any) => {
            const entry = await tx.agentResultCache.findUnique({
                where: { tenantId_agentName_cacheKey: { tenantId, agentName: 'artifact_store', cacheKey } },
                select: { id: true },
            });
            if (!entry) return true;
            const retained = await tx.artifactReference.count({ where: { cacheEntryId: entry.id } });
            if (retained > 0) return false;
            await tx.agentResultCache.delete({ where: { id: entry.id } });
            return true;
        }, { isolationLevel: 'Serializable' });
    }

    private assertArtifactIdentity(artifactId: string, ownerId?: string): void {
        if (!artifactId || artifactId !== artifactId.trim()) throw new Error('Artifact ID is invalid');
        if (ownerId !== undefined && (!ownerId || ownerId !== ownerId.trim() || ownerId.length > 512)) {
            throw new Error('Artifact retention owner ID is invalid');
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

    private jsonValuesEqual(left: unknown, right: unknown): boolean {
        const normalize = (value: unknown) => {
            const serialized = JSON.stringify(value);
            return serialized === undefined ? undefined : this.sortObjectKeys(JSON.parse(serialized));
        };
        return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
    }
}

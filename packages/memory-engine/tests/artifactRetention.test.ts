import { describe, expect, it, jest } from '@jest/globals';
import { AgentResultCache } from '../src/cache/AgentResultCache.js';
import { CacheCleanupService } from '../src/cache/CacheCleanupService.js';

describe('durable artifact references', () => {
    it('stores artifacts through scalar SQL instead of the retaining Prisma JSON model path', async () => {
        const executeRaw = jest.fn(async () => 1);
        const upsert = jest.fn();
        const cache = new AgentResultCache({ $executeRaw: executeRaw, agentResultCache: { upsert } } as any);

        await cache.storeArtifact('tenant', 'artifact-1', 'large-value', 'application/json');
        expect(executeRaw).toHaveBeenCalledTimes(1);
        expect(upsert).not.toHaveBeenCalled();
        const [sql, ...parameters] = executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
        expect(sql.join('?')).toContain('INSERT INTO agent_result_cache');
        expect(sql.join('?')).toContain('ON CONFLICT (tenant_id, agent_name, cache_key)');
        expect(parameters).toEqual(expect.arrayContaining(['artifact-1', 'tenant', 'artifact_store', '"large-value"']));
    });
    it('retains a large artifact set with one atomic batched write phase', async () => {
        const createMany = jest.fn(async () => ({ count: 0 }));
        const prisma = {
            agentResultCache: {
                findMany: jest.fn(async ({ where }: any) => where.cacheKey.in.map((cacheKey: string, index: number) => ({
                    id: `cache-${index}-${cacheKey}`,
                    cacheKey,
                }))),
            },
            artifactReference: { createMany },
            $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
        };
        const cache = new AgentResultCache(prisma as any);
        const artifactIds = Array.from({ length: 2_501 }, (_, index) => `artifact-${index}`);

        await expect(cache.retainArtifacts('tenant', [...artifactIds, artifactIds[0]], 'checkpoint:cig')).resolves.toBe(2_501);
        expect(prisma.agentResultCache.findMany).toHaveBeenCalledTimes(3);
        expect(createMany).toHaveBeenCalledTimes(3);
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(createMany.mock.calls.flatMap(([input]: any[]) => input.data)).toHaveLength(2_501);
    });

    it('writes no references when bulk retention finds a missing artifact', async () => {
        const createMany = jest.fn();
        const prisma = {
            agentResultCache: { findMany: jest.fn(async () => []) },
            artifactReference: { createMany },
            $transaction: jest.fn(),
        };
        const cache = new AgentResultCache(prisma as any);

        await expect(cache.retainArtifacts('tenant', ['missing'], 'checkpoint:cig')).rejects.toThrow('Artifact missing not found');
        expect(createMany).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('inherits a predecessor owner without loading artifact payloads', async () => {
        const references = [
            { artifactId: 'artifact-1', cacheEntryId: 'cache-1' },
            { artifactId: 'artifact-2', cacheEntryId: 'cache-2' },
        ];
        const tx = {
            artifactReference: {
                findMany: jest.fn(async () => references),
                createMany: jest.fn(async () => ({ count: 2 })),
            },
        };
        const prisma = { $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) };
        const cache = new AgentResultCache(prisma as any);

        await expect(cache.inheritArtifactOwner('tenant', 'checkpoint:old', 'checkpoint:new')).resolves.toEqual(['artifact-1', 'artifact-2']);
        expect(tx.artifactReference.findMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant', ownerId: 'checkpoint:old' },
            select: { artifactId: true, cacheEntryId: true },
        });
        expect(tx.artifactReference.createMany).toHaveBeenCalledWith({
            data: references.map((reference) => ({ tenantId: 'tenant', artifactId: reference.artifactId, ownerId: 'checkpoint:new', cacheEntryId: reference.cacheEntryId })),
            skipDuplicates: true,
        });
    });

    it('retains idempotently and refuses deletion while referenced', async () => {
        const entry = { id: 'cache-1' };
        const tx = {
            agentResultCache: {
                findUnique: jest.fn(async () => entry),
                delete: jest.fn(async () => entry),
            },
            artifactReference: {
                upsert: jest.fn(async () => ({})),
                count: jest.fn(async () => 1),
            },
        };
        const prisma = {
            $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
            artifactReference: { deleteMany: jest.fn(async () => ({ count: 1 })) },
        };
        const cache = new AgentResultCache(prisma as any);

        await cache.retainArtifact('tenant', 'artifact-1', 'checkpoint:cig:2022');
        await expect(cache.deleteArtifact('tenant', 'artifact-1')).resolves.toBe(false);
        expect(tx.artifactReference.upsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { tenantId_artifactId_ownerId: {
                tenantId: 'tenant', artifactId: 'artifact-1', ownerId: 'checkpoint:cig:2022',
            } },
        }));
        expect(tx.agentResultCache.delete).not.toHaveBeenCalled();
    });

    it('releases one owner and deletes an unreferenced artifact', async () => {
        const tx = {
            agentResultCache: {
                findUnique: jest.fn(async () => ({ id: 'cache-1' })),
                delete: jest.fn(async () => ({ id: 'cache-1' })),
            },
            artifactReference: { count: jest.fn(async () => 0) },
        };
        const prisma = {
            $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
            artifactReference: { deleteMany: jest.fn(async () => ({ count: 1 })) },
        };
        const cache = new AgentResultCache(prisma as any);

        await cache.releaseArtifact('tenant', 'artifact-1', 'checkpoint:cig:2022');
        await expect(cache.deleteArtifact('tenant', 'artifact-1')).resolves.toBe(true);
        expect(prisma.artifactReference.deleteMany).toHaveBeenCalledWith({ where: {
            tenantId: 'tenant', artifactId: 'artifact-1', ownerId: 'checkpoint:cig:2022',
        } });
        expect(tx.agentResultCache.delete).toHaveBeenCalledWith({ where: { id: 'cache-1' } });
    });

    it('releases an owner and atomically deletes only payloads with no remaining owner', async () => {
        let calls = 0;
        const tx = {
            artifactReference: {
                findMany: jest.fn(async () => calls === 0 ? [{ cacheEntryId: 'cache-stale' }, { cacheEntryId: 'cache-shared' }] : []),
                deleteMany: jest.fn(async () => ({ count: calls++ === 0 ? 2 : 0 })),
            },
            agentResultCache: { deleteMany: jest.fn(async () => ({ count: 1 })) },
        };
        const prisma = { $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) };
        const cache = new AgentResultCache(prisma as any);
        await expect(cache.releaseArtifactOwner('tenant', 'checkpoint:cig:active')).resolves.toBe(2);
        await expect(cache.releaseArtifactOwner('tenant', 'checkpoint:cig:active')).resolves.toBe(0);
        expect(tx.artifactReference.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant', ownerId: 'checkpoint:cig:active' } });
        expect(tx.agentResultCache.deleteMany).toHaveBeenCalledWith({ where: {
            id: { in: ['cache-stale', 'cache-shared'] },
            artifactReferences: { none: {} },
        } });
    });

    it('loads an expired artifact while a durable owner retains it', async () => {
        const prisma = {
            agentResultCache: {
                findUnique: jest.fn(async () => ({
                    id: 'cache-1', result: { value: 1 }, expiresAt: new Date(0), createdAt: new Date(0),
                })),
                delete: jest.fn(),
            },
            artifactReference: { count: jest.fn(async () => 1) },
        };
        const cache = new AgentResultCache(prisma as any);
        await expect(cache.loadArtifact('tenant', 'artifact-1')).resolves.toEqual({ value: 1 });
        expect(prisma.agentResultCache.delete).not.toHaveBeenCalled();
    });

    it('excludes retained artifacts from bounded expiry cleanup', async () => {
        const prisma = {
            agentResultCache: {
                findMany: jest.fn(async () => []),
                deleteMany: jest.fn(async () => ({ count: 0 })),
            },
        };
        const cleanup = new CacheCleanupService(prisma as any);
        await cleanup.cleanupExpired({ tenantId: 'tenant', batchSize: 10, now: new Date(0) });
        expect(prisma.agentResultCache.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ artifactReferences: { none: {} } }),
        }));
    });
});

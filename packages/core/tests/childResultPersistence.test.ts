import { describe, expect, it, jest } from '@jest/globals';
import {
    ArtifactPersistenceError,
    prepareChildResultForPersistence,
    prepareChildResultsInInboxForPersistence,
} from '../src/orchestration/childResultPersistence.js';

const createFakeArtifactPrisma = () => {
    const artifacts = new Map<string, unknown>();
    return {
        agentResultCache: {
            upsert: jest.fn(async (args: any) => {
                const cacheKey = args.where.tenantId_agentName_cacheKey.cacheKey;
                if (artifacts.has(cacheKey)) {
                    if (Object.prototype.hasOwnProperty.call(args.update, 'result')) {
                        artifacts.set(cacheKey, args.update.result);
                    }
                    return { ...args.create, result: artifacts.get(cacheKey) };
                }
                artifacts.set(cacheKey, args.create.result);
                return args.create;
            }),
            findUnique: jest.fn(async (args: any) => {
                const cacheKey = args.where?.tenantId_agentName_cacheKey?.cacheKey;
                if (!artifacts.has(cacheKey)) return null;
                return {
                    id: cacheKey,
                    result: artifacts.get(cacheKey),
                    createdAt: new Date(),
                    expiresAt: new Date(Date.now() + 60_000),
                };
            }),
            delete: jest.fn(async () => ({})),
        },
    };
};

describe('child result persistence preparation', () => {
    it('projects a hydrated ArtifactImpl without loading its content', async () => {
        const { ArtifactImpl } = await import('@a2arium/callagent-memory-engine');
        const cache = {
            getCachedResult: jest.fn(async () => '<html>must-not-load</html>'),
        };
        const handle = new ArtifactImpl('artifact-existing', cache as any, 'tenant-a', 'text/html', 1234);

        const prepared = await prepareChildResultForPersistence(
            { html: handle },
            undefined,
            'tenant-a'
        ) as any;

        expect(prepared.html).toEqual({
            kind: 'artifact',
            id: 'artifact-existing',
            mimeType: 'text/html',
            estimatedSize: 1234,
        });
        expect(cache.getCachedResult).not.toHaveBeenCalled();
        expect((prepared.html as any).then).toBeUndefined();
    });

    it('stores one LocalArtifact object once across one persistence operation', async () => {
        const { AgentResultCache, Artifact } = await import('@a2arium/callagent-memory-engine');
        const prisma = createFakeArtifactPrisma();
        const cache = new AgentResultCache(prisma as any);
        const artifact = Artifact.create(`<html>${'shared'.repeat(20_000)}</html>`, { mimeType: 'text/html' });

        const prepared = await prepareChildResultForPersistence(
            {
                mental: { html: artifact },
                inbox: { html: artifact },
                llm: { html: artifact },
                outcome: { html: artifact },
            },
            cache,
            'tenant-a'
        ) as any;

        const ids = [
            prepared.mental.html.id,
            prepared.inbox.html.id,
            prepared.llm.html.id,
            prepared.outcome.html.id,
        ];
        expect(new Set(ids)).toEqual(new Set([ids[0]]));
        expect(prisma.agentResultCache.upsert).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(prepared)).not.toContain('shared'.repeat(100));
    });

    it('keeps distinct LocalArtifact objects distinct', async () => {
        const { AgentResultCache, Artifact } = await import('@a2arium/callagent-memory-engine');
        const prisma = createFakeArtifactPrisma();
        const cache = new AgentResultCache(prisma as any);

        const prepared = await prepareChildResultForPersistence(
            {
                first: Artifact.create('first artifact'),
                second: Artifact.create('second artifact'),
            },
            cache,
            'tenant-a'
        ) as any;

        expect(prepared.first.id).not.toBe(prepared.second.id);
        expect(prisma.agentResultCache.upsert).toHaveBeenCalledTimes(2);
    });

    it('reuses one durable artifact id across separately cloned persistence payloads', async () => {
        const { AgentResultCache, Artifact } = await import('@a2arium/callagent-memory-engine');
        const prisma = createFakeArtifactPrisma();
        const cache = new AgentResultCache(prisma as any);
        const artifact = Artifact.create('<html>one publication</html>', { mimeType: 'text/html' });
        const cloned = JSON.parse(JSON.stringify(artifact));

        const first = await prepareChildResultForPersistence({ html: artifact }, cache, 'tenant-a') as any;
        const second = await prepareChildResultForPersistence({ html: cloned }, cache, 'tenant-a') as any;

        expect(artifact.publicationId).toBeTruthy();
        expect(cloned.publicationId).toBe(artifact.publicationId);
        expect(first.html.id).toBe(artifact.publicationId);
        expect(second.html.id).toBe(first.html.id);
        expect((prisma as any).agentResultCache.upsert).toHaveBeenCalledTimes(2);
    });

    it('fails closed when an immutable publication id is reused for different content', async () => {
        const { AgentResultCache } = await import('@a2arium/callagent-memory-engine');
        const cache = new AgentResultCache(createFakeArtifactPrisma() as any);

        await cache.publishArtifact('tenant-a', 'publication-1', { value: 'first' });
        await expect(cache.publishArtifact('tenant-a', 'publication-1', { value: 'changed' }))
            .rejects.toMatchObject({ code: 'ARTIFACT_PUBLICATION_CONFLICT' });
    });

    it('allows concurrent identical immutable publications to converge', async () => {
        const { AgentResultCache } = await import('@a2arium/callagent-memory-engine');
        const cache = new AgentResultCache(createFakeArtifactPrisma() as any);

        const results = await Promise.all([
            cache.publishArtifact('tenant-a', 'publication-1', { value: 'same' }),
            cache.publishArtifact('tenant-a', 'publication-1', { value: 'same' }),
        ]);

        expect(new Set(results.map((result) => result.artifactId))).toEqual(new Set(['publication-1']));
    });

    it('fails closed when a configured artifact backend rejects a write', async () => {
        const { AgentResultCache, Artifact } = await import('@a2arium/callagent-memory-engine');
        const prisma = createFakeArtifactPrisma();
        prisma.agentResultCache.upsert.mockRejectedValueOnce(new Error('store unavailable'));
        const artifact = Artifact.create('secret artifact content', { mimeType: 'text/plain' });

        await expect(prepareChildResultForPersistence(
            { artifact },
            new AgentResultCache(prisma as any),
            'tenant-a'
        )).rejects.toBeInstanceOf(ArtifactPersistenceError);
    });

    it('keeps no-backend local artifact previews bounded and non-thenable', async () => {
        const { Artifact } = await import('@a2arium/callagent-memory-engine');
        const raw = 'private-content-'.repeat(10_000);
        const prepared = await prepareChildResultForPersistence(
            { artifact: Artifact.create(raw) },
            undefined,
            'tenant-a'
        ) as any;

        expect(JSON.stringify(prepared)).not.toContain(raw);
        expect(prepared.artifact.then).toBeUndefined();
    });

    it('keeps large child result strings artifact-backed', async () => {
        const rawHtml = `<html>${'child-result-html'.repeat(5000)}</html>`;
        const { AgentResultCache } = await import('@a2arium/callagent-memory-engine');
        const prepared = await prepareChildResultForPersistence(
            { ok: true, data: { html: rawHtml, content: rawHtml } },
            new AgentResultCache(createFakeArtifactPrisma() as any),
            'tenant-a'
        ) as any;

        expect(JSON.stringify(prepared)).not.toContain(rawHtml);
        expect(prepared.data.html).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
        expect(prepared.data.content).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
    });

    it('normalizes raw child.completed results in inbox snapshots', async () => {
        const rawHtml = `<html>${'snapshot-child-html'.repeat(5000)}</html>`;
        const { AgentResultCache } = await import('@a2arium/callagent-memory-engine');
        const inbox = {
            current: [{
                source: 'child',
                kind: 'child.completed',
                payload: {
                    token: 'tok-1',
                    result: { ok: true, data: { html: rawHtml } },
                },
            } as any],
            all: [{
                source: 'child',
                kind: 'child.completed',
                payload: {
                    token: 'tok-1',
                    result: { ok: true, data: { content: rawHtml } },
                },
            } as any],
        };

        const prepared = await prepareChildResultsInInboxForPersistence(
            inbox,
            new AgentResultCache(createFakeArtifactPrisma() as any),
            'tenant-a'
        );

        const serialized = JSON.stringify(prepared);
        expect(serialized).not.toContain(rawHtml);
        expect((prepared.current[0] as any).payload.result.data.html).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
        expect((prepared.all[0] as any).payload.result.data.content).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
    });
});

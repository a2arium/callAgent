import { describe, expect, it, jest } from '@jest/globals';
import {
    prepareChildResultForPersistence,
    prepareChildResultsInInboxForPersistence,
} from '../src/orchestration/childResultPersistence.js';

const createFakeArtifactPrisma = () => {
    const artifacts = new Map<string, unknown>();
    return {
        agentResultCache: {
            upsert: jest.fn(async (args: any) => {
                artifacts.set(args.create.cacheKey, args.create.result);
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

import { describe, expect, it, jest } from '@jest/globals';
import { TaskExecutor } from '../src/orchestration/TaskExecutor.js';

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

describe('TaskExecutor snapshot persistence', () => {
    it('sanitizes raw child.completed payloads from merged inboxes before saving snapshots', async () => {
        const rawHtml = `<html>${'task-executor-child-html'.repeat(5000)}</html>`;
        const rawObservation = {
            source: 'child',
            kind: 'child.completed',
            payload: {
                token: 'tok-1',
                result: {
                    ok: true,
                    data: {
                        html: rawHtml,
                        content: rawHtml,
                    },
                },
            },
        };
        let savedSnapshot: Record<string, unknown> | undefined;
        const prisma = createFakeArtifactPrisma();
        const sessionManager = {
            prisma,
            load: jest.fn(async () => ({
                wmVersion: BigInt(3),
                snapshot: {
                    meta: { turn: 1, agentId: 'agent-a' },
                    inbox: {
                        current: [],
                        all: [rawObservation],
                    },
                },
            })),
            saveSnapshot: jest.fn(async (params: { snapshot: Record<string, unknown> }) => {
                savedSnapshot = params.snapshot;
                return { newVersion: BigInt(4) };
            }),
        };

        await (TaskExecutor as any).saveSnapshot({
            sessionManager,
            tenantId: 'tenant-a',
            sessionId: 'parent-1',
            agentId: 'agent-a',
            env: {
                turn: 2,
                pending: { children: {} },
                inbox: {
                    current: [rawObservation],
                    all: [rawObservation],
                },
            },
            M: {},
            mNext: {},
            outcome: { kind: 'complete', result: { ok: true } },
            loopOpts: {},
            ctx: {},
            getSessionStorePrisma: () => prisma,
        });

        const serialized = JSON.stringify(savedSnapshot);
        expect(serialized).not.toContain(rawHtml);
        const inbox = (savedSnapshot as any).inbox;
        const obs = inbox.all.find((entry: any) => entry?.payload?.token === 'tok-1');
        expect(obs?.payload?.result?.data?.html).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
        expect(obs?.payload?.result?.data?.content).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
    });
});

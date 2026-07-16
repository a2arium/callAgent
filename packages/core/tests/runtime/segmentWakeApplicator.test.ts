import { describe, it, expect, jest } from '@jest/globals';
import { applyWakeToSnapshot, prepareSegmentWake } from '../../src/runtime/segmentWakeApplicator.js';
import { InboxManager } from '../../src/orchestration/InboxManager.js';

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

describe('applyWakeToSnapshot', () => {
    const base = {
        meta: { turn: 2, agentId: 'agent-a' },
        pending: {
            inputs: { 'tok-in': { schema: { type: 'string' } } },
            tools: { 'tok-tool': { name: 'search', args: {} } },
            tasks: {
                'child-tok': {
                    target: 'child-agent',
                    agentId: 'child-agent',
                    childTaskId: 'child-1',
                    handlers: {},
                },
            },
            children: { 'child-tok': { agent: 'child-agent' } },
        },
        inbox: InboxManager.normalizeInbox(undefined),
    };

    it('start wake passes input through to turn params', () => {
        const prepared = applyWakeToSnapshot(base, { trigger: 'start', input: { q: 'hi' } });
        expect(prepared.trigger).toBe('start');
        expect(prepared.turnParams.input).toEqual({ q: 'hi' });
        expect(prepared.agentId).toBe('agent-a');
    });

    it('resume wake applies input.provided observation and clears pending token', () => {
        const prepared = applyWakeToSnapshot(base, {
            trigger: 'resume',
            event: { kind: 'input', token: 'tok-in', value: 'answer' },
        });
        expect(prepared.trigger).toBe('resume');
        const inbox = prepared.snapshot.inbox as { current: Array<{ kind: string; payload: unknown }> };
        expect(inbox.current[0]?.kind).toBe('input.provided');
        expect((inbox.current[0]?.payload as { value: string }).value).toBe('answer');
        expect((prepared.snapshot.pending as { inputs?: Record<string, unknown> }).inputs?.['tok-in']).toBeUndefined();
    });

    it('input timeout expires a manifest consent receipt and clears its input token', () => {
        const timed = {
            ...base,
            pending: {
                ...base.pending,
                inputs: { consent: { expiresAt: '2026-01-01T00:00:00.000Z' } },
                manifestConsents: {
                    consent: {
                        token: 'consent', taskId: 'task-a', agentId: 'agent-a', tenantId: 'tenant-a',
                        intentId: 'activate_bundle', intentDigest: 'd', effectIdempotencyKey: 'e',
                        requestedAt: '2025-12-31T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z', status: 'pending',
                    },
                },
            },
        };
        const prepared = applyWakeToSnapshot(timed, {
            trigger: 'timer',
            event: {
                kind: 'timer', token: 'consent', timerId: 'timer-1',
                dueAt: '2026-01-01T00:00:00.000Z', firedAt: '2026-01-01T00:00:01.000Z', reason: 'input_timeout',
            },
        });
        expect((prepared.snapshot as any).pending.inputs.consent).toBeUndefined();
        expect((prepared.snapshot as any).pending.manifestConsents.consent.status).toBe('expired');
        expect((prepared.snapshot as any).inbox.current[0].kind).toBe('timer.expired');
    });

    it('tool wake adds tool.completed observation and clears pending tool', () => {
        const prepared = applyWakeToSnapshot(base, {
            trigger: 'tool',
            event: { kind: 'tool', token: 'tok-tool', result: { hits: 1 } },
        });
        expect(prepared.trigger).toBe('tool');
        const inbox = prepared.snapshot.inbox as { current: Array<{ kind: string }> };
        expect(inbox.current[0]?.kind).toBe('tool.completed');
        expect(
            (prepared.snapshot.pending as { tools?: Record<string, unknown> }).tools?.['tok-tool']
        ).toBeUndefined();
    });

    it('tool wake against a detached owner is durable no-op delivery', () => {
        const detachedOwner = {
            ...base,
            meta: {
                ...base.meta,
                taskLifecycle: {
                    taskId: 'task-a',
                    rootTaskId: 'root-a',
                    ancestorTaskIds: ['root-a'],
                    state: 'detached',
                    reason: 'child_timeout',
                },
            },
        };
        const prepared = applyWakeToSnapshot(detachedOwner, {
            trigger: 'tool',
            event: { kind: 'tool', token: 'tok-tool', result: { hits: 1 } },
        }, { taskId: 'task-a' });

        expect(prepared.skipTurn).toBe(true);
        expect(prepared.toolTerminalClaim).toMatchObject({
            won: true,
            disposition: 'committed_detached',
            resumeEligible: false,
        });
        expect((prepared.snapshot as any).pending.tools['tok-tool']).toBeUndefined();
        expect((prepared.snapshot as any).pending.toolTerminals['tok-tool']).toMatchObject({
            kind: 'detached',
        });
        expect((prepared.snapshot as any).inbox.current).toEqual([]);
    });

    it('child wake adds child.completed observation', () => {
        const prepared = applyWakeToSnapshot(base, {
            trigger: 'child',
            event: {
                kind: 'child',
                token: 'child-tok',
                childTaskId: 'child-1',
                output: { result: { ok: true }, childTaskId: 'child-1' },
            },
        });
        expect(prepared.trigger).toBe('resume');
        const inbox = prepared.snapshot.inbox as { current: Array<{ kind: string }> };
        expect(inbox.current[0]?.kind).toBe('child.completed');
        expect((prepared.snapshot as any).pending.children['child-tok']).toBeUndefined();
    });

    it('child failure stays child.failed instead of child.completed with ok:false', () => {
        const prepared = applyWakeToSnapshot(base, {
            trigger: 'child',
            event: {
                kind: 'child',
                token: 'child-tok',
                childTaskId: 'child-1',
                outcome: 'failed',
                error: { code: 'CHILD_FAILED', message: 'boom' },
            },
        });
        expect((prepared.snapshot as any).inbox.current).toEqual([
            expect.objectContaining({
                kind: 'child.failed',
                payload: expect.objectContaining({
                    token: 'child-tok',
                    error: { code: 'CHILD_FAILED', message: 'boom' },
                }),
            }),
        ]);
        expect((prepared.snapshot as any).pending.tasks['child-tok']).toBeUndefined();
        expect((prepared.snapshot as any).pending.children['child-tok']).toBeUndefined();
    });

    it('preserves an autoClearToken:false control task as terminal', () => {
        const retained = {
            ...base,
            pending: {
                ...base.pending,
                tasks: {
                    'child-tok': {
                        target: 'child-agent', childTaskId: 'child-1', handlers: {},
                        options: { autoClearToken: false, setToken: true, tokenPath: 'child.token' },
                    },
                },
            },
        };
        const prepared = applyWakeToSnapshot(retained, {
            trigger: 'child',
            event: {
                kind: 'child', token: 'child-tok', childTaskId: 'child-1',
                completedAt: '2026-01-01T00:00:00.000Z', output: { ok: true },
            },
        });
        expect((prepared.snapshot as any).pending.tasks['child-tok']).toMatchObject({
            terminal: { kind: 'completed' },
            options: { autoClearToken: false },
        });
    });

    it('child timeout atomically wins once and removes durable pending state', () => {
        const timedBase = {
            ...base,
            pending: {
                ...base.pending,
                tasks: {
                    'child-tok': {
                        target: 'child-agent',
                        agentId: 'child-agent',
                        childTaskId: 'child-1',
                        timeoutMs: 50,
                        expiresAt: '2026-01-01T00:00:00.050Z',
                        handlers: {},
                    },
                },
            },
        };
        const wake = {
            trigger: 'timer' as const,
            event: {
                kind: 'timer' as const,
                token: 'child-tok',
                timerId: 'timer-child',
                dueAt: '2026-01-01T00:00:00.050Z',
                firedAt: '2026-01-01T00:00:00.051Z',
                reason: 'child_timeout' as const,
                payload: { timeoutMs: 50, childTaskId: 'child-1', agentId: 'child-agent' },
            },
        };
        const winner = applyWakeToSnapshot(timedBase, wake);
        const loser = applyWakeToSnapshot(winner.snapshot, wake);
        expect(winner.skipTurn).toBe(false);
        expect((winner.snapshot as any).inbox.current[0]).toMatchObject({
            kind: 'child.failed',
            payload: {
                token: 'child-tok',
                agentId: 'child-agent',
                childTaskId: 'child-1',
                error: { code: 'CHILD_TIMEOUT', timeoutMs: 50 },
            },
        });
        expect((winner.snapshot as any).pending.tasks['child-tok']).toBeUndefined();
        expect((winner.snapshot as any).pending.children['child-tok']).toBeUndefined();
        expect(loser.skipTurn).toBe(true);
    });

    it('replaces a stale terminal inbox item with the authoritative claim winner', () => {
        const staleCompletion = {
            source: 'child' as const,
            kind: 'child.completed' as const,
            payload: { token: 'child-tok', result: { stale: true } },
            provenance: { ts: 0, turn: 1, id: 'child-tok', correlationId: 'child-tok' },
        };
        const timedBase = {
            ...base,
            pending: {
                ...base.pending,
                tasks: {
                    'child-tok': {
                        target: 'child-agent', timeoutMs: 50,
                        expiresAt: '2026-01-01T00:00:00.050Z', handlers: {},
                    },
                },
            },
            inbox: { current: [staleCompletion], all: [staleCompletion] },
        };

        const prepared = applyWakeToSnapshot(timedBase, {
            trigger: 'timer',
            event: {
                kind: 'timer', token: 'child-tok', timerId: 'timer-child',
                dueAt: '2026-01-01T00:00:00.050Z', firedAt: '2026-01-01T00:00:00.051Z',
                reason: 'child_timeout', payload: { timeoutMs: 50 },
            },
        });

        expect((prepared.snapshot as any).inbox.current).toHaveLength(1);
        expect((prepared.snapshot as any).inbox.all).toHaveLength(1);
        expect((prepared.snapshot as any).inbox.current[0]).toMatchObject({
            kind: 'child.failed',
            payload: { token: 'child-tok', error: { code: 'CHILD_TIMEOUT' } },
        });
    });

    it('uses completion time to decide the deadline race', () => {
        const timedBase = {
            ...base,
            pending: {
                ...base.pending,
                tasks: {
                    'child-tok': {
                        target: 'child-agent',
                        timeoutMs: 50,
                        expiresAt: '2026-01-01T00:00:00.050Z',
                        handlers: {},
                    },
                },
            },
        };
        const before = applyWakeToSnapshot(timedBase, {
            trigger: 'child',
            event: {
                kind: 'child', token: 'child-tok', childTaskId: 'child-1',
                completedAt: '2026-01-01T00:00:00.049Z', output: { ok: true },
            },
        });
        const atDeadline = applyWakeToSnapshot(timedBase, {
            trigger: 'child',
            event: {
                kind: 'child', token: 'child-tok', childTaskId: 'child-1',
                completedAt: '2026-01-01T00:00:00.050Z', output: { ok: true },
            },
        });
        expect((before.snapshot as any).inbox.current[0].kind).toBe('child.completed');
        expect((atDeadline.snapshot as any).inbox.current[0]).toMatchObject({
            kind: 'child.failed',
            payload: { error: { code: 'CHILD_TIMEOUT', timeoutMs: 50 } },
        });
    });

    it('makes concurrent timeout workers idempotent across CAS retries', async () => {
        let version = BigInt(1);
        let snapshot: Record<string, unknown> = {
            meta: { turn: 1, agentId: 'agent-a' },
            pending: {
                tasks: {
                    child: {
                        target: 'child-agent', childTaskId: 'child-1', timeoutMs: 50,
                        expiresAt: '2026-01-01T00:00:00.050Z', handlers: {},
                    },
                },
                children: { child: { agent: 'child-agent' } },
            },
            inbox: InboxManager.normalizeInbox(undefined),
        };
        const appended: string[] = [];
        const sessionManager = {
            load: async () => ({ snapshot, wmVersion: version, agentId: 'agent-a' }),
            saveSnapshot: async (params: { expectedWmVersion: bigint; snapshot: Record<string, unknown> }) => {
                await Promise.resolve();
                if (params.expectedWmVersion !== version) throw new Error('CAS_MISMATCH');
                snapshot = params.snapshot;
                version += BigInt(1);
                return { wmVersion: version };
            },
            appendEvent: async (_tenantId: string, _taskId: string, type: string) => {
                appended.push(type);
            },
        };
        const wake = {
            trigger: 'timer' as const,
            event: {
                kind: 'timer' as const, token: 'child', timerId: 'timer-child',
                dueAt: '2026-01-01T00:00:00.050Z', firedAt: '2026-01-01T00:00:00.060Z',
                reason: 'child_timeout' as const,
                payload: { timeoutMs: 50, childTaskId: 'child-1', agentId: 'child-agent' },
            },
        };
        const results = await Promise.all([
            prepareSegmentWake(sessionManager as never, { tenantId: 't', taskId: 'p', wake }),
            prepareSegmentWake(sessionManager as never, { tenantId: 't', taskId: 'p', wake }),
        ]);
        expect(results.filter((result) => result.skipTurn !== true)).toHaveLength(1);
        expect(results.filter((result) => result.skipTurn === true)).toHaveLength(1);
        expect(appended).toEqual(['task.child_failed']);
        expect((snapshot as any).inbox.all.filter((entry: any) => entry.kind === 'child.failed')).toHaveLength(1);
    });

    it('recovers terminal ancestry and suppresses a late tool wake after restart', async () => {
        let version = BigInt(4);
        let snapshot: Record<string, unknown> = {
            ...base,
            meta: {
                ...base.meta,
                taskLifecycle: {
                    taskId: 'task-a', rootTaskId: 'root-a', ancestorTaskIds: ['root-a'],
                    state: 'active',
                },
            },
        };
        const rootSnapshot = {
            meta: {
                agentId: 'root-agent',
                taskLifecycle: {
                    taskId: 'root-a', rootTaskId: 'root-a', ancestorTaskIds: [],
                    state: 'completed', changedAt: '2026-07-16T12:00:00.000Z',
                },
            },
        };
        const appended: string[] = [];
        const restartedSession = {
            load: async (_tenantId: string, taskId: string) => taskId === 'root-a'
                ? { snapshot: rootSnapshot, wmVersion: BigInt(2), agentId: 'root-agent' }
                : { snapshot, wmVersion: version, agentId: 'agent-a' },
            saveSnapshot: async (params: { expectedWmVersion: bigint; snapshot: Record<string, unknown> }) => {
                expect(params.expectedWmVersion).toBe(version);
                snapshot = params.snapshot;
                version += BigInt(1);
                return { newVersion: version };
            },
            appendEvent: async (_tenantId: string, _taskId: string, type: string) => {
                appended.push(type);
            },
        };

        const prepared = await prepareSegmentWake(restartedSession as never, {
            tenantId: 'tenant-a',
            taskId: 'task-a',
            wake: {
                trigger: 'tool',
                event: { kind: 'tool', token: 'tok-tool', result: { late: true } },
            },
        });

        expect(prepared.skipTurn).toBe(true);
        expect((snapshot as any).pending.tools['tok-tool']).toBeUndefined();
        expect((snapshot as any).pending.toolTerminals['tok-tool']).toMatchObject({ kind: 'detached' });
        expect((snapshot as any).inbox.all).toEqual([]);
        expect((snapshot as any).meta.taskLifecycle).toMatchObject({
            state: 'detached',
            reason: 'ancestor_completed',
        });
        expect(appended).toEqual(['task.tool_detached', 'task.tool_late_completion']);
    });

    it('child wake hydrates artifact markers before staging child.completed', () => {
        const artifactMarker = {
            kind: 'artifact',
            id: 'html-artifact-1',
            mimeType: 'text/html',
            estimatedSize: 1024,
        };
        const prepared = applyWakeToSnapshot(base, {
            trigger: 'child',
            event: {
                kind: 'child',
                token: 'child-tok',
                childTaskId: 'child-1',
                output: {
                    ok: true,
                    data: { html: artifactMarker },
                },
            },
        }, {
            hydrateChildResult: (result) => {
                const html = (result as any)?.data?.html;
                Object.defineProperty(html, 'then', {
                    enumerable: false,
                    value: () => Promise.resolve('<html></html>'),
                });
                Object.defineProperty(html, 'load', {
                    enumerable: false,
                    value: () => Promise.resolve('<html></html>'),
                });
            },
        });

        const inbox = prepared.snapshot.inbox as { current: Array<{ payload: { result?: { data?: { html?: unknown } } } }> };
        const html = inbox.current[0]?.payload.result?.data?.html as { then?: unknown; kind?: string };
        expect(html?.kind).toBe('artifact');
        expect(typeof html?.then).toBe('function');
    });

    it('prepareSegmentWake hydrates artifact markers for persisted child wakes', async () => {
        let savedSnapshot: Record<string, unknown> | undefined;
        const sessionManager = {
            store: { prisma: {} },
            load: async () => ({
                snapshot: base,
                wmVersion: BigInt(7),
            }),
            saveSnapshot: async (params: { snapshot: Record<string, unknown> }) => {
                savedSnapshot = params.snapshot;
                return { wmVersion: BigInt(8) };
            },
        };

        await prepareSegmentWake(sessionManager as any, {
            tenantId: 'default',
            taskId: 'parent-1',
            agentId: 'agent-a',
            wake: {
                trigger: 'child',
                event: {
                    kind: 'child',
                    token: 'child-tok',
                    childTaskId: 'child-1',
                    output: {
                        ok: true,
                        data: {
                            html: {
                                kind: 'artifact',
                                id: 'html-artifact-1',
                                mimeType: 'text/html',
                                estimatedSize: 1024,
                            },
                        },
                    },
                },
            },
        });

        const inbox = savedSnapshot?.inbox as { current: Array<{ payload: { result?: { data?: { html?: unknown } } } }> };
        const html = inbox.current[0]?.payload.result?.data?.html as { then?: unknown; load?: unknown; kind?: string };
        expect(html?.kind).toBe('artifact');
        expect(typeof html?.then).toBe('function');
        expect(typeof html?.load).toBe('function');
    });

    it('prepareSegmentWake stores raw large child wake output as artifact-backed inbox data', async () => {
        const rawHtml = `<html>${'segment-wake-child-html'.repeat(5000)}</html>`;
        let savedSnapshot: Record<string, unknown> | undefined;
        const sessionManager = {
            store: { prisma: createFakeArtifactPrisma() },
            load: async () => ({
                snapshot: base,
                wmVersion: BigInt(7),
            }),
            saveSnapshot: async (params: { snapshot: Record<string, unknown> }) => {
                savedSnapshot = params.snapshot;
                return { wmVersion: BigInt(8) };
            },
        };

        await prepareSegmentWake(sessionManager as any, {
            tenantId: 'default',
            taskId: 'parent-1',
            agentId: 'agent-a',
            wake: {
                trigger: 'child',
                event: {
                    kind: 'child',
                    token: 'child-tok',
                    childTaskId: 'child-1',
                    output: {
                        ok: true,
                        data: {
                            html: rawHtml,
                            content: rawHtml,
                        },
                    },
                },
            },
        });

        const serialized = JSON.stringify(savedSnapshot);
        expect(serialized).not.toContain(rawHtml);
        const inbox = savedSnapshot?.inbox as { current: Array<{ payload: { result?: { data?: { html?: unknown; content?: unknown } } } }> };
        expect(inbox.current[0]?.payload.result?.data?.html).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
        expect(inbox.current[0]?.payload.result?.data?.content).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
    });

    it('child wake clears completed pending child and stored token by default', () => {
        const prepared = applyWakeToSnapshot({
            ...base,
            pending: {
                ...base.pending,
                tasks: {
                    'child-tok': {
                        target: 'fetch-page-router',
                        input: { url: 'https://example.test/listing.html' },
                        options: {
                            setToken: true,
                            tokenPath: 'child.token',
                            autoClearToken: true,
                            setStage: 'awaiting_fetch',
                        },
                    },
                },
                controlVars: {
                    child: { token: 'child-tok' },
                    stage: 'awaiting_fetch',
                },
            },
        }, {
            trigger: 'child',
            event: {
                kind: 'child',
                token: 'child-tok',
                childTaskId: 'child-1',
                output: { ok: true, data: { html: '<html></html>' } },
            },
        });

        expect(
            (prepared.snapshot.pending as { tasks?: Record<string, unknown> }).tasks?.['child-tok']
        ).toBeUndefined();
        expect(
            (prepared.snapshot.pending as { controlVars?: { child?: { token?: string } } }).controlVars?.child?.token
        ).toBeUndefined();
        const inbox = prepared.snapshot.inbox as { current: Array<{ kind: string }> };
        expect(inbox.current[0]?.kind).toBe('child.completed');
    });

    it('external wake adds external.event observation and clears pending event', () => {
        const prepared = applyWakeToSnapshot({
            ...base,
            pending: {
                ...base.pending,
                events: {
                    'event-tok': { type: 'webhook.received', data: { expected: true } },
                },
            },
        }, {
            trigger: 'event',
            event: {
                kind: 'external',
                token: 'event-tok',
                type: 'webhook.received',
                data: { ok: true },
            },
        });

        expect(prepared.trigger).toBe('event');
        expect(prepared.turnParams).toMatchObject({
            eventToken: 'event-tok',
            eventType: 'webhook.received',
            eventPayload: { ok: true },
        });
        expect(
            (prepared.snapshot.pending as { events?: Record<string, unknown> }).events?.['event-tok']
        ).toBeUndefined();
        const inbox = prepared.snapshot.inbox as { current: Array<{ kind: string; payload: { type?: string } }> };
        expect(inbox.current[0]?.kind).toBe('external.event');
        expect(inbox.current[0]?.payload.type).toBe('webhook.received');
    });

    it('timer wake becomes a timer.expired observation', () => {
        const prepared = applyWakeToSnapshot(base, {
            trigger: 'timer',
            event: {
                kind: 'timer',
                token: 'timer-tok',
                timerId: 'timer-1',
                dueAt: '2026-06-23T00:00:00.000Z',
                firedAt: '2026-06-23T00:00:01.000Z',
                reason: 'input_timeout',
                payload: { reason: 'ttl' },
            },
        });

        expect(prepared.trigger).toBe('event');
        expect(prepared.turnParams).toMatchObject({
            eventToken: 'timer-tok',
            eventType: 'timer.expired',
            eventPayload: { reason: 'ttl' },
        });
        const inbox = prepared.snapshot.inbox as { current: Array<{ kind: string; payload: { timerId?: string; reason?: string } }> };
        expect(inbox.current[0]?.kind).toBe('timer.expired');
        expect(inbox.current[0]?.payload.timerId).toBe('timer-1');
        expect(inbox.current[0]?.payload.reason).toBe('input_timeout');
    });

    it('conversation wake adds conversation observation', () => {
        const prepared = applyWakeToSnapshot(base, {
            trigger: 'conversation',
            event: {
                kind: 'conversation',
                token: 'conversation-session',
                messageId: 'message-1',
                data: { kind: 'message.received', text: 'hello' },
            },
        });

        expect(prepared.trigger).toBe('conversation');
        const inbox = prepared.snapshot.inbox as { current: Array<{ source: string; kind: string; payload: { kind?: string } }> };
        expect(inbox.current[0]?.source).toBe('conversation');
        expect(inbox.current[0]?.kind).toBe('message.received');
        expect(inbox.current[0]?.payload.kind).toBe('message.received');
    });
});

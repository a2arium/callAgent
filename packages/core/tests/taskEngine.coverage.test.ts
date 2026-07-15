/**
 * High-signal coverage for taskEngine orchestration helpers.
 * We isolate TaskEngine with a fake session store and heavy dependency mocks.
 */

import { jest } from '@jest/globals';
import path from 'node:path';

const srcDir = path.resolve(process.cwd(), 'packages/core/src');
import type { WMSessionSnapshot } from '@a2arium/callagent-memory-engine';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { setPendingTasks, setPendingGroups, getPendingGroups } from '../src/orchestration/Handles.js';
import { setPendingTools, getPendingTools } from '../src/orchestration/ToolsRegistry.js';
import { setPendingExternalEvents, getPendingExternalEvents } from '../src/orchestration/ExternalEventsRegistry.js';
import { normalizeObservationInbox } from '../src/loop/types.js';
import type { SynthesizeObservation } from '../src/loop/oneTurn.js';
import type { ObservationConfig } from '../src/loop/oneTurn.js';
import { InboxManager } from '../src/orchestration/InboxManager.js';
import { readSegmentCancellation } from '../src/runtime/segmentCancellation.js';
import { offloadArtifacts } from '@a2arium/callagent-memory-engine';
import { LocalArtifactImpl } from '../src/orchestration/LocalArtifactImpl.js';
import { TaskEngine } from '../src/orchestration/taskEngine.js';
import { TaskExecutor } from '../src/orchestration/TaskExecutor.js';
import { globalA2AService } from '../src/orchestration/A2AService.js';
import { InvariantError } from '../src/utils/errors.js';

// --- Module mocks (must be defined before imports run) ---
const runLoopMock = jest.fn<any>();
const originalDriverSurfaces = process.env.CALLAGENT_DRIVER_SURFACES;

// Create properly typed mocks
const mockFindLocalAgent = jest.fn() as jest.MockedFunction<(agentName: string) => Promise<any>>;
mockFindLocalAgent.mockResolvedValue({
    manifest: { name: 'mock-agent' }, // Legacy support if still used anywhere
    resolved: {
        agentCard: { name: 'mock-agent', version: '1.0.0' },
        runtimeManifest: { name: 'mock-agent', version: '1.0.0' }
    },
    loop: {},
    llmAdapter: {},
    tenantId: 'test-tenant'
});

type EngineObservation = SynthesizeObservation<ObservationConfig & { user: unknown; tool: unknown; child: unknown; internal?: unknown; env?: unknown }>;

class FakeSessionStore extends InMemorySessionManager {
    public failNextSave = false;
    public failNextSaveTooLarge = false;
    public failNextSaveWithSizeError = false;
    public failOnWriteNumber: number | null = null;
    public writeCount = 0;

    private snapshotsMap(): Map<string, WMSessionSnapshot> {
        return (this as unknown as { snapshots: Map<string, WMSessionSnapshot> }).snapshots;
    }

    private eventsMap(): Map<
        string,
        Array<{
            eventId: string;
            seq: number;
            type: string;
            payload: Record<string, unknown>;
            createdAt: string;
        }>
    > {
        return (this as unknown as {
            events: Map<
                string,
                Array<{
                    eventId: string;
                    seq: number;
                    type: string;
                    payload: Record<string, unknown>;
                    createdAt: string;
                }>
            >;
        }).events;
    }

    private outboxArr(): Array<{ tenantId: string; topic: string; key: string; payload: Record<string, unknown> }> {
        return (this as unknown as {
            outbox: Array<{ tenantId: string; topic: string; key: string; payload: Record<string, unknown> }>;
        }).outbox;
    }

    seed(tenantId: string, sessionId: string, snapshot: Record<string, unknown>, wmVersion = BigInt(0), agentId = 'agent'): void {
        const key = `${tenantId}:${sessionId}`;
        const cloned = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
        this.snapshotsMap().set(key, { wmVersion, snapshot: cloned, agentId, updatedAt: new Date().toISOString() });
    }

    getEvents(tenantId: string, sessionId: string) {
        const key = `${tenantId}:${sessionId}`;
        const eventList = this.eventsMap().get(key) || [];
        return eventList.map((e) => ({ tenantId, sessionId, type: e.type, payload: e.payload }));
    }

    getSnapshot(tenantId: string, sessionId: string): WMSessionSnapshot | null {
        const snap = this.snapshotsMap().get(`${tenantId}:${sessionId}`) ?? null;
        if (!snap) return null;
        return {
            ...snap,
            snapshot: JSON.parse(JSON.stringify(snap.snapshot)) as Record<string, unknown>,
        };
    }

    override async getSessionSnapshot(tenantId: string, sessionId: string): Promise<WMSessionSnapshot | null> {
        return this.getSnapshot(tenantId, sessionId);
    }

    override async writeSnapshotCAS(params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        expectedWmVersion: bigint;
        snapshot: Record<string, unknown>;
    }): Promise<{ newVersion: bigint }> {
        const key = `${params.tenantId}:${params.sessionId}`;
        const current = this.snapshotsMap().get(key);
        const currentVersion = current?.wmVersion ?? BigInt(0);

        if (this.failNextSave || (this.failOnWriteNumber && this.writeCount + 1 === this.failOnWriteNumber)) {
            this.writeCount++;
            this.failNextSave = false;
            this.failOnWriteNumber = null;
            throw new Error('CAS_MISMATCH');
        }

        if (this.failNextSaveWithSizeError) {
            this.writeCount++;
            this.failNextSaveWithSizeError = false;
            throw new Error('LIMIT_WM_SNAPSHOT_TOO_LARGE');
        }
        if (this.failNextSaveTooLarge) {
            this.writeCount++;
            this.failNextSaveTooLarge = false;
            throw new Error('LIMIT_WM_SNAPSHOT_TOO_LARGE');
        }

        if (current && current.wmVersion !== params.expectedWmVersion) {
            this.writeCount++;
            throw new Error('CAS_MISMATCH');
        }

        const newVersion = currentVersion + BigInt(1);

        this.writeCount++;
        const cloned = JSON.parse(JSON.stringify(params.snapshot)) as Record<string, unknown>;
        this.snapshotsMap().set(key, {
            wmVersion: newVersion,
            snapshot: cloned,
            agentId: params.agentId,
            updatedAt: new Date().toISOString(),
        });
        return { newVersion };
    }

    override async appendEvent(params: {
        tenantId: string;
        sessionId: string;
        type: string;
        payload: Record<string, unknown>;
    }): Promise<{ eventId: string; seq: number }> {
        const key = `${params.tenantId}:${params.sessionId}`;
        const eventList = this.eventsMap().get(key) || [];
        const seq = eventList.length;
        const eventId = `evt_${Date.now()}_${seq}`;
        eventList.push({
            eventId,
            seq,
            type: params.type,
            payload: params.payload,
            createdAt: new Date().toISOString(),
        });
        this.eventsMap().set(key, eventList);
        return { eventId, seq };
    }

    override async listEventsSince(params: {
        tenantId: string;
        sessionId: string;
        sinceSeq: number;
    }): Promise<
        Array<{
            eventId: string;
            seq: number;
            type: string;
            payload: Record<string, unknown>;
            createdAt: string;
        }>
    > {
        const key = `${params.tenantId}:${params.sessionId}`;
        const eventList = this.eventsMap().get(key) || [];
        return eventList.filter((e) => e.seq > params.sinceSeq);
    }

    override async enqueueOutbox(params: {
        tenantId: string;
        topic: string;
        key: string;
        payload: Record<string, unknown>;
    }): Promise<void> {
        this.outboxArr().push(params);
    }
}

function createFakeArtifactPrisma() {
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
}

const buildObservation = (token: string): EngineObservation => ({
    source: 'child',
    kind: 'child.completed',
    payload: { token, result: undefined },
    provenance: { ts: Date.now(), turn: 0, id: token, correlationId: token }
});

const createCtx = (overrides: Record<string, unknown> = {}) => ({
    task: { id: 'test-task-id', input: {} },
    tenantId: 'test-tenant',
    agentId: 'test-agent',
    memory: {},
    vars: {},
    reply: jest.fn(),
    progress: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    ...overrides
});

const mockInlineParentResume = () =>
    jest.spyOn(TaskExecutor, 'executeTurn').mockImplementation(async (params: any) => {
        const latest = await params.sessionManager.load(params.tenantId, params.sessionId);
        const snapshot = JSON.parse(JSON.stringify(latest?.snapshot ?? {})) as Record<string, unknown>;
        const meta = { ...((snapshot as any).meta ?? {}) };
        const currentTurn = Number(meta.turn ?? params.env?.turn ?? 0);
        meta.turn = currentTurn + 1;
        delete (meta as any).awaiting;
        (snapshot as any).meta = meta;

        await params.sessionManager.saveSnapshot({
            tenantId: params.tenantId,
            sessionId: params.sessionId,
            agentId: params.agentId,
            expectedWmVersion: latest?.wmVersion ?? BigInt(0),
            snapshot,
        });

        return {
            M: params.M,
            outcome: { kind: 'complete', result: {} },
            metrics: {},
            taskStatus: {
                state: 'completed',
                timestamp: new Date().toISOString(),
                metadata: { result: {} },
            },
        } as any;
    });

const mockLegacyInlineParentResume = () => {
    delete process.env.CALLAGENT_DRIVER_SURFACES;
    return mockInlineParentResume();
};

const loadEngineWithA2AMock = async (sendResult: unknown) => {
    jest.resetModules();
    const sendMock = jest.fn() as jest.MockedFunction<(params: any) => Promise<any>>;
    sendMock.mockResolvedValue(sendResult);
    const findMock = jest.fn() as jest.MockedFunction<(agentName: string) => Promise<any>>;
    findMock.mockResolvedValue({
        manifest: { name: 'child-agent' },
        resolved: {
            agentCard: { name: 'child-agent', version: '1.0.0' },
            runtimeManifest: { name: 'child-agent', version: '1.0.0' }
        },
        loop: {},
        llmAdapter: {},
        tenantId: 'test-tenant'
    });
    await jest.unstable_mockModule(path.join(srcDir, 'orchestration/A2AService.ts'), () => ({
        globalA2AService: { sendTaskToAgent: sendMock, findLocalAgent: findMock }
    } as any));
    await jest.unstable_mockModule(path.join(srcDir, 'eventbus/outboxPublisher.ts'), () => ({
        OutboxPublisher: jest.fn().mockImplementation(() => ({
            start: jest.fn(),
            stop: jest.fn(),
        })),
    }));
    await jest.unstable_mockModule(path.join(srcDir, 'loop/loopRunner.ts'), () => ({
        runLoop: (...args: any[]) => runLoopMock(...args)
    }));
    await jest.unstable_mockModule('@prisma/client', () => ({ PrismaClient: class { } }), { virtual: true });
    const mod = await import(path.join(srcDir, 'orchestration/taskEngine.ts'));
    const a2aModule = await import(path.join(srcDir, 'orchestration/A2AService.ts'));
    (a2aModule as any).globalA2AService.sendTaskToAgent = sendMock;
    (a2aModule as any).globalA2AService.findLocalAgent = findMock;
    return { TaskEngine: (mod as any).TaskEngine, sendMock, findMock };
};

beforeAll(() => {
    process.env.DISABLE_OUTBOX_PUBLISHER = '1';
});

beforeEach(() => {
    // Mock globalA2AService.findLocalAgent to return a fake agent
    jest.spyOn(globalA2AService, 'findLocalAgent').mockResolvedValue({
        manifest: { name: 'mock-agent', version: '1.0.0' },
        resolved: {
            agentCard: { name: 'mock-agent', version: '1.0.0' },
            runtimeManifest: { name: 'mock-agent', version: '1.0.0' }
        },
        handleTask: jest.fn<any>().mockResolvedValue({ status: 'completed' }),
        loop: {} as any,
        llmAdapter: undefined,
        llmConfig: undefined
    } as any);
});

afterEach(() => {
    if (originalDriverSurfaces === undefined) {
        delete process.env.CALLAGENT_DRIVER_SURFACES;
    } else {
        process.env.CALLAGENT_DRIVER_SURFACES = originalDriverSurfaces;
    }
    runLoopMock.mockReset();
    jest.clearAllMocks();
    jest.restoreAllMocks();
    TaskEngine.testOverrides = undefined;
});

describe('TaskEngine orchestration coverage', () => {
    test('cancelTask marks cancellation durably before delegating to the runtime driver', async () => {
        const store = new FakeSessionStore();
        const cancel = jest.fn(async () => undefined);
        const runtimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 'timer-1' })),
            cancel,
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const engine = new TaskEngine({
            sessionStore: store as any,
            handlerInvoker: { invoke: jest.fn() } as any,
            runtimeDriver: runtimeDriver as any,
        });
        store.seed('t', 'task-cancel', {
            meta: { agentId: 'agent-a', awaiting: { kind: 'await_child', token: 'child-token' } },
        }, BigInt(0), 'agent-a');

        await engine.cancelTask({
            tenantId: 't',
            taskId: 'task-cancel',
            agentId: 'agent-a',
            reason: 'operator stop',
        });

        const persisted = store.getSnapshot('t', 'task-cancel');
        expect(readSegmentCancellation(persisted?.snapshot)).toEqual({
            requested: true,
            reason: 'operator stop',
            requestedAt: expect.any(String),
        });
        expect(store.getEvents('t', 'task-cancel')).toEqual([
            {
                tenantId: 't',
                sessionId: 'task-cancel',
                type: 'task.canceled',
                payload: {
                    taskId: 'task-cancel',
                    agentId: 'agent-a',
                    reason: 'operator stop',
                    requestedAt: expect.any(String),
                },
            },
        ]);
        expect(cancel).toHaveBeenCalledWith({
            tenantId: 't',
            taskId: 'task-cancel',
            agentId: 'agent-a',
            idempotencyKey: 'task-cancel:cancel',
            reason: 'operator stop',
        });
    });

    test('cancelTask still acknowledges when provider cancellation fails after durable marker', async () => {
        const store = new FakeSessionStore();
        const cancel = jest.fn(async () => {
            throw new Error('task state cleaned up');
        });
        const runtimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 'timer-1' })),
            cancel,
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const engine = new TaskEngine({
            sessionStore: store as any,
            handlerInvoker: { invoke: jest.fn() } as any,
            runtimeDriver: runtimeDriver as any,
        });
        store.seed('t', 'task-cancel-provider-fails', {
            meta: { agentId: 'agent-a', awaiting: { kind: 'await_child', token: 'child-token' } },
        }, BigInt(0), 'agent-a');

        await expect(engine.cancelTask({
            tenantId: 't',
            taskId: 'task-cancel-provider-fails',
            agentId: 'agent-a',
            reason: 'operator stop',
        })).resolves.toEqual({ acknowledged: true });

        expect(readSegmentCancellation(store.getSnapshot('t', 'task-cancel-provider-fails')?.snapshot)).toEqual({
            requested: true,
            reason: 'operator stop',
            requestedAt: expect.any(String),
        });
        expect(store.getEvents('t', 'task-cancel-provider-fails').map((event) => event.type)).toEqual(['task.canceled']);
        expect(cancel).toHaveBeenCalled();
    });

    test('cancelTask notifies an A2A parent and schedules async resume for child cancellation', async () => {
        process.env.CALLAGENT_DRIVER_SURFACES = 'resume';
        const store = new FakeSessionStore();
        const cancel = jest.fn(async () => undefined);
        const enqueueResume = jest.fn(async () => undefined);
        const runtimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume,
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 'timer-1' })),
            cancel,
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const engine = new TaskEngine({
            sessionStore: store as any,
            handlerInvoker: { invoke: jest.fn() } as any,
            runtimeDriver: runtimeDriver as any,
        });
        store.seed(
            't',
            'parent-task',
            setPendingTasks(
                { meta: { agentId: 'parent-agent' } },
                {
                    'child-token': {
                        childTaskId: 'child-task',
                        target: 'child-agent',
                    },
                } as any
            ),
            BigInt(0),
            'parent-agent'
        );
        store.seed('t', 'child-task', {
            meta: {
                agentId: 'child-agent',
                a2aParent: {
                    parentTenantId: 't',
                    parentTaskId: 'parent-task',
                    parentChildToken: 'child-token',
                },
            },
        }, BigInt(0), 'child-agent');

        await engine.cancelTask({
            tenantId: 't',
            taskId: 'child-task',
            agentId: 'child-agent',
            reason: 'operator child stop',
        });

        const parentEvents = store.getEvents('t', 'parent-task');
        expect(parentEvents).toEqual([]);
        expect(enqueueResume).toHaveBeenCalledWith({
            tenantId: 't',
            taskId: 'parent-task',
            agentId: 'parent-agent',
            token: 'child-token',
            idempotencyKey: 'parent-task:child:child-token',
            event: {
                kind: 'child',
                token: 'child-token',
                childTaskId: 'child-task',
                outcome: 'failed',
                error: {
                    code: 'CHILD_CANCELED',
                    message: 'Child task canceled: operator child stop',
                },
                completedAt: expect.any(String),
            },
        });
        expect(cancel).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 't',
            taskId: 'child-task',
            agentId: 'child-agent',
            reason: 'operator child stop',
        }));
    });

    test('cancelTask is a no-op when cancellation was already requested', async () => {
        const store = new FakeSessionStore();
        const cancel = jest.fn(async () => undefined);
        const runtimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 'timer-1' })),
            cancel,
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const engine = new TaskEngine({
            sessionStore: store as any,
            handlerInvoker: { invoke: jest.fn() } as any,
            runtimeDriver: runtimeDriver as any,
        });
        store.seed('t', 'task-cancel-twice', {
            meta: {
                agentId: 'agent-a',
                cancellation: {
                    requested: true,
                    reason: 'first stop',
                    requestedAt: '2026-06-19T00:00:00.000Z',
                },
            },
        }, BigInt(0), 'agent-a');

        await engine.cancelTask({
            tenantId: 't',
            taskId: 'task-cancel-twice',
            agentId: 'agent-a',
            reason: 'second stop',
        });

        const persisted = store.getSnapshot('t', 'task-cancel-twice');
        expect(readSegmentCancellation(persisted?.snapshot)).toEqual({
            requested: true,
            reason: 'first stop',
            requestedAt: '2026-06-19T00:00:00.000Z',
        });
        expect(cancel).not.toHaveBeenCalled();
        expect(store.writeCount).toBe(0);
    });

    test('cancelTask is a no-op after a terminal task event', async () => {
        const store = new FakeSessionStore();
        const cancel = jest.fn(async () => undefined);
        const runtimeDriver = {
            enqueueStart: jest.fn(async () => undefined),
            enqueueResume: jest.fn(async () => undefined),
            enqueueChildDispatch: jest.fn(async () => undefined),
            scheduleTimer: jest.fn(async () => ({ timerId: 'timer-1' })),
            cancel,
            dispatchOutbox: jest.fn(async () => undefined),
        };
        const engine = new TaskEngine({
            sessionStore: store as any,
            handlerInvoker: { invoke: jest.fn() } as any,
            runtimeDriver: runtimeDriver as any,
        });
        store.seed('t', 'task-complete', {
            meta: { agentId: 'agent-a' },
        }, BigInt(0), 'agent-a');
        await store.appendEvent({
            tenantId: 't',
            sessionId: 'task-complete',
            type: 'task.completed',
            payload: { resultPreview: { ok: true } },
        });

        await engine.cancelTask({
            tenantId: 't',
            taskId: 'task-complete',
            agentId: 'agent-a',
            reason: 'too late',
        });

        const persisted = store.getSnapshot('t', 'task-complete');
        expect(readSegmentCancellation(persisted?.snapshot)).toBeUndefined();
        expect(cancel).not.toHaveBeenCalled();
        expect(store.writeCount).toBe(0);
    });

    test('stages child completion with CAS retry and deduplication', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const pending = setPendingTasks({}, { 'tok-1': { handlers: {} } });
        const base = { ...pending, meta: { turn: 0 }, inbox: { current: [], all: [] } } as Record<string, unknown>;
        store.seed('t', 'parent', base, BigInt(0), 'parent-agent');
        store.failNextSave = true; // force first save to throw CAS_MISMATCH

        await engine.stageChildCompletionObservation({
            tenantId: 't',
            parentTaskId: 'parent',
            childToken: 'tok-1',
            result: { ok: true },
            childAgentId: 'child-agent'
        });

        const snap = store.getSnapshot('t', 'parent');
        expect(store.writeCount).toBe(2); // initial attempt + retry
        const inbox = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>((snap?.snapshot as any).inbox);
        const matchingAll = inbox.all.filter(o => o.kind === 'child.completed' && (o as any)?.payload?.token === 'tok-1');
        expect(matchingAll).toHaveLength(1);
        expect(inbox.current.some(o => o.kind === 'child.completed' && (o as any)?.payload?.token === 'tok-1')).toBe(true);
        expect((snap?.snapshot as any).pending?.tasks?.['tok-1']).toBeDefined();
    });

    test('stageChildCompletionObservation stores large child HTML as artifact-backed snapshot data', async () => {
        const rawHtml = `<html>${'stage-child-raw-html'.repeat(5000)}</html>`;
        const store = new FakeSessionStore();
        (store as any).prisma = createFakeArtifactPrisma();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const pending = setPendingTasks({}, { 'tok-large': { handlers: {} } });
        const base = { ...pending, meta: { turn: 0 }, inbox: { current: [], all: [] } } as Record<string, unknown>;
        store.seed('t', 'parent-large', base, BigInt(0), 'parent-agent');

        await engine.stageChildCompletionObservation({
            tenantId: 't',
            parentTaskId: 'parent-large',
            childToken: 'tok-large',
            result: { ok: true, data: { html: rawHtml, content: rawHtml } },
            childAgentId: 'child-agent'
        });

        const saved = store.getSnapshot('t', 'parent-large')?.snapshot as any;
        const serialized = JSON.stringify(saved);
        expect(serialized).not.toContain(rawHtml);
        const obs = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>(saved.inbox)
            .all.find((entry: any) => entry?.payload?.token === 'tok-large') as any;
        expect(obs?.payload?.result?.data?.html).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
        expect(obs?.payload?.result?.data?.content).toEqual(expect.objectContaining({
            kind: 'artifact',
            mimeType: 'text/html',
        }));
    });

    test('resumes awaiting child and clears mappings/control vars', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        jest.spyOn(engine as any, 'createContext').mockReturnValue({ memory: {}, vars: {} } as any);
        jest.spyOn(engine as any, 'attachWorkingMemory').mockResolvedValue(undefined as any);
        jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);

        runLoopMock.mockResolvedValue({
            M: { memory: { vars: { x: 1 } } },
            outcome: { kind: 'complete', result: { ok: true } },
            metrics: { timings: {} }
        });

        const pending = setPendingTasks({
            meta: { turn: 1, awaiting: { kind: 'await_child', token: 'child-1' }, agentId: 'agent-a' },
            pending: { controlVars: { child: { token: 'child-1' } } },
            inbox: { current: [], all: [] },
            M: { memory: { vars: {} } }
        } as any, { 'child-1': { target: 'child-task', handlers: {}, options: { tokenPath: 'child.token', setToken: true, autoClearToken: true } } });
        store.seed('t', 'parent', pending as any, BigInt(0), 'agent-a');

        await engine.handleChildCompleted({
            tenantId: 't',
            parentTaskId: 'parent',
            childToken: 'child-1',
            result: { status: { state: 'completed' }, value: 7 },
            childAgentId: 'child-agent'
        });

        const snap = store.getSnapshot('t', 'parent');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        expect((saved.pending as any)?.tasks?.['child-1']).toBeUndefined();
        expect(((saved.pending as any)?.controlVars as any)?.child?.token).toBeUndefined();
        const inbox = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>(saved.inbox);
        expect(inbox.all.filter(o => o.kind === 'child.completed' && (o as any)?.payload?.token === 'child-1')).toHaveLength(1);
    });

    test('handles child failure, cleans mappings, groups, and invokes handler', async () => {
        const store = new FakeSessionStore();
        const handlerInvoker = { invoke: jest.fn<any>().mockResolvedValue(undefined) };
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: handlerInvoker as any });

        const withTask = setPendingTasks({
            meta: { turn: 0, agentId: 'agent-a' },
            pending: {},
            inbox: { current: [], all: [] }
        } as any, { 'child-err': { handlers: { failed: 'onFail' } } });

        const withGroup = setPendingGroups(withTask as any, {
            grp1: { childTokens: ['child-err'], results: {}, handlers: { anyFailed: 'onGroupFail' } }
        });

        store.seed('t', 'parent', withGroup as any, BigInt(0), 'agent-a');

        await engine.handleChildFailed({ tenantId: 't', parentTaskId: 'parent', childToken: 'child-err', error: new Error('boom') });

        const snap = store.getSnapshot('t', 'parent');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        expect((saved.pending as any)?.tasks?.['child-err']).toBeUndefined();
        expect(getPendingGroups(saved)).toEqual({});
        expect(handlerInvoker.invoke).toHaveBeenCalledTimes(2); // failed + anyFailed
        const events = store.getEvents('t', 'parent').map(e => e.type);
        expect(events).toContain('task.child_failed');
        expect(events).toContain('task.group_failed');
    });

    test('handles external event occurrence and resumes loop', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        jest.spyOn(engine as any, 'createContext').mockReturnValue({ memory: {}, vars: {} } as any);
        jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);

        runLoopMock.mockResolvedValue({
            M: { memory: { vars: {} } },
            outcome: { kind: 'await_child', token: 'child-2' },
            metrics: {}
        });

        const pendingEvents = setPendingExternalEvents({
            meta: { turn: 1, agentId: 'agent-a' },
            pending: {},
            inbox: { current: [], all: [] },
            M: { memory: { vars: {} } }
        } as any, { 'evt-1': { type: 'ping', data: { x: 1 }, handlers: {} } });
        store.seed('t', 'task', pendingEvents as any, BigInt(0), 'agent-a');

        await engine.handleExternalEventOccurred({ tenantId: 't', taskId: 'task', token: 'evt-1', payload: { x: 1 } });

        const snap = store.getSnapshot('t', 'task');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        expect(getPendingExternalEvents(saved)).toEqual({});
        const inbox = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>(saved.inbox);
        expect(inbox.all.some(o => o.kind === 'external.event')).toBe(true);
    });

    test('routes child input required through handlers and resumes child', async () => {
        const store = new FakeSessionStore();
        const resumeInputMock = jest.fn<any>().mockResolvedValue(undefined);
        const handleChildCompletedMock = jest.spyOn(TaskEngine.prototype as any, 'handleChildCompleted').mockResolvedValue(undefined);
        const handlerInvoker = {
            invoke: jest.fn<any>()
                // parent handler result
                .mockResolvedValueOnce({ provided: true })
                // child onProvided result
                .mockResolvedValueOnce({ child: 'ok' })
        };
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: handlerInvoker as any });
        (engine as any).resumeInput = resumeInputMock;

        const withTasks = setPendingTasks({
            meta: { turn: 0, agentId: 'agent-a' },
            pending: {},
            inbox: { current: [], all: [] }
        } as any, {
            'child-req': {
                target: 'child-task',
                handlers: { inputRequired: 'parentHandler' },
                options: { setToken: true, tokenPath: 'child.token', setStage: 'awaiting' }
            }
        });
        store.seed('t', 'parent', withTasks as any, BigInt(0), 'agent-a');

        await engine.handleChildInputRequired({
            tenantId: 't',
            parentTaskId: 'parent',
            childToken: 'child-req',
            prompt: 'need input',
            schema: { type: 'string' },
            childOnProvided: 'childProvided',
            childTaskId: 'child-task',
            childInputToken: 'input-token'
        });

        expect(handlerInvoker.invoke).toHaveBeenCalledWith({
            tenantId: 't',
            taskId: 'parent',
            handlerName: 'parentHandler',
            input: expect.objectContaining({ prompt: 'need input', token: 'child-req' })
        });
        expect(resumeInputMock).toHaveBeenCalledWith({
            tenantId: 't',
            taskId: 'child-task',
            token: 'input-token',
            input: { child: 'ok' }
        });
        expect(handleChildCompletedMock).toHaveBeenCalledWith({
            tenantId: 't',
            parentTaskId: 'parent',
            childToken: 'child-req',
            result: { child: 'ok' }
        });
        const snap = store.getSnapshot('t', 'parent');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        expect((saved.pending as any)?.tasks?.['child-req']?.deliveredInput).toBe(true);
        expect((saved.pending as any)?.controlVars?.child?.token).toBe('child-req');
        expect((saved.pending as any)?.controlVars?.stage).toBe('awaiting');
    });

    test('persists child context into existing snapshot', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const base = { M: { memory: { sensory: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } }, worldModel: { a: 1 }, goalState: { hierarchy: { nodes: {}, roots: [] } }, emotion: { valence: 0, arousal: 0 }, rewardParams: { extrinsicWeights: [], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 1 }, policyParams: { theta: undefined, stochastic: false } } };
        store.seed('t', 'session', base as any, BigInt(0), 'agent-a');

        await engine.persistChildContext({ tenantId: 't', sessionId: 'session', agentId: 'agent-a' });

        const snap = store.getSnapshot('t', 'session');
        const M = (snap?.snapshot as Record<string, unknown>)?.M as Record<string, unknown> | undefined;
        expect(M).toBeDefined();
        expect((M?.worldModel as Record<string, unknown>)?.a).toBe(1);
    });

    test('handles child input required without handler by persisting pending input', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const withTasks = setPendingTasks({
            meta: { turn: 0, agentId: 'agent-a' },
            pending: {},
            inbox: { current: [], all: [] }
        } as any, {
            'child-req': {
                handlers: {},
                options: { setToken: true, tokenPath: 'child.token' }
            }
        });
        store.seed('t', 'parent', withTasks as any, BigInt(0), 'agent-a');

        await engine.handleChildInputRequired({
            tenantId: 't',
            parentTaskId: 'parent',
            childToken: 'child-req',
            prompt: 'need input',
            schema: { type: 'string' }
        });

        const snap = store.getSnapshot('t', 'parent');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        expect((saved.pending as any)?.tasks?.['child-req']?.pendingInput).toBeDefined();
        expect((saved.pending as any)?.controlVars?.child?.token).toBe('child-req');
    });

    test('requestInput uses CAS retry and sets pending input with control var', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const ctx: any = { reply: jest.fn(), progress: jest.fn(), logger: { info: jest.fn(), warn: jest.fn() } };
        const flushMentalState = jest.fn();
        const base = { meta: { agentId: 'agent-a' }, pending: {}, inbox: { current: [], all: [] }, M: { memory: { vars: {} } } };
        store.seed('t', 'session', base as any, BigInt(0), 'agent-a');
        store.failNextSave = true; // force retry path

        await (engine as any).apiBinder.attachOrchestrationAPIs(ctx, { tenantId: 't', sessionId: 'session', agentId: 'agent-a', flushMentalState: jest.fn() });
        const handle = await ctx.requestInput('need info', { ttlMs: 10, onProvided: 'onProvided', setStage: 'awaiting' });

        const snap = store.getSnapshot('t', 'session');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        const pendingInputs = (saved.pending as any)?.inputs || {};
        expect(Object.keys(pendingInputs)).toHaveLength(1);
        const token = Object.keys(pendingInputs)[0];
        expect(pendingInputs[token]).toMatchObject({ expiresAt: expect.any(String) });
        expect((saved.pending as any)?.controlVars?.token).toBe(token);
        expect((saved.pending as any)?.controlVars?.stage).toBe('awaiting');
        expect(handle).toBeDefined();
        const events = store.getEvents('t', 'session').map(e => e.type);
        expect(events).toContain('task.input_required');
    });

    test('requestInput enforces max outstanding prompts', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const ctx: any = createCtx();
        const pendingInputs = Object.fromEntries(Array.from({ length: 100 }).map((_, i) => [`tok-${i}`, { handlerName: 'h' }] as const));
        const base = { meta: { agentId: 'agent-a' }, pending: { inputs: pendingInputs }, inbox: { current: [], all: [] }, M: { memory: { vars: {} } } };
        store.seed('t', 'session', base as any, BigInt(0), 'agent-a');
        await (engine as any).apiBinder.attachOrchestrationAPIs(ctx, { tenantId: 't', sessionId: 'session', agentId: 'agent-a', flushMentalState: jest.fn() });

        let err: unknown;
        try {
            await ctx.requestInput('blocked');
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(InvariantError);
        expect((err as InvariantError).invariant.code).toBe('LIMIT_MAX_PROMPTS_EXCEEDED');
    });

    test('resumeInput consumes pending token and resumes loop', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        jest.spyOn(engine as any, 'createContext').mockReturnValue(createCtx());
        jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);
        runLoopMock.mockResolvedValue({ M: { memory: { vars: {} } }, outcome: { kind: 'complete' }, metrics: {} });

        const base = {
            meta: { turn: 1, agentId: 'agent-a' },
            pending: { inputs: { tok: { handlerName: 'onProvided' } } },
            inbox: { current: [], all: [] },
            M: { memory: { vars: {} } }
        };
        store.seed('t', 'task', base as any, BigInt(0), 'agent-a');

        await engine.resumeInput({ tenantId: 't', taskId: 'task', token: 'tok', input: { text: 'hello' } });

        const snap = store.getSnapshot('t', 'task');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        expect((saved.pending as any)?.inputs?.tok).toBeUndefined();
        expect(store.getEvents('t', 'task').map(e => e.type)).toContain('task.input_provided');
    });

    test('resumeInput handles await_child outcome without throwing', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        jest.spyOn(engine as any, 'createContext').mockReturnValue(createCtx());
        jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);
        runLoopMock.mockResolvedValue({ M: { memory: { vars: {} } }, outcome: { kind: 'await_child', token: 'c1' }, metrics: {} });

        const base = {
            meta: { turn: 1, agentId: 'agent-a' },
            pending: { inputs: { tok: { handlerName: 'onProvided' } } },
            inbox: { current: [], all: [] },
            M: { memory: { vars: {} } }
        };
        store.seed('t', 'task', base as any, BigInt(0), 'agent-a');

        await engine.resumeInput({ tenantId: 't', taskId: 'task', token: 'tok', input: { text: 'hello' } });
    });

    test('resumeInput rejects missing or expired tokens', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        // Missing token
        await expect(engine.resumeInput({ tenantId: 't', taskId: 'task', token: 'missing', input: {} })).rejects.toThrow('Session task not found');


        const expired = {
            meta: { agentId: 'agent-a' },
            pending: { inputs: { tok: { expiresAt: new Date(Date.now() - 1000).toISOString() } } },
            inbox: { current: [], all: [] },
            M: { memory: { vars: {} } }
        };
        store.seed('t', 'task', expired as any, BigInt(0), 'agent-a');
        await expect(engine.resumeInput({ tenantId: 't', taskId: 'task', token: 'tok', input: {} })).rejects.toThrow(/Input token .* expired/);
    });

    test('requestTool calls attachOrchestrationAPIs requestTool', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const ctx: any = { goals: {} };
        const mockFn = jest.fn() as any;
        await (engine as any).apiBinder.attachOrchestrationAPIs(ctx, {
            tenantId: 't',
            sessionId: 'session',
            agentId: 'a',
            flushMentalState: undefined as any,
            requestTool: mockFn
        });
        // Seed initial state
        store.seed('t', 'session', { pending: { tools: {} }, meta: { turn: 0 } }, BigInt(0), 'a');
        await ctx.requestTool('search', { q: 'hi' }, { setToken: true, setStage: 'tooling', onCompleted: 'done' });

        // Check side effect in store instead of mock call
        const snap = store.getSnapshot('t', 'session');
        const tools = (snap?.snapshot?.pending as any)?.tools || {};
        const token = Object.keys(tools)[0];
        expect(token).toBeDefined();
        expect(tools[token]).toMatchObject({
            name: 'search',
            args: { q: 'hi' },
            handlers: { completed: 'done' },
            options: { setToken: true, setStage: 'tooling' }
        });
    });

    test('attachOrchestrationAPIs.requestTool stores pending tool with options', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const ctx: any = createCtx();
        const base = { meta: { agentId: 'agent-a' }, pending: {}, inbox: { current: [], all: [] }, M: { memory: { vars: {} } } };
        store.seed('t', 'session', base as any, BigInt(0), 'agent-a');
        await (engine as any).apiBinder.attachOrchestrationAPIs(ctx, { tenantId: 't', sessionId: 'session', agentId: 'agent-a', flushMentalState: jest.fn() });

        const { token } = await ctx.requestTool('search', { q: 'hi' }, { setToken: true, setStage: 'tooling', onCompleted: 'done' });

        const snap = store.getSnapshot('t', 'session');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        const tools = (saved.pending as any)?.tools || {};
        expect(tools[token]).toMatchObject({ name: 'search', args: { q: 'hi' } });
    });

    test('sendTaskToAgent retries CAS on controlVar save and sets stage/token', async () => {
        const store = new FakeSessionStore();
        // First write (createTaskHandle) succeeds; second write (control vars) fails once
        store.failOnWriteNumber = 2;
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        // Register engine with EngineLocator for A2AService
        const { EngineLocator } = await import('../src/orchestration/EngineLocator.js');
        EngineLocator.setEngine(engine);

        const ctx: any = createCtx();
        const base = { meta: { agentId: 'agent-a' }, pending: {}, inbox: { current: [], all: [] }, M: { memory: { vars: {} } } };
        store.seed('t', 'session', base as any, BigInt(0), 'agent-a');
        await (engine as any).apiBinder.attachOrchestrationAPIs(ctx, { tenantId: 't', sessionId: 'session', agentId: 'agent-a', flushMentalState: jest.fn() });

        const { token } = await ctx.sendTaskToAgent('agent-b', { input: 1 }, { setToken: true, tokenPath: 'child.token', setStage: 'child-await', autoClearToken: false });
        expect(token).toBeDefined();

        const snap = store.getSnapshot('t', 'session');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        const tasks = (saved.pending as any)?.tasks || {};
        expect(tasks[token]).toMatchObject({ input: { input: 1 } });
        expect(((saved.pending as any)?.controlVars || {}).child?.token).toBe(token);
        expect(((saved.pending as any)?.controlVars || {}).stage).toBe('child-await');
        expect(store.writeCount).toBeGreaterThanOrEqual(2); // CAS retry occurred
    });

    test('sendTaskToAgent respects setToken false (no control var set)', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const ctx: any = createCtx();
        const base = { meta: { agentId: 'agent-a' }, pending: {}, inbox: { current: [], all: [] }, M: { memory: { vars: {} } } };
        store.seed('t', 'session', base as any, BigInt(0), 'agent-a');
        await (engine as any).apiBinder.attachOrchestrationAPIs(ctx, { tenantId: 't', sessionId: 'session', agentId: 'agent-a', flushMentalState: jest.fn() });

        const { token } = await ctx.sendTaskToAgent('agent-b', { input: 2 }, { setToken: false, setStage: 'child-await', autoClearToken: false });
        expect(token).toBeDefined();

        const snap = store.getSnapshot('t', 'session');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        const tasks = (saved.pending as any)?.tasks || {};
        expect(tasks[token]).toBeDefined();
        expect(((saved.pending as any)?.controlVars || {}).child?.token).toBeUndefined();
        expect(((saved.pending as any)?.controlVars || {}).stage).toBe('child-await');
    });

    test('sendTaskToAgent applies control vars for token and stage', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const ctx: any = createCtx();
        const base = { meta: { agentId: 'agent-a' }, pending: {}, inbox: { current: [], all: [] }, M: { memory: { vars: {} } } };
        store.seed('t', 'session', base as any, BigInt(0), 'agent-a');
        await (engine as any).apiBinder.attachOrchestrationAPIs(ctx, { tenantId: 't', sessionId: 'session', agentId: 'agent-a', flushMentalState: jest.fn() });

        const { token } = await ctx.sendTaskToAgent('agent-b', { input: 1 }, { setToken: true, tokenPath: 'child.token', setStage: 'child-await', autoClearToken: false });
        expect(token).toBeDefined();

        const snap = store.getSnapshot('t', 'session');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        const tasks = (saved.pending as any)?.tasks || {};
        expect(tasks[token]).toMatchObject({ input: { input: 1 } });
        expect(((saved.pending as any)?.controlVars || {}).child?.token).toBe(token);
        expect(((saved.pending as any)?.controlVars || {}).stage).toBe('child-await');
        expect(store.writeCount).toBeGreaterThanOrEqual(1);
    });

    test('await_child resumes after fetch when awaitCompletion=false', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const base = {
            meta: { turn: 1, agentId: 'agent-a', awaiting: { kind: 'await_child', token: 'child-1' } },
            pending: { tasks: { 'child-1': {} } },
            inbox: { current: [], all: [] },
            M: { memory: { vars: {} } }
        };
        store.seed('t', 'parent', base as any, BigInt(0), 'agent-a');

        const initialSnap = store.getSnapshot('t', 'parent');
        const initialTurn = Number(((initialSnap?.snapshot as any)?.meta?.turn) ?? 0);

        const executeTurnSpy = mockLegacyInlineParentResume();

        await engine.handleChildCompleted({
            tenantId: 't',
            parentTaskId: 'parent',
            childToken: 'child-1',
            result: { status: 'ok' }
        });

        const afterSnap = store.getSnapshot('t', 'parent');
        const savedPending = ((afterSnap?.snapshot as any)?.pending || {}) as Record<string, unknown>;
        const savedMeta = ((afterSnap?.snapshot as any)?.meta || {}) as Record<string, unknown>;
        const afterTurn = Number(savedMeta.turn ?? 0);

        expect(executeTurnSpy).toHaveBeenCalledTimes(1);
        expect(afterTurn).toBeGreaterThan(initialTurn);
        expect((savedPending as any)?.tasks?.['child-1']).toBeUndefined();
        expect((savedMeta as any)?.awaiting).toBeUndefined();
    });

    test('resumes parent even when awaiting metadata not persisted yet', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        jest.spyOn(engine as any, 'createContext').mockReturnValue({ memory: {}, vars: {} } as any);
        jest.spyOn(engine as any, 'attachWorkingMemory').mockResolvedValue(undefined as any);
        jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);

        const executeTurnSpy = mockLegacyInlineParentResume();

        const pending = setPendingTasks({
            meta: { turn: 2, agentId: 'agent-a' },
            pending: {},
            inbox: { current: [], all: [] },
            M: { memory: { vars: {} } }
        } as any, {
            'child-early': {
                target: 'child-task',
                handlers: {},
                options: { tokenPath: 'child.token', setToken: true, autoClearToken: true }
            }
        });
        const base = { ...pending };
        store.seed('t', 'parent', base as any, BigInt(0), 'agent-a');

        const initialSnap = store.getSnapshot('t', 'parent');
        const initialTurn = Number(((initialSnap?.snapshot as any)?.meta?.turn) ?? 0);

        await engine.handleChildCompleted({
            tenantId: 't',
            parentTaskId: 'parent',
            childToken: 'child-early',
            result: { status: 'ok' },
            childAgentId: 'child-agent'
        });

        const afterSnap = store.getSnapshot('t', 'parent');
        const savedPending = ((afterSnap?.snapshot as any)?.pending || {}) as Record<string, unknown>;
        const savedMeta = ((afterSnap?.snapshot as any)?.meta || {}) as Record<string, unknown>;
        const afterTurn = Number(savedMeta.turn ?? 0);

        expect(executeTurnSpy).toHaveBeenCalledTimes(1);
        expect(afterTurn).toBeGreaterThan(initialTurn);
        expect((savedPending as any)?.tasks?.['child-early']).toBeUndefined();
        expect((savedMeta as any)?.awaiting).toBeUndefined();
    });

    test('await_child ignores completion when pending entry was already removed', async () => {
        class EntryClearingStore extends FakeSessionStore {
            private loadCount = 0;
            async getSessionSnapshot(tenantId: string, sessionId: string): Promise<WMSessionSnapshot | null> {
                const snap = await super.getSessionSnapshot(tenantId, sessionId);
                this.loadCount++;
                if (this.loadCount === 1 && snap) {
                    const mutated = JSON.parse(JSON.stringify(snap.snapshot));
                    if (mutated.pending?.tasks) {
                        delete mutated.pending.tasks['child-early'];
                    }
                    const agentId = snap.agentId || (snap.snapshot as any)?.meta?.agentId || 'agent-a';
                    this.seed(tenantId, sessionId, mutated, (snap.wmVersion ?? BigInt(0)) + BigInt(1), agentId);
                }
                return snap;
            }
        }

        const store = new EntryClearingStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        jest.spyOn(engine as any, 'createContext').mockReturnValue({ memory: {}, vars: {} } as any);
        jest.spyOn(engine as any, 'attachWorkingMemory').mockResolvedValue(undefined as any);
        jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);

        const executeTurnSpy = mockLegacyInlineParentResume();

        const pending = setPendingTasks({
            meta: { turn: 2, agentId: 'agent-a' },
            pending: {},
            inbox: { current: [], all: [] },
            M: { memory: { vars: {} } }
        } as any, {
            'child-early': {
                target: 'child-task',
                handlers: {},
                options: { tokenPath: 'child.token', setToken: true, autoClearToken: true }
            }
        });
        const base = { ...pending };
        store.seed('t', 'parent', base as any, BigInt(0), 'agent-a');

        const initialSnap = store.getSnapshot('t', 'parent');
        const initialTurn = Number(((initialSnap?.snapshot as any)?.meta?.turn) ?? 0);

        await engine.handleChildCompleted({
            tenantId: 't',
            parentTaskId: 'parent',
            childToken: 'child-early',
            result: { status: 'ok' },
            childAgentId: 'child-agent'
        });

        const afterSnap = store.getSnapshot('t', 'parent');
        const savedMeta = ((afterSnap?.snapshot as any)?.meta || {}) as Record<string, unknown>;
        const afterTurn = Number(savedMeta.turn ?? 0);

        expect(executeTurnSpy).toHaveBeenCalledTimes(0);
        expect(afterTurn).toBe(initialTurn);
        expect((afterSnap?.snapshot as any)?.pending?.tasks?.['child-early']).toBeUndefined();
        expect((savedMeta as any)?.awaiting).toBeUndefined();
    });

    test('await_child does not resume from awaiting metadata after its pending entry is removed', async () => {
        class AwaitingDroppingStore extends FakeSessionStore {
            private loadCount = 0;
            async getSessionSnapshot(tenantId: string, sessionId: string): Promise<WMSessionSnapshot | null> {
                const snap = await super.getSessionSnapshot(tenantId, sessionId);
                if (!snap) return snap;
                this.loadCount++;
                if (this.loadCount === 2) {
                    const mutated = JSON.parse(JSON.stringify(snap.snapshot));
                    if (mutated.meta) {
                        delete mutated.meta.awaiting;
                    }
                    if (!mutated.pending) mutated.pending = {};
                    mutated.pending.tasks = {};
                    const agentId = snap.agentId || (snap.snapshot as any)?.meta?.agentId || 'agent-a';
                    const newVersion = (snap.wmVersion ?? BigInt(0)) + BigInt(1);
                    this.seed(tenantId, sessionId, mutated, newVersion, agentId);
                    return { ...snap, snapshot: mutated, wmVersion: newVersion };
                }
                return snap;
            }
        }

        const store = new AwaitingDroppingStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        jest.spyOn(engine as any, 'createContext').mockReturnValue({ memory: {}, vars: {} } as any);
        jest.spyOn(engine as any, 'attachWorkingMemory').mockResolvedValue(undefined as any);
        jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);

        const executeTurnSpy = mockLegacyInlineParentResume();

        const base = {
            meta: { turn: 2, agentId: 'agent-a', awaiting: { kind: 'await_child', token: 'child-1' } },
            pending: { tasks: { 'child-1': {} } },
            inbox: { current: [], all: [] },
            M: { memory: { vars: {} } }
        };
        store.seed('t', 'parent', base as any, BigInt(0), 'agent-a');

        const initialSnap = store.getSnapshot('t', 'parent');
        const initialTurn = Number(((initialSnap?.snapshot as any)?.meta?.turn) ?? 0);

        await engine.handleChildCompleted({
            tenantId: 't',
            parentTaskId: 'parent',
            childToken: 'child-1',
            result: { status: 'ok' }
        });

        const afterSnap = store.getSnapshot('t', 'parent');
        const savedMeta = ((afterSnap?.snapshot as any)?.meta || {}) as Record<string, unknown>;
        const afterTurn = Number(savedMeta.turn ?? 0);

        expect(executeTurnSpy).toHaveBeenCalledTimes(0);
        expect(afterTurn).toBe(initialTurn);
    });

    test('offloadArtifacts deduplicates repeated LocalArtifacts', async () => {
        const spy = jest.fn<any>().mockResolvedValue({ artifactId: 'art-1', size: 123 });
        const cache = { storeArtifact: spy };
        const artifact = new LocalArtifactImpl('<html>1</html>', 'text/html');
        const payload = {
            first: artifact,
            second: artifact
        };

        await offloadArtifacts(payload, cache as any, 'default');

        expect(spy).toHaveBeenCalledTimes(1);
        // After offloading, both should be artifact objects (offload only happens once)
        expect(payload.first).toHaveProperty('kind', 'artifact');
        expect(payload.second).toHaveProperty('kind', 'artifact');
        expect((payload.first as any).id).toBe('art-1');
        expect(payload.second).toEqual(payload.first);
    });

    test('handleChildFailed invokes anyFailed group handler and removes group', async () => {
        const store = new FakeSessionStore();
        const handlerInvoker = { invoke: jest.fn<any>().mockResolvedValue(undefined) };
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: handlerInvoker as any });
        const base = setPendingTasks({
            meta: { agentId: 'agent-a' },
            pending: {},
            inbox: { current: [], all: [] },
            M: { memory: { vars: {} } }
        } as any, { 'child-err': { handlers: { failed: 'onFail' } } });
        const withGroup = setPendingGroups(base as any, {
            g1: { childTokens: ['child-err'], results: {}, handlers: { anyFailed: 'onGroupFail' } }
        });
        store.seed('t', 'parent', withGroup as any, BigInt(0), 'agent-a');

        await engine.handleChildFailed({ tenantId: 't', parentTaskId: 'parent', childToken: 'child-err', error: new Error('boom') });

        const snap = store.getSnapshot('t', 'parent');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        expect(getPendingGroups(saved)).toEqual({});
        expect(handlerInvoker.invoke).toHaveBeenCalledWith({ tenantId: 't', taskId: 'parent', handlerName: 'onFail', input: expect.any(Error) });
        expect(handlerInvoker.invoke).toHaveBeenCalledWith({ tenantId: 't', taskId: 'parent', handlerName: 'onGroupFail', input: expect.any(Object) });
    });

    test('handleExternalEventOccurred sets awaiting when loop awaits child', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        jest.spyOn(engine as any, 'createContext').mockReturnValue(createCtx());
        jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);
        runLoopMock.mockResolvedValue({
            M: { memory: { vars: {} } },
            outcome: { kind: 'await_child', token: 'child-x' },
            metrics: {}
        });

        const base = setPendingExternalEvents({
            meta: { turn: 0, agentId: 'agent-a' },
            pending: {},
            inbox: { current: [], all: [] },
            M: { memory: { vars: {} } }
        } as any, { 'evt-1': { type: 'ping', data: { x: 1 }, handlers: {} } });
        store.seed('t', 'task', base as any, BigInt(0), 'agent-a');

        await engine.handleExternalEventOccurred({ tenantId: 't', taskId: 'task', token: 'evt-1', payload: { x: 1 } });

        const snap = store.getSnapshot('t', 'task');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        expect(getPendingExternalEvents(saved)).toEqual({});
    });

    test('handleToolCompleted sets awaiting when loop awaits tool', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        jest.spyOn(engine as any, 'createContext').mockReturnValue(createCtx());
        jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);
        runLoopMock.mockResolvedValue({
            M: { memory: { vars: {} } },
            outcome: { kind: 'await_tool', token: 'tool-next' },
            metrics: {}
        });

        const pendingTools = setPendingTools({
            meta: { turn: 0, agentId: 'agent-a' },
            pending: {},
            inbox: { current: [], all: [] },
            M: { memory: { vars: {} } }
        } as any, { 'tool-1': { name: 'calc', args: { x: 1 } } });
        store.seed('t', 'task', pendingTools as any, BigInt(0), 'agent-a');

        await engine.handleToolCompleted({ tenantId: 't', taskId: 'task', token: 'tool-1', result: { ok: true } });

        const snap = store.getSnapshot('t', 'task');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        expect(saved.meta).toBeDefined();
    });

    test('mergeInboxes merges remote child completions without duplicates', () => {
        const local = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>({ current: [], all: [] });
        const remoteObs = buildObservation('remote-1');
        const remote = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>({ current: [], all: [remoteObs] });
        const merged = InboxManager.mergeInboxes(local, remote, { 'remote-1': true });
        expect(merged.current.some(o => (o as any)?.payload?.token === 'remote-1')).toBe(true);
        expect(merged.all.filter(o => (o as any)?.payload?.token === 'remote-1')).toHaveLength(1);

        // Add local duplicate and ensure it doesn't double count
        const merged2 = InboxManager.mergeInboxes(merged, remote, { 'remote-1': true });
        expect(merged2.all.filter(o => (o as any)?.payload?.token === 'remote-1')).toHaveLength(1);
    });

    test('InboxManager.mergeInboxes merges multiple remote child completions', () => {
        const local = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>({ current: [], all: [] });
        const remote = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>({
            current: [],
            all: [buildObservation('a'), buildObservation('b')]
        });
        const merged = InboxManager.mergeInboxes(local, remote, { b: true });
        expect(merged.all.some(o => (o as any)?.payload?.token === 'b')).toBe(true);
        expect(merged.current.some(o => (o as any)?.payload?.token === 'b')).toBe(true);
    });

    test('attachAndRestoreLLM can be overridden for tests', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const override = jest.fn().mockResolvedValue(undefined);
        TaskEngine.testOverrides = { attachAndRestoreLLM: override };
        jest.spyOn(engine as any, 'createContext').mockReturnValue(createCtx());
        runLoopMock.mockResolvedValue({ M: { memory: { vars: {} } }, outcome: { kind: 'complete' }, metrics: {} });

        const pendingTools = setPendingTools({
            meta: { turn: 0, agentId: 'agent-a' },
            pending: {},
            inbox: { current: [], all: [] },
            M: { memory: { vars: {} } }
        } as any, { 'tool-1': { name: 'calc', args: { x: 1 } } });
        store.seed('t', 'task', pendingTools as any, BigInt(0), 'agent-a');

        await engine.handleToolCompleted({ tenantId: 't', taskId: 'task', token: 'tool-1', result: { ok: true } });
        expect(override).toHaveBeenCalled();
    });
    test('handles child completion without re-running loop when awaiting different token', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        jest.spyOn(engine as any, 'createContext').mockReturnValue(createCtx());
        jest.spyOn(engine as any, 'attachWorkingMemory').mockResolvedValue(undefined as any);
        jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);

        const preStaged = buildObservation('child-1');
        const pending = setPendingTasks({
            meta: { turn: 3, awaiting: { kind: 'await_child', token: 'other-token' } },
            pending: { controlVars: { child: { token: 'child-1' } } },
            inbox: { current: [], all: [preStaged] }
        } as any, { 'child-1': { target: 'child-task', handlers: {}, options: { tokenPath: 'child.token', setToken: true, autoClearToken: true } } });
        const base = { ...pending, M: { memory: { vars: {} } } };
        store.seed('t', 'parent', base, BigInt(0), 'parent-agent');

        await engine.handleChildCompleted({
            tenantId: 't',
            parentTaskId: 'parent',
            childToken: 'child-1',
            result: { status: { state: 'completed' }, value: 42 },
            childAgentId: 'child-agent'
        });

        const snap = store.getSnapshot('t', 'parent');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        // Task should be deleted since autoClearToken: true
        expect((saved.pending as any)?.tasks?.['child-1']).toBeUndefined();
        // Control var should also be deleted since setToken: true && autoClearToken: true
        expect(((saved.pending as any)?.controlVars as any)?.child?.token).toBeUndefined();

        const inbox = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>(saved.inbox);
        const matching = inbox.all.filter(o => o.kind === 'child.completed' && (o as any)?.payload?.token === 'child-1');
        expect(matching).toHaveLength(1); // no duplicate appended
        expect(
            inbox.current.some(o => o.kind === 'child.completed' && (o as any)?.payload?.token === 'child-1') ||
            inbox.all.some(o => o.kind === 'child.completed' && (o as any)?.payload?.token === 'child-1')
        ).toBe(true);
        expect(runLoopMock).not.toHaveBeenCalled();
    });

    describe('background tasks', () => {
        test('waitForBackgroundTasks resolves when none pending', async () => {
            const engine = new TaskEngine({ sessionStore: new FakeSessionStore() as any, handlerInvoker: { invoke: jest.fn() } as any });
            await engine.waitForBackgroundTasks(10);
        });

        test('waitForBackgroundTasks waits for pending promise', async () => {
            const engine = new TaskEngine({ sessionStore: new FakeSessionStore() as any, handlerInvoker: { invoke: jest.fn() } as any });
            let resolved = false;
            const p = new Promise<void>(res => {
                setTimeout(() => {
                    resolved = true;
                    res();
                }, 5);
            });
            (engine as any).backgroundTaskPromises.add(p);
            await engine.waitForBackgroundTasks(50);
            expect(resolved).toBe(true);
        });

        test('waitForBackgroundTasks logs when DEBUG_BACKGROUND_TASKS is enabled', async () => {
            const engine = new TaskEngine({ sessionStore: new FakeSessionStore() as any, handlerInvoker: { invoke: jest.fn() } as any });
            const original = process.env.DEBUG_BACKGROUND_TASKS;
            process.env.DEBUG_BACKGROUND_TASKS = '1';
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
            const p = Promise.resolve();
            (engine as any).backgroundTaskPromises.add(p);

            await engine.waitForBackgroundTasks(20);

            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('after cleanup delay'));
            logSpy.mockRestore();
            process.env.DEBUG_BACKGROUND_TASKS = original;
        });

        test('waitForBackgroundTasks logs early exit when none pending and DEBUG set', async () => {
            const engine = new TaskEngine({ sessionStore: new FakeSessionStore() as any, handlerInvoker: { invoke: jest.fn() } as any });
            const original = process.env.DEBUG_BACKGROUND_TASKS;
            process.env.DEBUG_BACKGROUND_TASKS = '1';
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });

            await engine.waitForBackgroundTasks(10);

            expect(logSpy).toHaveBeenCalledWith('[TaskEngine] No background tasks to wait for');
            logSpy.mockRestore();
            process.env.DEBUG_BACKGROUND_TASKS = original;
        });

        test('waitForBackgroundTasks names tracked pending background tasks on timeout', async () => {
            const engine = new TaskEngine({ sessionStore: new FakeSessionStore() as any, handlerInvoker: { invoke: jest.fn() } as any });
            const pending = new Promise<void>(() => undefined);
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });

            (engine as any).trackBackgroundTask(pending, {
                kind: 'tool.auto_execute',
                label: 'tool.auto_execute mcp:browser-use',
                tenantId: 'default',
                taskId: 'task-1',
                agentId: 'fetch-browser',
                token: 'tool-token-1',
                toolName: 'mcp:browser-use',
                source: 'ApiBinder.requestTool',
            });

            try {
                await expect(engine.waitForBackgroundTasks(5, { throwOnTimeout: true })).rejects.toThrow(
                    /tool\.auto_execute mcp:browser-use[\s\S]*tool-token-1/
                );
            } finally {
                warnSpy.mockRestore();
            }
        });
    });

    test('handles tool completion, persists observation, and resumes once', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        jest.spyOn(engine as any, 'createContext').mockReturnValue({ memory: {}, vars: {} } as any);
        jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);

        runLoopMock.mockResolvedValue({
            M: { memory: { vars: {} } },
            outcome: { kind: 'complete', result: { ok: true } },
            metrics: { timings: {} }
        });

        const pendingTools = setPendingTools({ meta: { turn: 0, agentId: 'agent-a' }, pending: {} } as any, {
            'tool-1': { name: 'search', args: { q: 'hi' } }
        });
        const base = { ...pendingTools, inbox: { current: [], all: [] }, M: { memory: { vars: {} } } };
        store.seed('t', 'task', base, BigInt(0), 'agent-a');

        await engine.handleToolCompleted({ tenantId: 't', taskId: 'task', token: 'tool-1', result: { text: 'ok' } });

        const snap = store.getSnapshot('t', 'task');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        const inbox = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>(saved.inbox);
        expect(inbox.all.some(o => o.kind === 'tool.completed' && (o as any)?.payload?.token === 'tool-1')).toBe(true);
        expect(getPendingTools(saved)).not.toHaveProperty('tool-1');
    });

    test('stageChildCompletionObservation no-ops when snapshot or token missing', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        await engine.stageChildCompletionObservation({ tenantId: 't', parentTaskId: 'missing', childToken: 'tok', result: {} });
        expect(store.writeCount).toBe(0);

        store.seed('t', 'parent', { pending: { tasks: {} }, inbox: { current: [], all: [] } } as any, BigInt(0), 'agent-a');
        await engine.stageChildCompletionObservation({ tenantId: 't', parentTaskId: 'parent', childToken: 'unknown', result: {} });
        expect(store.writeCount).toBe(0);
    });

    test('stageChildCompletionObservation deduplicates existing observation', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const obs = buildObservation('child-dup');
        const base = setPendingTasks({ meta: { turn: 0 }, pending: {}, inbox: { current: [], all: [obs] } } as any, {
            'child-dup': {}
        });
        store.seed('t', 'parent', base as any, BigInt(0), 'agent-a');

        await engine.stageChildCompletionObservation({ tenantId: 't', parentTaskId: 'parent', childToken: 'child-dup', result: { ok: true } });

        const snap = store.getSnapshot('t', 'parent');
        const inbox = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>((snap?.snapshot as any)?.inbox);
        expect(inbox.all.filter(o => (o as any)?.payload?.token === 'child-dup')).toHaveLength(1);
        expect(store.writeCount).toBe(0);
    });



    test('restoreCtx durable sendTaskToAgent injects child completion into active loop', async () => {
        // Use spyOn instead of module mocking to avoid Jest ESM issues
        const sendMock = jest.spyOn(globalA2AService, 'sendTaskToAgent').mockResolvedValue({ status: 'completed', value: 5 });

        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const { EngineLocator } = await import('../src/orchestration/EngineLocator.js');
        EngineLocator.setEngine(engine);

        const base = { meta: { agentId: 'agent-a' }, inbox: { current: [], all: [] }, pending: {}, M: { memory: { vars: {} } } };
        store.seed('t', 'session', base as any, BigInt(0), 'agent-a');
        const ctx: any = await (engine as any).restoreCtx('t', 'session');
        ctx.__activeLoopInbox = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>({ current: [], all: [] });
        ctx.__activeLoopEnv = { turn: 1, pending: { children: {}, inputs: {}, tools: {}, groups: {} } };
        const handleChildSpy = jest.spyOn(engine as any, 'handleChildCompleted');

        const result = await ctx.sendTaskToAgent('child-agent', { input: 1 }, { setToken: true, setStage: 'child-await', autoClearToken: false });

        // New API returns { handle, token } where result is in handle
        expect(result.handle).toBeDefined();
        expect(result.handle.status).toBe('completed');
        expect(result.handle.value).toBe(5);
        expect(sendMock).toHaveBeenCalledWith(
            expect.any(Object),
            'child-agent',
            expect.objectContaining({ input: 1 }),
            expect.objectContaining({ parentTenantId: 't', parentTaskId: 'session', skipParentNotification: true })
        );
        expect(handleChildSpy).toHaveBeenCalledWith(expect.objectContaining({
            parentTaskId: 'session',
            suppressResume: true,
        }));
        const saved = store.getSnapshot('t', 'session')?.snapshot as any;
        const token = Object.keys((saved?.pending as any)?.tasks || {})[0];
        expect(ctx.__activeLoopInbox.current.some((o: any) => o?.payload?.token === token)).toBe(true);
        expect(ctx.__activeLoopEnv.pending.children[token]).toBeDefined();
    });

    test('restoreCtx durable sendTaskToAgent does not complete a still-working child', async () => {
        const sendMock = jest.spyOn(globalA2AService, 'sendTaskToAgent').mockResolvedValue({
            id: 'child-task-id',
            input: { input: 1 },
            status: {
                state: 'working',
                timestamp: new Date().toISOString(),
            },
        });

        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const { EngineLocator } = await import('../src/orchestration/EngineLocator.js');
        EngineLocator.setEngine(engine);

        const base = { meta: { agentId: 'agent-a' }, inbox: { current: [], all: [] }, pending: {}, M: { memory: { vars: {} } } };
        store.seed('t', 'session', base as any, BigInt(0), 'agent-a');
        const ctx: any = await (engine as any).restoreCtx('t', 'session');
        ctx.__activeLoopInbox = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>({ current: [], all: [] });
        ctx.__activeLoopEnv = { turn: 1, pending: { children: {}, inputs: {}, tools: {}, groups: {} } };
        const handleChildSpy = jest.spyOn(engine as any, 'handleChildCompleted');

        const result = await ctx.sendTaskToAgent('child-agent', { input: 1 }, { setToken: true, setStage: 'child-await', autoClearToken: false });

        expect(result.handle).toBeDefined();
        expect(result.handle.status?.state).toBe('working');
        expect(sendMock).toHaveBeenCalledWith(
            expect.any(Object),
            'child-agent',
            expect.objectContaining({ input: 1 }),
            expect.objectContaining({ parentTenantId: 't', parentTaskId: 'session', skipParentNotification: true })
        );
        expect(handleChildSpy).not.toHaveBeenCalled();
        expect(ctx.__activeLoopInbox.current).toHaveLength(0);
        expect(ctx.__activeLoopInbox.all).toHaveLength(0);

        const events = store.getEvents('t', 'session');
        expect(events.some((event) => event.type === 'task.child_started')).toBe(true);
        expect(events.some((event) => event.type === 'task.child_completed')).toBe(false);
    });

    test('restoreCtx durable sendTaskToAgent falls back to handleChildCompleted when no active inbox', async () => {
        // Use spyOn instead of module mocking to avoid Jest ESM issues
        const sendMock = jest.spyOn(globalA2AService, 'sendTaskToAgent').mockResolvedValue({ status: 'completed', value: 5 });

        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const { EngineLocator } = await import('../src/orchestration/EngineLocator.js');
        EngineLocator.setEngine(engine);

        const base = { meta: { agentId: 'agent-a' }, inbox: { current: [], all: [] }, pending: {}, M: { memory: { vars: {} } } };
        store.seed('t', 'session', base as any, BigInt(0), 'agent-a');
        const ctx: any = await (engine as any).restoreCtx('t', 'session');
        // Don't set __activeLoopInbox to test fallback
        ctx.__activeLoopEnv = { turn: 1, pending: { children: {}, inputs: {}, tools: {}, groups: {} } };
        const handleChildSpy = jest.spyOn(engine as any, 'handleChildCompleted');

        await ctx.sendTaskToAgent('child-agent', { input: 'test' }, { setToken: 'child-1' });

        expect(handleChildSpy).toHaveBeenCalled();
    });

    test('startTask injects initial input into inbox for agent perception', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });

        // Capture the environment by spying on TurnRunner's runTurn
        let capturedParams: any = null;
        const originalRunTurn = (engine as any).turnRunner.runTurn.bind((engine as any).turnRunner);
        jest.spyOn((engine as any).turnRunner, 'runTurn').mockImplementation(async (ctx: any, params: any, overrides: any) => {
            capturedParams = params;
            // Call the original to get the environment setup
            return originalRunTurn(ctx, params, overrides);
        });

        // Mock runLoop to return immediately after we've captured the env
        runLoopMock.mockResolvedValue({
            M: { memory: { vars: {} } },
            outcome: { kind: 'complete', result: { ok: true } },
            metrics: { timings: {} }
        });

        const initialInput = { caseId: 'CASE-123', priority: 'high' };
        const task = {
            id: 'task-with-input',
            input: initialInput,
            status: { state: 'submitted' as const, timestamp: new Date().toISOString() }
        };

        await engine.startTask({
            task,
            isStreaming: false,
            agentId: 'test-agent',
            tenantId: 't'
        });

        // Verify that TurnRunner received the input parameter
        expect(capturedParams).not.toBeNull();
        expect(capturedParams.input).toBeDefined();
        expect(capturedParams.input).toEqual(initialInput);
        expect(capturedParams.trigger).toBe('start');
    });

    test('startTask passes manifestProvenance to TurnRunner context', async () => {
        delete process.env.CALLAGENT_DRIVER_SURFACES;
        const { TaskEngine: MockedTaskEngine } = await loadEngineWithA2AMock({});
        const store = new FakeSessionStore();
        const engine = new MockedTaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const baseCtx = createCtx();
        jest.spyOn(engine as any, 'createContext').mockReturnValue(baseCtx);
        jest.spyOn(engine as any, 'attachWorkingMemory').mockResolvedValue(undefined as any);
        jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);
        const runTurn = jest.spyOn((engine as any).turnRunner, 'runTurn').mockResolvedValue({
            id: 'provenance-task',
            input: { test: true },
            status: { state: 'completed', timestamp: new Date().toISOString() },
        } as any);

        const task = {
            id: 'provenance-task',
            input: { test: true },
            status: { state: 'submitted' as const, timestamp: new Date().toISOString() },
        };

        await engine.startTask({
            task,
            isStreaming: false,
            agentId: 'test-agent',
            tenantId: 't',
        });

        expect(runTurn).toHaveBeenCalled();
        const runTurnCtx = runTurn.mock.calls[0]?.[0] as { __manifestProvenance?: { agentCardSource: string; runtimeManifestSource: string; agentCardHash: string; runtimeManifestHash: string } } | undefined;
        expect(runTurnCtx?.__manifestProvenance).toBeDefined();
        expect(runTurnCtx!.__manifestProvenance).toMatchObject({
            agentCardSource: expect.any(String),
            runtimeManifestSource: expect.any(String),
            agentCardHash: expect.any(String),
            runtimeManifestHash: expect.any(String),
        });
    });

    test('startTask delegates prepared context to TurnRunner for loop execution', async () => {
        delete process.env.CALLAGENT_DRIVER_SURFACES;
        const { TaskEngine: MockedTaskEngine } = await loadEngineWithA2AMock({});
        const store = new FakeSessionStore();
        const engine = new MockedTaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const baseCtx = createCtx();
        jest.spyOn(engine as any, 'createContext').mockReturnValue(baseCtx);
        jest.spyOn(engine as any, 'attachWorkingMemory').mockResolvedValue(undefined as any);
        jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);
        const runTurn = jest.spyOn((engine as any).turnRunner, 'runTurn').mockResolvedValue({
            id: 'conversation-api-task',
            input: { test: true },
            status: { state: 'completed', timestamp: new Date().toISOString() },
        } as any);

        await engine.startTask({
            task: {
                id: 'conversation-api-task',
                input: { test: true },
                status: { state: 'submitted' as const, timestamp: new Date().toISOString() },
            },
            isStreaming: false,
            agentId: 'test-agent',
            tenantId: 't',
        });

        expect(runTurn).toHaveBeenCalled();
        const [runTurnCtx, turnParams] = runTurn.mock.calls[0] as [{ task?: { id?: string }; tenantId?: string; agentId?: string }, { sessionId?: string; tenantId?: string; trigger?: string }];
        expect(runTurnCtx).toBe(baseCtx);
        expect(turnParams).toMatchObject({
            sessionId: 'conversation-api-task',
            tenantId: 't',
            trigger: 'start',
        });
    });

    // Note: executeTaskHandler tests removed as they test internal implementation details
    // The method is already tested indirectly through public API tests
});

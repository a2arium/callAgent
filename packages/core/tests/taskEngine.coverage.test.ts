/**
 * High-signal coverage for taskEngine orchestration helpers.
 * We isolate TaskEngine with a fake session store and heavy dependency mocks.
 */

import { jest } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IWorkingMemorySessionStore, WMSessionSnapshot } from '../src/core/memory/stores/SessionStore.js';
import { setPendingTasks, setPendingGroups, getPendingGroups } from '../src/core/orchestration/Handles.js';
import { setPendingTools, getPendingTools } from '../src/core/orchestration/ToolsRegistry.js';
import { setPendingExternalEvents, getPendingExternalEvents } from '../src/core/orchestration/ExternalEventsRegistry.js';
import { normalizeObservationInbox } from '../src/loop/types.js';
import type { SynthesizeObservation } from '../src/loop/oneTurn.js';
import type { ObservationConfig } from '../src/loop/oneTurn.js';

// --- Module mocks (must be defined before imports run) ---
const runLoopMock = jest.fn();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const a2aPath = path.resolve(__dirname, '../src/core/orchestration/A2AService.ts');
const outboxPath = path.resolve(__dirname, '../src/eventbus/outboxPublisher.ts');
const loopRunnerPath = path.resolve(__dirname, '../src/loop/loopRunner.ts');
const taskEnginePath = path.resolve(__dirname, '../src/core/orchestration/taskEngine.ts');

await jest.unstable_mockModule(a2aPath, () => ({
    globalA2AService: { sendTaskToAgent: jest.fn() }
}));

await jest.unstable_mockModule(outboxPath, () => ({
    outboxPublisher: { start: jest.fn(), stop: jest.fn() }
}));

await jest.unstable_mockModule(loopRunnerPath, () => ({
    runLoop: (...args: any[]) => runLoopMock(...args)
}));

await jest.unstable_mockModule('@prisma/client', () => ({ PrismaClient: class {} }), { virtual: true });

const { TaskEngine } = await import(taskEnginePath);

type EngineObservation = SynthesizeObservation<ObservationConfig & { user: unknown; tool: unknown; child: unknown; internal?: unknown; env?: unknown }>;

class FakeSessionStore implements IWorkingMemorySessionStore {
    private snapshots = new Map<string, WMSessionSnapshot>();
    private events: Array<{ tenantId: string; sessionId: string; type: string; payload: Record<string, unknown> }> = [];
    private outbox: Array<{ tenantId: string; topic: string; key: string; payload: Record<string, unknown> }> = [];
    public failNextSave = false;
    public failNextSaveTooLarge = false;
    public writeCount = 0;

    seed(tenantId: string, sessionId: string, snapshot: Record<string, unknown>, wmVersion = BigInt(0), agentId = 'agent'): void {
        const key = `${tenantId}:${sessionId}`;
        this.snapshots.set(key, { wmVersion, snapshot, agentId, updatedAt: new Date().toISOString() });
    }

    getEvents(tenantId: string, sessionId: string) {
        return this.events.filter(e => e.tenantId === tenantId && e.sessionId === sessionId);
    }

    getSnapshot(tenantId: string, sessionId: string): WMSessionSnapshot | null {
        return this.snapshots.get(`${tenantId}:${sessionId}`) ?? null;
    }

    async getSessionSnapshot(tenantId: string, sessionId: string): Promise<WMSessionSnapshot | null> {
        return this.getSnapshot(tenantId, sessionId);
    }

    async writeSnapshotCAS(params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        expectedWmVersion: bigint;
        snapshot: Record<string, unknown>;
    }): Promise<{ newVersion: bigint }> {
        this.writeCount++;
        if (this.failNextSave) {
            this.failNextSave = false;
            throw new Error('CAS_MISMATCH');
        }
        if (this.failNextSaveTooLarge) {
            this.failNextSaveTooLarge = false;
            throw new Error('LIMIT_WM_SNAPSHOT_TOO_LARGE');
        }

        const key = `${params.tenantId}:${params.sessionId}`;
        const current = this.snapshots.get(key);
        const currentVersion = current?.wmVersion ?? BigInt(0);

        if (current && current.wmVersion !== params.expectedWmVersion) {
            throw new Error('CAS_MISMATCH');
        }

        const newVersion = currentVersion + BigInt(1);
        this.snapshots.set(key, {
            wmVersion: newVersion,
            snapshot: params.snapshot,
            agentId: params.agentId,
            updatedAt: new Date().toISOString()
        });
        return { newVersion };
    }

    async appendEvent(params: { tenantId: string; sessionId: string; type: string; payload: Record<string, unknown> }): Promise<{ eventId: string; seq: number }> {
        this.events.push(params);
        return { eventId: `evt-${this.events.length}`, seq: this.events.length - 1 };
    }

    async listEventsSince(params: { tenantId: string; sessionId: string; sinceSeq: number; }): Promise<Array<{ eventId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string }>> {
        return this.events
            .map((e, idx) => ({ ...e, seq: idx }))
            .filter(e => e.tenantId === params.tenantId && e.sessionId === params.sessionId && e.seq > params.sinceSeq)
            .map(e => ({ eventId: `evt-${e.seq}`, seq: e.seq, type: e.type, payload: e.payload, createdAt: new Date().toISOString() }));
    }

    async enqueueOutbox(params: { tenantId: string; topic: string; key: string; payload: Record<string, unknown> }): Promise<void> {
        this.outbox.push(params);
    }
}

const buildObservation = (token: string): EngineObservation => ({
    source: 'child',
    kind: 'child.completed',
    payload: { token },
    provenance: { ts: Date.now(), turn: 0, id: token, correlationId: token }
});

beforeAll(() => {
    process.env.DISABLE_OUTBOX_PUBLISHER = '1';
});

afterEach(() => {
    runLoopMock.mockReset();
    jest.clearAllMocks();
});

describe('TaskEngine orchestration coverage', () => {
    test('stages child completion with CAS retry and deduplication', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const pending = setPendingTasks({}, { 'tok-1': { childTaskId: 'child-1', handlers: {} } });
        const base = { ...pending, meta: { turn: 0 }, inbox: { current: [], all: [] } } as Record<string, unknown>;
        store.seed('t', 'parent', base, BigInt(0), 'parent-agent');
        store.failNextSave = true; // force first save to throw CAS_MISMATCH

        await engine.stageChildCompletionObservation({
            tenantId: 't',
            parentTaskId: 'parent',
            childToken: 'tok-1',
            childTaskId: 'child-1',
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
        } as any, { 'child-1': { childTaskId: 'child-task', handlers: {}, options: { tokenPath: 'child.token', setToken: true, autoClearToken: true } } });
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
        expect(runLoopMock).toHaveBeenCalledTimes(1);
        const envArg = runLoopMock.mock.calls[0]?.[2];
        expect(envArg.turn).toBe(2);
        expect(envArg.inbox.current.some((o: EngineObservation) => o.kind === 'child.completed')).toBe(true);

        expect((saved.pending as any)?.tasks?.['child-1']).toBeUndefined();
        expect(((saved.pending as any)?.controlVars as any)?.child?.token).toBeUndefined();
        const inbox = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>(saved.inbox);
        expect(inbox.all.filter(o => o.kind === 'child.completed' && (o as any)?.payload?.token === 'child-1')).toHaveLength(1);
    });

    test('handles child failure, cleans mappings, groups, and invokes handler', async () => {
        const store = new FakeSessionStore();
        const handlerInvoker = { invoke: jest.fn().mockResolvedValue(undefined) };
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: handlerInvoker as any });

        const withTask = setPendingTasks({
            meta: { turn: 0, agentId: 'agent-a' },
            pending: {},
            inbox: { current: [], all: [] }
        } as any, { 'child-err': { childTaskId: 'child-task', handlers: { failed: 'onFail' } } });

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
        expect(runLoopMock).toHaveBeenCalledTimes(1);
    });

    test('routes child input required through handlers and resumes child', async () => {
        const store = new FakeSessionStore();
        const resumeInputMock = jest.fn().mockResolvedValue(undefined);
        const handleChildCompletedMock = jest.spyOn(TaskEngine.prototype as any, 'handleChildCompleted').mockResolvedValue(undefined);
        const handlerInvoker = {
            invoke: jest.fn()
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
                childTaskId: 'child-task',
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

    test('persists child context vars into existing snapshot', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const base = { M: { memory: { vars: { a: 1 } } } };
        store.seed('t', 'session', base as any, BigInt(0), 'agent-a');

        await engine.persistChildContext({ tenantId: 't', sessionId: 'session', agentId: 'agent-a', vars: { b: 2 } });

        const snap = store.getSnapshot('t', 'session');
        const vars = (snap?.snapshot as any)?.M?.memory?.vars;
        expect(vars).toEqual({ a: 1, b: 2 });
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
                childTaskId: 'child-task',
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
            schema: { type: 'string' },
            childTaskId: 'child-task'
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

        await (engine as any).attachOrchestrationAPIs(ctx, { tenantId: 't', sessionId: 'session', agentId: 'agent-a', flushMentalState });
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

    test('resumeInput consumes pending token and resumes loop', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        jest.spyOn(engine as any, 'createContext').mockReturnValue({ memory: {}, vars: {}, reply: jest.fn(), progress: jest.fn() } as any);
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
        expect(runLoopMock).toHaveBeenCalledTimes(1);
    });

    test('attachOrchestrationAPIs.requestTool stores pending tool with options', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        const ctx: any = { reply: jest.fn(), progress: jest.fn(), logger: { info: jest.fn(), warn: jest.fn() } };
        const base = { meta: { agentId: 'agent-a' }, pending: {}, inbox: { current: [], all: [] }, M: { memory: { vars: {} } } };
        store.seed('t', 'session', base as any, BigInt(0), 'agent-a');
        await (engine as any).attachOrchestrationAPIs(ctx, { tenantId: 't', sessionId: 'session', agentId: 'agent-a', flushMentalState: jest.fn() });

        const { token } = await ctx.requestTool('search', { q: 'hi' }, { setToken: true, setStage: 'tooling', onCompleted: 'done' });

        const snap = store.getSnapshot('t', 'session');
        const saved = (snap?.snapshot || {}) as Record<string, unknown>;
        const tools = (saved.pending as any)?.tools || {};
        expect(tools[token]).toMatchObject({ name: 'search', args: { q: 'hi' } });
    });

    test('handles child completion without re-running loop when awaiting different token', async () => {
        const store = new FakeSessionStore();
        const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });
        jest.spyOn(engine as any, 'createContext').mockReturnValue({ memory: {}, vars: {} } as any);
        jest.spyOn(engine as any, 'attachWorkingMemory').mockResolvedValue(undefined as any);
        jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);

        const preStaged = buildObservation('child-1');
        const pending = setPendingTasks({
            meta: { turn: 3, awaiting: { kind: 'await_child', token: 'other-token' } },
            pending: { controlVars: { child: { token: 'child-1' } } },
            inbox: { current: [], all: [preStaged] }
        } as any, { 'child-1': { childTaskId: 'child-task', handlers: {}, options: { tokenPath: 'child.token', setToken: true, autoClearToken: true } } });
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
        expect((saved.pending as any)?.children?.['child-1']).toBeUndefined();
        expect(((saved.pending as any)?.controlVars as any)?.child?.token).toBe('child-1');

        const inbox = normalizeObservationInbox<ObservationConfig & { user: unknown; tool: unknown; child: unknown }>(saved.inbox);
        const matching = inbox.all.filter(o => o.kind === 'child.completed' && (o as any)?.payload?.token === 'child-1');
        expect(matching).toHaveLength(1); // no duplicate appended
        expect(
            inbox.current.some(o => o.kind === 'child.completed' && (o as any)?.payload?.token === 'child-1') ||
            inbox.all.some(o => o.kind === 'child.completed' && (o as any)?.payload?.token === 'child-1')
        ).toBe(true);
        expect(runLoopMock).not.toHaveBeenCalled();
    });

    describe('helper internals', () => {
        test('mergeVarsIntoMental strips functions and merges source vars', () => {
            const engine = new TaskEngine({ sessionStore: new FakeSessionStore() as any, handlerInvoker: { invoke: jest.fn() } as any });
            const source = { memory: { vars: { a: 1, fn: () => 1 } }, vars: { b: 2, fn2: () => 2 } };
            const target = { memory: { vars: { c: 3 } }, vars: { d: 4, fn3: () => 3 } };
            const result = (engine as any).mergeVarsIntoMental(source, target);
            expect(result.memory.vars).toEqual({ c: 3, a: 1 });
            expect(result.vars).toEqual({ d: 4 });
        });

        test('setNestedValueClone and deleteNestedValueClone handle dotted paths', () => {
            const engine = new TaskEngine({ sessionStore: new FakeSessionStore() as any, handlerInvoker: { invoke: jest.fn() } as any });
            const base = { a: { b: 1 }, x: 2 };
            const next = (engine as any).setNestedValueClone(base, 'a.c', 3);
            expect(next).toEqual({ a: { b: 1, c: 3 }, x: 2 });
            expect(base).toEqual({ a: { b: 1 }, x: 2 }); // immutability

            const { next: afterDelete, changed } = (engine as any).deleteNestedValueClone(next, 'a.b');
            expect(changed).toBe(true);
            expect(afterDelete).toEqual({ a: { c: 3 }, x: 2 });

            const { changed: noChange } = (engine as any).deleteNestedValueClone(afterDelete, 'a.missing');
            expect(noChange).toBe(false);
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

        expect(runLoopMock).toHaveBeenCalledTimes(1);
        const envArg = runLoopMock.mock.calls[0]?.[2];
        expect(envArg.inbox.current.some((o: EngineObservation) => o.kind === 'tool.completed')).toBe(true);
    });
});

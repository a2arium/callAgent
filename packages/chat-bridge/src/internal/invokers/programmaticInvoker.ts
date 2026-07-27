import {
    PluginManager,
    createInMemoryEventBus,
    taskChannel,
    busEventData,
    mapA2AEventToRuntimeStream,
    projectRuntimeStreamChat,
    isTerminalRuntimeStreamStatus,
    type A2AEvent,
    type BusEvent,
    type IEventBus,
    type RuntimeStreamEvent,
} from '@a2arium/callagent-core';
import type { BridgeTaskInput, ChatRoute, ChatSender, Invoker, ResultPayload, ResumeParams, RuntimeStreamSink, StartParams, StreamingInvoker } from '../../types.js';
import {
    createStreamForwardState,
    forwardChatProjectionEvent,
    type ForwardedStreamResult,
    type StreamForwardState,
} from './chatProjectionForwarder.js';
import { consumeRuntimeStreamAsResult } from './runtimeStreamResult.js';

// Internal types for the invoker
type TaskEngine = {
    startTask(params: {
        task: { id: string; input: BridgeTaskInput };
        isStreaming: boolean;
        agentId: string;
        tenantId: string;
    }): Promise<unknown>;
    resumeInput(params: {
        tenantId: string;
        taskId: string;
        token: string;
        input: BridgeTaskInput;
        isStreaming?: boolean;
    }): Promise<unknown>;
};
type WorkingMemoryEvent = {
    type?: string;
    payload?: {
        token?: unknown;
        prompt?: unknown;
    };
};
type IWorkingMemorySessionStore = {
    listEventsSince(params: { tenantId: string; sessionId: string; sinceSeq: number }): Promise<WorkingMemoryEvent[]>;
};
type ProgrammaticInvokerRuntime = {
    engine: TaskEngine;
    eventBus: IEventBus;
    taskChannel: typeof taskChannel;
    wmStore: IWorkingMemorySessionStore;
};
type ProgrammaticInvokerDeps = {
    chatSender: ChatSender;
    sessionStore?: IWorkingMemorySessionStore;
    runtime?: ProgrammaticInvokerRuntime;
};
type RuntimeStreamQueueItem =
    | { kind: 'events'; events: RuntimeStreamEvent[] }
    | { kind: 'error'; error: unknown }
    | { kind: 'done' };

export class ProgrammaticInvoker implements Invoker, StreamingInvoker {
    private static _wmStore: IWorkingMemorySessionStore | undefined;
    private static _engine: TaskEngine | undefined;
    private static _eventBus = createInMemoryEventBus();
    private static _taskChannel = taskChannel;
    private static _initialized = false;

    constructor(private readonly deps: ProgrammaticInvokerDeps) { }

    private async ensureInitialized() {
        if (ProgrammaticInvoker._initialized) return;
        const [{ TaskEngine, createInMemoryEventBus }, { WorkingMemorySessionStore }] = await Promise.all([
            import('@a2arium/callagent-core' as any),
            import('@a2arium/callagent-memory-sql' as any)
        ] as any);
        ProgrammaticInvoker._wmStore = this.deps.sessionStore ?? new (WorkingMemorySessionStore as any)();
        const bus = createInMemoryEventBus();
        ProgrammaticInvoker._eventBus = bus;
        ProgrammaticInvoker._engine = new TaskEngine({ sessionStore: ProgrammaticInvoker._wmStore, eventBus: bus });
        ProgrammaticInvoker._taskChannel = taskChannel;
        ProgrammaticInvoker._initialized = true;
    }

    private async getRuntime(): Promise<ProgrammaticInvokerRuntime> {
        if (this.deps.runtime) {
            return this.deps.runtime;
        }

        await this.ensureInitialized();
        const { _engine, _eventBus, _taskChannel, _wmStore } = ProgrammaticInvoker;
        if (!_engine || !_wmStore) {
            throw new Error('ProgrammaticInvoker runtime was not initialized');
        }

        return {
            engine: _engine,
            eventBus: _eventBus,
            taskChannel: _taskChannel,
            wmStore: _wmStore,
        };
    }

    private async recoverInputToken(params: {
        wmStore: IWorkingMemorySessionStore;
        tenantId: string;
        taskId: string;
        token: string;
        prompt?: string;
    }): Promise<{ token: string; prompt?: string }> {
        let { token, prompt } = params;
        if (token && token !== 'opaque') {
            return { token, prompt };
        }

        try {
            const events = await params.wmStore.listEventsSince({
                tenantId: params.tenantId,
                sessionId: params.taskId,
                sinceSeq: 0,
            });
            const last = [...events].reverse().find((event) => event.type === 'task.input_required');
            const recoveredToken = last?.payload?.token;
            const recoveredPrompt = last?.payload?.prompt;
            token = typeof recoveredToken === 'string' ? recoveredToken : token;
            prompt = typeof recoveredPrompt === 'string' ? recoveredPrompt : prompt;
        } catch {
            /* ignore */
        }

        return { token: token || 'opaque', prompt };
    }

    private async forwardBusEventToChat(params: {
        be: BusEvent;
        route: ChatRoute;
        tenantId: string;
        state: StreamForwardState;
    }): Promise<ForwardedStreamResult> {
        const runtimeEvents = this.mapBusEventToRuntimeStream(params.be, params.tenantId);
        if (!runtimeEvents) {
            return { kind: 'continue' };
        }

        const chatEvents = projectRuntimeStreamChat(runtimeEvents);
        for (const chatEvent of chatEvents) {
            const result = await forwardChatProjectionEvent({
                sender: this.deps.chatSender,
                route: params.route,
                state: params.state,
                event: chatEvent,
            });
            if (result.kind !== 'continue') {
                return result;
            }
        }

        return { kind: 'continue' };
    }

    private mapBusEventToRuntimeStream(be: BusEvent, tenantId: string): RuntimeStreamEvent[] | undefined {
        const ev = busEventData<A2AEvent>(be);
        if (!ev) return undefined;

        try {
            return mapA2AEventToRuntimeStream(ev, {
                id: be.eventId,
                seq: 0,
                ts: be.ts,
                tenantId,
            });
        } catch {
            return undefined;
        }
    }

    private async *streamBusRuntimeEvents(params: {
        taskId: string;
        tenantId: string;
        startExecution: (runtime: ProgrammaticInvokerRuntime) => Promise<unknown>;
    }): AsyncIterable<RuntimeStreamEvent> {
        const runtime = await this.getRuntime();
        const channel = runtime.taskChannel(params.taskId);
        const queue: RuntimeStreamQueueItem[] = [];
        let wake: (() => void) | undefined;
        let unsubscribe: (() => Promise<void>) | undefined;

        const push = (item: RuntimeStreamQueueItem) => {
            queue.push(item);
            wake?.();
            wake = undefined;
        };

        const subscription = await runtime.eventBus.subscribe(channel, async (be: BusEvent) => {
            const events = this.mapBusEventToRuntimeStream(be, params.tenantId);
            if (!events || events.length === 0) return;
            push({ kind: 'events', events });
            if (events.some((event) => isTerminalRuntimeStreamStatus(event))) {
                push({ kind: 'done' });
                try { await unsubscribe?.(); } catch { }
            }
        });
        unsubscribe = subscription.unsubscribe;

        void params.startExecution(runtime).catch((error) => {
            push({ kind: 'error', error });
            push({ kind: 'done' });
        });

        try {
            while (true) {
                if (queue.length === 0) {
                    await new Promise<void>((resolve) => { wake = resolve; });
                }
                const item = queue.shift();
                if (!item) continue;
                if (item.kind === 'done') break;
                if (item.kind === 'error') throw item.error;
                for (const event of item.events) {
                    yield event;
                }
            }
        } finally {
            try { await unsubscribe?.(); } catch { }
        }
    }

    async start(params: StartParams, sink?: RuntimeStreamSink): Promise<ResultPayload> {
        if (sink) {
            return consumeRuntimeStreamAsResult({
                taskId: params.id,
                events: this.startStream(params),
                sink,
            });
        }

        const { id, input, agentId, tenantId = 'default', route } = params;
        const normalizedInput: BridgeTaskInput = {
            route,
            text: input.text,
            attachments: input.attachments,
            replyToMessageId: input.replyToMessageId,
            raw: input.raw
        };
        try { console.info(`[invoker] start: id=${id} agentId=${agentId} tenantId=${tenantId}`); } catch { }
        // Ensure agent is loaded or discoverable
        if (!PluginManager.findAgent(agentId)) {
            await PluginManager.loadAgentWithDependencies(agentId).catch(() => null);
        }

        const { engine, eventBus, taskChannel, wmStore } = await this.getRuntime();

        // Subscribe to streaming events and forward to chat
        const channel = taskChannel(id);
        try {
            const busAny: any = eventBus as any;
            if (!busAny.__dbgId) busAny.__dbgId = Math.random().toString(36).slice(2);
            console.info(`[invoker] start:bus channel=${channel} busId=${busAny.__dbgId}`);
        } catch { }
        let resolveFn: (r: ResultPayload) => void;
        const done = new Promise<ResultPayload>((resolve) => { resolveFn = resolve; });
        const forwardState = createStreamForwardState();
        let unsubStart: (() => Promise<void>) | undefined;

        const handler = async (be: BusEvent) => {
            const result = await this.forwardBusEventToChat({ be, route, tenantId, state: forwardState });
            if (result.kind === 'input_required') {
                const recovered = await this.recoverInputToken({ wmStore, tenantId, taskId: id, token: result.token, prompt: result.prompt });
                try { await unsubStart?.(); } catch { }
                resolveFn!({ id, status: 'input_required', token: recovered.token, prompt: recovered.prompt });
            } else if (result.kind === 'failed') {
                try { await unsubStart?.(); } catch { }
                resolveFn!({ id, status: 'failed', error: result.error });
            } else if (result.kind === 'completed') {
                try { await unsubStart?.(); } catch { }
                resolveFn!({ id, status: 'completed', output: result.output });
            }
        };
        const startSub = await eventBus.subscribe(channel, handler);
        unsubStart = startSub.unsubscribe;

        // Start task in streaming mode
        try { console.info('[invoker] calling engine.startTask now...'); } catch { }
        await engine.startTask({ task: { id, input: normalizedInput }, isStreaming: true, agentId, tenantId });
        return done;
    }

    async *startStream(params: StartParams): AsyncIterable<RuntimeStreamEvent> {
        const { id, input, agentId, tenantId = 'default', route } = params;
        if (!PluginManager.findAgent(agentId)) {
            await PluginManager.loadAgentWithDependencies(agentId).catch(() => null);
        }
        const normalizedInput: BridgeTaskInput = {
            route,
            text: input.text,
            attachments: input.attachments,
            replyToMessageId: input.replyToMessageId,
            raw: input.raw,
        };
        yield* this.streamBusRuntimeEvents({
            taskId: id,
            tenantId,
            startExecution: (runtime) => runtime.engine.startTask({
                task: { id, input: normalizedInput },
                isStreaming: true,
                agentId,
                tenantId,
            }),
        });
    }

    async resume(params: ResumeParams, sink?: RuntimeStreamSink): Promise<ResultPayload> {
        if (sink) {
            return consumeRuntimeStreamAsResult({
                taskId: params.id,
                events: this.resumeStream(params),
                sink,
            });
        }

        const { id, token, input, tenantId = 'default', route } = params;
        const normalizedInput: BridgeTaskInput = {
            route,
            text: input.text,
            attachments: input.attachments,
            replyToMessageId: input.replyToMessageId,
            raw: input.raw
        };
        try { console.info(`[invoker] resume: id=${id} token=${token} tenantId=${tenantId}`); } catch { }

        const { engine, eventBus, taskChannel, wmStore } = await this.getRuntime();

        let effectiveToken = token;
        if (!effectiveToken || effectiveToken === 'opaque') {
            try {
                const events = await wmStore.listEventsSince({ tenantId, sessionId: id, sinceSeq: 0 });
                const last = [...events].reverse().find((event) => event.type === 'task.input_required');
                if (typeof last?.payload?.token === 'string') {
                    effectiveToken = last.payload.token;
                    try { console.info(`[invoker] resume: recovered token=${effectiveToken} for id=${id}`); } catch { }
                }
            } catch (e) {
                try { console.warn(`[invoker] resume: failed to recover token for id=${id}`, e); } catch { }
            }
        }

        // Re-subscribe to streaming to forward replies after resume
        const channel = taskChannel(id);
        try {
            const busAny: any = eventBus as any;
            if (!busAny.__dbgId) busAny.__dbgId = Math.random().toString(36).slice(2);
            console.info(`[invoker] resume:bus channel=${channel} busId=${busAny.__dbgId}`);
        } catch { }
        const forwardState = createStreamForwardState();
        let resolveFn: (r: ResultPayload) => void;
        const done = new Promise<ResultPayload>((resolve) => { resolveFn = resolve; });
        let unsubResume: (() => Promise<void>) | undefined;
        const handler = async (be: BusEvent) => {
            const result = await this.forwardBusEventToChat({ be, route, tenantId, state: forwardState });
            if (result.kind === 'input_required') {
                const recovered = await this.recoverInputToken({ wmStore, tenantId, taskId: id, token: result.token, prompt: result.prompt });
                try { await unsubResume?.(); } catch { }
                resolveFn!({ id, status: 'input_required', token: recovered.token, prompt: recovered.prompt });
            } else if (result.kind === 'failed') {
                try { await unsubResume?.(); } catch { }
                resolveFn!({ id, status: 'failed', error: result.error });
            } else if (result.kind === 'completed') {
                try { await unsubResume?.(); } catch { }
                resolveFn!({ id, status: 'completed', output: result.output });
            }
        };
        const resumeSub = await eventBus.subscribe(channel, handler);
        unsubResume = resumeSub.unsubscribe;

        // Resume input and wait for next status
        await engine.resumeInput({
            tenantId,
            taskId: id,
            token: effectiveToken,
            input: normalizedInput,
            isStreaming: true,
        });
        return done;
    }

    async *resumeStream(params: ResumeParams): AsyncIterable<RuntimeStreamEvent> {
        const { id, token, input, tenantId = 'default', route } = params;
        const runtime = await this.getRuntime();
        let effectiveToken = token;
        if (!effectiveToken || effectiveToken === 'opaque') {
            try {
                const events = await runtime.wmStore.listEventsSince({ tenantId, sessionId: id, sinceSeq: 0 });
                const last = [...events].reverse().find((event) => event.type === 'task.input_required');
                if (typeof last?.payload?.token === 'string') {
                    effectiveToken = last.payload.token;
                }
            } catch {
                /* ignore */
            }
        }
        const normalizedInput: BridgeTaskInput = {
            route,
            text: input.text,
            attachments: input.attachments,
            replyToMessageId: input.replyToMessageId,
            raw: input.raw,
        };
        yield* this.streamBusRuntimeEvents({
            taskId: id,
            tenantId,
            startExecution: (streamRuntime) => streamRuntime.engine.resumeInput({
                tenantId,
                taskId: id,
                token: effectiveToken,
                input: normalizedInput,
                isStreaming: true,
            }),
        });
    }
}

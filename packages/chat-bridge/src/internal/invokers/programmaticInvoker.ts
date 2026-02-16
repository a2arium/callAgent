import { PluginManager, eventBus, taskChannel } from '@a2arium/callagent-core';
import type { BridgeTaskInput, ChatRoute, ChatSender, Invoker, ResultPayload } from '../../types.js';

// Internal types for the invoker
type TaskEngine = any;
type IWorkingMemorySessionStore = any;
type StartParams = { id: string; input: BridgeTaskInput; agentId: string; tenantId?: string; route: ChatRoute };
type ResumeParams = { id: string; token: string; input: BridgeTaskInput; tenantId?: string; route: ChatRoute };

export class ProgrammaticInvoker implements Invoker {
    private static _wmStore: IWorkingMemorySessionStore | undefined;
    private static _engine: TaskEngine | undefined;
    private static _eventBus = eventBus;
    private static _taskChannel = taskChannel;
    private static _initialized = false;

    constructor(private readonly deps: { chatSender: ChatSender; sessionStore?: any }) { }

    private async ensureInitialized() {
        if (ProgrammaticInvoker._initialized) return;
        const [{ TaskEngine, eventBus, taskChannel }, { WorkingMemorySessionStore }] = await Promise.all([
            import('@a2arium/callagent-core' as any),
            import('@a2arium/callagent-memory-sql' as any)
        ] as any);
        ProgrammaticInvoker._wmStore = this.deps.sessionStore ?? new (WorkingMemorySessionStore as any)();
        ProgrammaticInvoker._engine = new TaskEngine({ sessionStore: ProgrammaticInvoker._wmStore });
        ProgrammaticInvoker._eventBus = eventBus;
        ProgrammaticInvoker._taskChannel = taskChannel;
        ProgrammaticInvoker._initialized = true;
    }

    async start(params: StartParams): Promise<ResultPayload> {
        const { id, input, agentId, tenantId = 'default', route } = params;
        const normalizedInput: BridgeTaskInput = {
            route,
            text: input.text,
            attachments: input.attachments,
            replyToMessageId: input.replyToMessageId,
            raw: input.raw
        };
        try { console.info(`[invoker] start: id=${id} agentId=${agentId} tenantId=${tenantId}`); } catch { }
        const effectiveTenantId = 'default';
        // Ensure agent is loaded or discoverable
        if (!PluginManager.findAgent(agentId)) {
            await PluginManager.loadAgentWithDependencies(agentId).catch(() => null);
        }

        await this.ensureInitialized();
        const engine = ProgrammaticInvoker._engine;
        const eventBus = ProgrammaticInvoker._eventBus;
        const taskChannel = ProgrammaticInvoker._taskChannel;
        const wmStore = ProgrammaticInvoker._wmStore;

        // Subscribe to streaming events and forward to chat
        const channel = taskChannel(id);
        try {
            const busAny: any = eventBus as any;
            if (!busAny.__dbgId) busAny.__dbgId = Math.random().toString(36).slice(2);
            console.info(`[invoker] start:bus channel=${channel} busId=${busAny.__dbgId}`);
        } catch { }
        let resolveFn: (r: ResultPayload) => void;
        const done = new Promise<ResultPayload>((resolve) => { resolveFn = resolve; });
        const sendSafe = async (text: string) => {
            try {
                console.info('[invoker] start:sendMessage', { route, text });
                await this.deps.chatSender.sendMessage(route, text);
            } catch (e) {
                try { console.error('[invoker] start:sendMessage error', e); } catch { }
            }
        };
        let lastTyping = 0;
        let aggregatedText = '';

        const handler = async (ev: any) => {
            if (ev?.artifact) {
                const parts = ev.artifact.parts || [];
                // Send text parts
                const text = parts.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('');
                try { console.info('[invoker] start:artifact', { text }); } catch { }
                if (text) { aggregatedText += text; }
                // Send media parts if supported
                for (const p of parts) {
                    if (typeof this.deps.chatSender.sendMedia === 'function' && (p?.type === 'image' || p?.type === 'file' || p?.type === 'audio' || p?.type === 'video')) {
                        const media: any = { type: p.type, url: p.url, bytesBase64: p.bytesBase64, mime: p.mime, filename: p.filename, caption: p.caption };
                        try { await this.deps.chatSender.sendMedia!(route, media); } catch { }
                    }
                    if (p?.type === 'text' && p?.format) {
                        try { await this.deps.chatSender.sendMessage(route, p.text, { parseMode: p.format === 'html' ? 'html' as any : p.format }); } catch { }
                    } else if (p?.type === 'markup' && p?.value) {
                        try { await this.deps.chatSender.sendMarkup!(route, typeof p.value === 'string' ? JSON.parse(p.value) : p.value); } catch { }
                    }
                }
            }
            if (ev?.status) {
                try { console.debug(`[invoker] start:event status=${ev.status?.state} final=${ev.final === true}`); } catch { }
                const st = ev.status;
                // progress/working → typing indicator (throttle)
                if (st?.state === 'working' && typeof this.deps.chatSender.sendTyping === 'function') {
                    const now = Date.now();
                    if (now - lastTyping > 1000) {
                        lastTyping = now;
                        try { await this.deps.chatSender.sendTyping!(route); } catch { }
                    }
                }
                if (st?.state === 'input-required') {
                    let token = st?.metadata?.token as string | undefined;
                    const hadParts = Array.isArray(st?.message?.parts) && (st!.message!.parts!.length > 0);
                    let promptText: string | undefined = hadParts ? undefined : (st?.message?.parts?.[0]?.text as string | undefined) || undefined;
                    if (!token) {
                        try {
                            const events = await wmStore.listEventsSince({ tenantId, sessionId: id, sinceSeq: 0 });
                            const last = [...events].reverse().find((e: any) => e.type === 'task.input_required');
                            token = last?.payload?.token || token;
                            promptText = (last?.payload?.prompt as string | undefined) || promptText;
                        } catch { /* ignore */ }
                    }
                    token = token || 'opaque';
                    eventBus.unsubscribe(channel, handler);
                    try { console.info(`[invoker] start:input_required id=${id} token=${token}`); } catch { }
                    resolveFn!({ id, status: 'input_required', token, prompt: promptText });
                }
                if (st?.state === 'failed' && ev.final === true) {
                    eventBus.unsubscribe(channel, handler);
                    const errMsg = (st?.message?.parts?.[0]?.text) || 'failed';
                    try { console.warn(`[invoker] start:failed id=${id} error=${errMsg}`); } catch { }
                    resolveFn!({ id, status: 'failed', error: errMsg });
                }
                if (st?.state === 'completed' && ev.final === true) {
                    eventBus.unsubscribe(channel, handler);
                    const output = aggregatedText ? { text: aggregatedText } : { ok: true };
                    try { console.info(`[invoker] start:completed id=${id}`); } catch { }
                    resolveFn!({ id, status: 'completed', output });
                }
            }
        };
        eventBus.subscribe(channel, handler);

        // Start task in streaming mode
        try { console.info('[invoker] calling engine.startTask now...'); } catch { }
        await engine.startTask({ task: { id, input: normalizedInput }, isStreaming: true, agentId, tenantId });
        return done;
    }

    async resume(params: ResumeParams): Promise<ResultPayload> {
        const { id, token, input, tenantId = 'default', route } = params;
        const normalizedInput: BridgeTaskInput = {
            route,
            text: input.text,
            attachments: input.attachments,
            replyToMessageId: input.replyToMessageId,
            raw: input.raw
        };
        try { console.info(`[invoker] resume: id=${id} token=${token} tenantId=${tenantId}`); } catch { }

        await this.ensureInitialized();
        const engine = ProgrammaticInvoker._engine;
        const eventBus = ProgrammaticInvoker._eventBus;
        const taskChannel = ProgrammaticInvoker._taskChannel;
        const wmStore = ProgrammaticInvoker._wmStore;

        let effectiveToken = token;
        if (!effectiveToken || effectiveToken === 'opaque') {
            try {
                const events = await wmStore.listEventsSince({ tenantId, sessionId: id, sinceSeq: 0 });
                const last = [...events].reverse().find((e: any) => e.type === 'task.input_required');
                if (last?.payload?.token) {
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
        let lastTyping = 0;
        let aggregatedText = '';
        let resolveFn: (r: ResultPayload) => void;
        const done = new Promise<ResultPayload>((resolve) => { resolveFn = resolve; });
        const sendSafe = async (text: string) => {
            try {
                console.info('[invoker] resume:sendMessage', { route, text });
                await this.deps.chatSender.sendMessage(route, text);
            } catch (e) {
                try { console.error('[invoker] resume:sendMessage error', e); } catch { }
            }
        };
        const handler = async (ev: any) => {
            if (ev?.artifact) {
                const parts = ev.artifact.parts || [];
                const text = parts.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('');
                try { console.info('[invoker] resume:artifact', { text }); } catch { }
                if (text) { aggregatedText += text; }
                for (const p of parts) {
                    // Forward media parts (aligned with start() handler)
                    if (typeof this.deps.chatSender.sendMedia === 'function' && (p?.type === 'image' || p?.type === 'file' || p?.type === 'audio' || p?.type === 'video')) {
                        const media: any = { type: p.type, url: p.url, bytesBase64: p.bytesBase64, mime: p.mime, filename: p.filename, caption: p.caption };
                        try { await this.deps.chatSender.sendMedia!(route, media); } catch { }
                    }
                    if (p?.type === 'text' && p?.format) {
                        try { await this.deps.chatSender.sendMessage(route, p.text, { parseMode: p.format === 'html' ? 'html' as any : p.format }); } catch { }
                    } else if (typeof this.deps.chatSender.sendMarkup === 'function' && p?.type === 'markup' && p?.value) {
                        try { await this.deps.chatSender.sendMarkup!(route, typeof p.value === 'string' ? JSON.parse(p.value) : p.value); } catch { }
                    }
                }
            }
            if (ev?.status) {
                try { console.debug(`[invoker] resume:event status=${ev.status?.state} final=${ev.final === true}`); } catch { }
                const st = ev.status;
                if (st?.state === 'working' && typeof this.deps.chatSender.sendTyping === 'function') {
                    const now = Date.now();
                    if (now - lastTyping > 1000) { lastTyping = now; try { await this.deps.chatSender.sendTyping!(route); } catch { } }
                }
                if (st?.state === 'input-required') {
                    let tkn = st?.metadata?.token as string | undefined;
                    const hadParts = Array.isArray(st?.message?.parts) && (st!.message!.parts!.length > 0);
                    let promptText: string | undefined = hadParts ? undefined : (st?.message?.parts?.[0]?.text as string | undefined) || undefined;
                    // Extract token from event store if not in metadata (aligned with start() handler)
                    if (!tkn) {
                        try {
                            const events = await wmStore.listEventsSince({ tenantId, sessionId: id, sinceSeq: 0 });
                            const last = [...events].reverse().find((e: any) => e.type === 'task.input_required');
                            tkn = last?.payload?.token || tkn;
                            promptText = (last?.payload?.prompt as string | undefined) || promptText;
                        } catch { /* ignore */ }
                    }
                    tkn = tkn || 'opaque';
                    eventBus.unsubscribe(channel, handler);
                    try { console.info(`[invoker] resume:input_required id=${id} token=${tkn}`); } catch { }
                    resolveFn!({ id, status: 'input_required', token: tkn, prompt: promptText });
                }
                if (st?.state === 'failed' && ev.final === true) {
                    eventBus.unsubscribe(channel, handler);
                    const errMsg = (st?.message?.parts?.[0]?.text) || 'failed';
                    try { console.warn(`[invoker] resume:failed id=${id} error=${errMsg}`); } catch { }
                    resolveFn!({ id, status: 'failed', error: errMsg });
                }
                if (st?.state === 'completed' && ev.final === true) {
                    eventBus.unsubscribe(channel, handler);
                    const output = aggregatedText ? { text: aggregatedText } : { ok: true };
                    try { console.info(`[invoker] resume:completed id=${id}`); } catch { }
                    resolveFn!({ id, status: 'completed', output });
                }
            }
        };
        eventBus.subscribe(channel, handler);

        // Resume input and wait for next status
        await engine.resumeInput({ tenantId, taskId: id, token: effectiveToken, input: normalizedInput });
        return done;
    }
}

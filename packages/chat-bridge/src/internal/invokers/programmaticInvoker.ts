import { PluginManager } from '@a2arium/callagent-core';
import type { ChatRoute, ChatSender, Invoker, ResultPayload } from '../../types.js';

type StartParams = { id: string; input: unknown; agentId: string; tenantId?: string; route: ChatRoute };
type ResumeParams = { id: string; token: string; input: unknown; tenantId?: string; route: ChatRoute };

export class ProgrammaticInvoker implements Invoker {
    constructor(private readonly deps: { chatSender: ChatSender }) { }

    async start(params: StartParams): Promise<ResultPayload> {
        const { id, input, agentId, tenantId = 'default', route } = params;
        try { console.info(`[invoker] start: id=${id} agentId=${agentId} tenantId=${tenantId}`); } catch { }
        const effectiveTenantId = 'default';
        // Ensure agent is loaded or discoverable
        if (!PluginManager.findAgent(agentId)) {
            await PluginManager.loadAgentWithDependencies(agentId).catch(() => null);
        }
        // Dynamically import TaskEngine and dependencies to avoid compile-time type coupling
        const [{ TaskEngine, eventBus, taskChannel }, { WorkingMemorySessionStore }] = await Promise.all([
            import('@a2arium/callagent-core' as any),
            import('@a2arium/callagent-memory-sql' as any)
        ] as any);

        const wmStore = new (WorkingMemorySessionStore as any)();
        const engine = new TaskEngine({ sessionStore: wmStore });

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
                    if (typeof this.deps.chatSender.sendMarkup === 'function' && p?.type === 'markup') {
                        try {
                            const m = typeof p.value === 'string' ? JSON.parse(p.value) : p.value;
                            await this.deps.chatSender.sendMarkup!(route, m);
                        } catch { /* ignore malformed */ }
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
                    if (!token) {
                        try {
                            const events = await wmStore.listEventsSince({ tenantId, sessionId: id, sinceSeq: 0 });
                            const last = [...events].reverse().find((e: any) => e.type === 'task.input_required');
                            token = last?.payload?.token || token;
                        } catch { /* ignore */ }
                    }
                    token = token || 'opaque';
                    eventBus.unsubscribe(channel, handler);
                    try { console.info(`[invoker] start:input_required id=${id} token=${token}`); } catch { }
                    resolveFn!({ id, status: 'input_required', token });
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
        await engine.startTask({ task: { id, input }, isStreaming: true, agentId, tenantId });
        return done;
    }

    async resume(params: ResumeParams): Promise<ResultPayload> {
        const { id, token, input, tenantId = 'default', route } = params;
        try { console.info(`[invoker] resume: id=${id} token=${token} tenantId=${tenantId}`); } catch { }
        const [{ TaskEngine, eventBus, taskChannel }, { WorkingMemorySessionStore }] = await Promise.all([
            import('@a2arium/callagent-core' as any),
            import('@a2arium/callagent-memory-sql' as any)
        ] as any);
        const engine = new TaskEngine({ sessionStore: new (WorkingMemorySessionStore as any)() });

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
                    tkn = tkn || 'opaque';
                    eventBus.unsubscribe(channel, handler);
                    try { console.info(`[invoker] resume:input_required id=${id} token=${tkn}`); } catch { }
                    resolveFn!({ id, status: 'input_required', token: tkn });
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
        await engine.resumeInput({ tenantId, taskId: id, token, input });
        return done;
    }
}



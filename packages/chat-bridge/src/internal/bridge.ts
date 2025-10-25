import type {
    AgentSelector,
    Bridge,
    BridgeOptions,
    MessageNormalized,
    SessionRecord,
    SessionState
} from '../types.js';

function now(): number { return Date.now(); }

function keyOf(msg: MessageNormalized): string {
    return `${msg.network}:${msg.conversationId}`;
}

export function createBridge(options: BridgeOptions): Bridge {
    const {
        sessionStore,
        agentSelector,
        chatSender,
        invoker,
        realtime,
        timeouts,
        tenantIdResolver,
        logger,
        metrics
    } = options;

    const inputWaitMs = timeouts?.inputWaitMs ?? 15 * 60_000;

    async function handleIncomingMessage(msg: MessageNormalized): Promise<void> {
        const key = keyOf(msg);
        const route = { network: msg.network, conversationId: msg.conversationId, userId: msg.userId };
        const prev = await sessionStore.get(key);
        logger?.debug('incoming_message', { key, messageId: msg.messageId, hasPrev: !!prev, prevState: prev?.state, prevTaskId: prev?.taskId, prevToken: prev?.token });
        metrics?.incr?.('chat_bridge.inbound', 1, { network: msg.network });

        // Input wait timeout
        if (prev && prev.state === 'waitingInput') {
            const last = prev.lastActivityAt || 0;
            if (Date.now() - last > inputWaitMs) {
                await sessionStore.clear(key);
                logger?.info('input_timeout_cleared', { key });
                metrics?.incr?.('chat_bridge.input_timeout', 1, { network: msg.network });
                await chatSender.sendMessage(route, 'Input window expired. Please start again.');
                return;
            }
        }

        // Idempotency (best-effort)
        if (msg.messageId && sessionStore.wasProcessed) {
            const seen = await sessionStore.wasProcessed(key, msg.messageId);
            if (seen) return;
        }

        // Idempotency: if needed, a separate store should dedupe messageId upstream
        // Here we keep logic focused on routing.

        // Cancel or new command handling (simple heuristic)
        const text = (msg.text || '').trim();
        if (text === '/cancel' || text === '/new') {
            await sessionStore.clear(key);
            logger?.info('session_cleared', { key, cmd: text });
            await chatSender.sendMessage(route, text === '/cancel' ? 'Canceled. You can start a new request.' : 'Started a new request. Please send your message.');
            return;
        }

        // If waiting for input, treat next message as input reply
        if (prev && prev.state === 'waitingInput' && prev.token) {
            logger?.info('resuming_waiting_input', { key, taskId: prev.taskId, token: prev.token });
            try {
                const res = await invoker.resume({
                    id: prev.taskId,
                    token: prev.token,
                    input: toInput(msg),
                    tenantId: (tenantIdResolver ? tenantIdResolver(msg) : msg.network) || 'default',
                    route
                });
                logger?.info('resume_result', { key, status: (res as any)?.status });
                await onResult(key, prev.agentId, res, route);
                return;
            } catch (e) {
                // If WM session/token missing (e.g., after restart), clear and fall back to new task
                logger?.warn('resume_failed_falling_back', { key, error: e instanceof Error ? e.message : String(e) });
                await sessionStore.clear(key).catch(() => { });
            }
        }

        // Start new task
        const agentId = await agentSelector(msg, prev);
        const taskId = generateTaskId(msg);
        // Persist initial session record so durable store knows agent/task
        try {
            await sessionStore.upsert({ key, agentId, taskId, state: 'running', lastActivityAt: now() });
        } catch { }
        logger?.info('starting_new_task', { key, agentId, taskId });
        const res = await invoker.start({
            id: taskId,
            input: toInput(msg),
            agentId,
            tenantId: (tenantIdResolver ? tenantIdResolver(msg) : msg.network) || 'default',
            route
        });
        logger?.info('start_result', { key, status: (res as any)?.status });
        await onResult(key, agentId, res, route);
        if (msg.messageId && sessionStore.markProcessed) {
            await sessionStore.markProcessed(key, msg.messageId).catch(() => { });
        }
    }

    async function onResult(key: string, agentId: string, res: any, route: { network: string; conversationId: string; userId?: string }): Promise<void> {
        const current = await sessionStore.get(key);
        if (!res || typeof res !== 'object' || !('status' in res)) {
            await chatSender.sendMessage(route, 'Unexpected response.');
            await sessionStore.clear(key);
            return;
        }
        if (res.status === 'input_required' && res.token) {
            const nextSeq = (current?.lastEventSeq || 0) + 1;
            const record: SessionRecord = {
                key,
                agentId,
                taskId: res.id,
                state: 'waitingInput',
                token: res.token,
                lastActivityAt: now(),
                lastEventSeq: nextSeq
            };
            await sessionStore.upsert(record);
            logger?.info('input_required', { key, taskId: res.id, token: res.token });
            metrics?.incr?.('chat_bridge.input_required', 1);
            // Only echo a prompt if an explicit non-empty prompt string is provided.
            if (typeof res.prompt === 'string' && res.prompt.trim().length > 0) {
                await chatSender.sendMessage(route, res.prompt);
            }
            // Realtime publish
            if (realtime) {
                await realtime.publish(key, {
                    type: 'input_required',
                    taskId: res.id,
                    seq: nextSeq,
                    ts: new Date().toISOString(),
                    token: res.token,
                    prompt: res.prompt
                } as any);
            }
            return;
        }
        if (res.status === 'completed') {
            // Do not auto-echo JSON output; assume agent streamed replies during execution
            if (typeof res.output === 'string' && res.output.trim().length > 0) {
                await chatSender.sendMessage(route, res.output);
            }
            try { logger?.info('completed', { key }); } catch { }
            logger?.info('completed', { key });
            metrics?.incr?.('chat_bridge.completed', 1);
            if (realtime) {
                const seq = (current?.lastEventSeq || 0) + 1;
                await realtime.publish(key, {
                    type: 'completed',
                    taskId: current?.taskId || '',
                    seq,
                    ts: new Date().toISOString(),
                    output: res.output
                } as any);
            }
            await sessionStore.clear(key);
            return;
        }
        if (res.status === 'failed') {
            await chatSender.sendMessage(route, 'Sorry, something went wrong.');
            logger?.warn('failed', { key });
            metrics?.incr?.('chat_bridge.failed', 1);
            if (realtime) {
                const seq = (current?.lastEventSeq || 0) + 1;
                await realtime.publish(key, {
                    type: 'error',
                    taskId: current?.taskId || '',
                    seq,
                    ts: new Date().toISOString(),
                    message: 'failed'
                } as any);
            }
            await sessionStore.clear(key);
            return;
        }
        // Fallback
        await chatSender.sendMessage(route, 'Unhandled status.');
        await sessionStore.clear(key);
    }

    function toInput(msg: MessageNormalized): unknown {
        return {
            text: msg.text,
            attachments: msg.attachments
        };
    }

    function generateTaskId(msg: MessageNormalized): string {
        return `${msg.network}-${msg.conversationId}-${Date.now()}`;
    }

    return {
        handleIncomingMessage
    };
}

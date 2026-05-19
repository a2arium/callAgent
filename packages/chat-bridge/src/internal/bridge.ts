import type {
    AgentSelector,
    Bridge,
    BridgeOptions,
    BridgeTaskInput,
    ChatEvent,
    MessageNormalized,
    ResultPayload,
    RuntimeStreamSink,
    SessionRecord,
    ChatRoute
} from '../types.js';
import {
    projectRuntimeStreamChat,
    type RuntimeStreamEvent,
    type RuntimeStreamMessagePart,
} from '@a2arium/callagent-core';
import {
    createStreamForwardState,
    forwardChatProjectionEvent,
} from './invokers/chatProjectionForwarder.js';

function now(): number { return Date.now(); }

function keyOf(msg: MessageNormalized): string {
    return `${msg.network}:${msg.conversationId}`;
}

type StreamSinkState = {
    inputRequiredPublished: boolean;
    terminalPublished: boolean;
};

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
                const streamSink = createBridgeStreamSink(key, route, currentSinkState());
                const res = await invoker.resume({
                    id: prev.taskId,
                    token: prev.token,
                    input: toInput(msg, route),
                    tenantId: (tenantIdResolver ? tenantIdResolver(msg) : msg.network) || 'default',
                    route
                }, streamSink.sink);
                logger?.info('resume_result', { key, status: resultStatus(res) });
                await onResult(key, prev.agentId, res, route, streamSink.state);
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
        const streamSink = createBridgeStreamSink(key, route, currentSinkState());
        const res = await invoker.start({
            id: taskId,
            input: toInput(msg, route),
            agentId,
            tenantId: (tenantIdResolver ? tenantIdResolver(msg) : msg.network) || 'default',
            route
        }, streamSink.sink);
        logger?.info('start_result', { key, status: resultStatus(res) });
        await onResult(key, agentId, res, route, streamSink.state);
        if (msg.messageId && sessionStore.markProcessed) {
            await sessionStore.markProcessed(key, msg.messageId).catch(() => { });
        }
    }

    function currentSinkState(): StreamSinkState {
        return {
            inputRequiredPublished: false,
            terminalPublished: false,
        };
    }

    function createBridgeStreamSink(
        key: string,
        route: ChatRoute,
        state: StreamSinkState
    ): { sink: RuntimeStreamSink; state: StreamSinkState } {
        const forwardState = createStreamForwardState();
        const sink: RuntimeStreamSink = async (event) => {
            for (const chatEvent of projectRuntimeStreamChat([event])) {
                await forwardChatProjectionEvent({
                    sender: chatSender,
                    route,
                    state: forwardState,
                    event: chatEvent,
                });
            }

            if (!realtime) return;
            for (const chatEvent of projectRuntimeEventToRealtimeEvents(event)) {
                if (chatEvent.type === 'input_required') {
                    state.inputRequiredPublished = true;
                }
                if (chatEvent.type === 'completed' || chatEvent.type === 'error') {
                    state.terminalPublished = true;
                }
                await realtime.publish(key, chatEvent);
            }
        };

        return { sink, state };
    }

    async function onResult(
        key: string,
        agentId: string,
        res: unknown,
        route: { network: string; conversationId: string; userId?: string },
        streamState: StreamSinkState = currentSinkState()
    ): Promise<void> {
        const current = await sessionStore.get(key);
        if (!isResultPayload(res)) {
            await chatSender.sendMessage(route, 'Unexpected response.');
            await sessionStore.clear(key);
            return;
        }
        if (res.status === 'input_required' && res.token.length > 0) {
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
            const prompt = typeof res.prompt === 'string' ? res.prompt : undefined;
            if (typeof prompt === 'string' && prompt.trim().length > 0) {
                await chatSender.sendMessage(route, prompt);
            }
            // Realtime publish
            if (realtime && !streamState.inputRequiredPublished) {
                await realtime.publish(key, {
                    type: 'input_required',
                    taskId: record.taskId,
                    seq: nextSeq,
                    ts: new Date().toISOString(),
                    token: res.token,
                    prompt
                });
            }
            return;
        }
        if (res.status === 'completed') {
            // Do not auto-echo JSON output; assume agent streamed replies during execution
            const output = res.output;
            if (typeof output === 'string' && output.trim().length > 0) {
                await chatSender.sendMessage(route, output);
            }
            try { logger?.info('completed', { key }); } catch { }
            logger?.info('completed', { key });
            metrics?.incr?.('chat_bridge.completed', 1);
            if (realtime && !streamState.terminalPublished) {
                const seq = (current?.lastEventSeq || 0) + 1;
                await realtime.publish(key, {
                    type: 'completed',
                    taskId: res.id,
                    seq,
                    ts: new Date().toISOString(),
                    output
                });
            }
            await sessionStore.clear(key);
            return;
        }
        if (res.status === 'failed') {
            await chatSender.sendMessage(route, 'Sorry, something went wrong.');
            logger?.warn('failed', { key });
            metrics?.incr?.('chat_bridge.failed', 1);
            if (realtime && !streamState.terminalPublished) {
                const seq = (current?.lastEventSeq || 0) + 1;
                await realtime.publish(key, {
                    type: 'error',
                    taskId: res.id,
                    seq,
                    ts: new Date().toISOString(),
                    message: 'error' in res && typeof res.error === 'string' ? res.error : 'failed'
                });
            }
            await sessionStore.clear(key);
            return;
        }
        // Fallback
        await chatSender.sendMessage(route, 'Unhandled status.');
        await sessionStore.clear(key);
    }

    function toInput(msg: MessageNormalized, route: ChatRoute): BridgeTaskInput {
        return {
            route,
            text: msg.text,
            attachments: msg.attachments,
            replyToMessageId: msg.replyToMessageId,
            raw: msg.raw
        };
    }

    function generateTaskId(msg: MessageNormalized): string {
        return `${msg.network}-${msg.conversationId}-${Date.now()}`;
    }

    return {
        handleIncomingMessage
    };
}

function projectRuntimeEventToRealtimeEvents(event: RuntimeStreamEvent): ChatEvent[] {
    if (event.visibility !== 'public') return [];

    if (event.type === 'task.status') {
        if (event.data.state === 'working') {
            const progress = event.data.metadata?.progress;
            const statusText = textFromParts(event.data.message?.parts) ?? event.data.state;
            return [{
                type: 'progress',
                taskId: event.taskId,
                seq: event.seq,
                ts: event.ts,
                ...(typeof progress === 'number' ? { pct: progress } : {}),
                status: statusText,
            }];
        }

        if (event.data.state === 'completed' && event.data.terminal) {
            return [{ type: 'completed', taskId: event.taskId, seq: event.seq, ts: event.ts }];
        }

        if ((event.data.state === 'failed' || event.data.state === 'canceled') && event.data.terminal) {
            return [{
                type: 'error',
                taskId: event.taskId,
                seq: event.seq,
                ts: event.ts,
                message: textFromParts(event.data.message?.parts) ?? event.data.state,
            }];
        }

        return [];
    }

    if (event.type === 'artifact.delta' || event.type === 'message.output') {
        const projected: ChatEvent[] = [];
        for (const part of event.data.parts) {
            if (part.type === 'text') {
                projected.push({
                    type: 'reply',
                    taskId: event.taskId,
                    seq: event.seq,
                    ts: event.ts,
                    text: part.text,
                });
                continue;
            }
            if (part.type === 'image' || part.type === 'file' || part.type === 'audio' || part.type === 'video') {
                projected.push({
                    type: 'media',
                    taskId: event.taskId,
                    seq: event.seq,
                    ts: event.ts,
                    media: {
                        type: part.type,
                        url: part.url,
                        bytesBase64: part.bytesBase64,
                        mime: part.mime,
                        filename: part.filename,
                        caption: part.caption,
                    },
                });
            }
        }
        return projected;
    }

    if (event.type === 'input.required') {
        return [{
            type: 'input_required',
            taskId: event.taskId,
            seq: event.seq,
            ts: event.ts,
            token: event.data.token,
            prompt: textFromParts(event.data.parts),
        }];
    }

    return [];
}

function textFromParts(parts: readonly RuntimeStreamMessagePart[] | undefined): string | undefined {
    const text = parts
        ?.filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim();
    return text && text.length > 0 ? text : undefined;
}

function resultStatus(result: unknown): string | undefined {
    if (!result || typeof result !== 'object' || !('status' in result)) {
        return undefined;
    }
    return typeof result.status === 'string' ? result.status : undefined;
}

function isResultPayload(result: unknown): result is ResultPayload {
    if (!result || typeof result !== 'object' || !('id' in result) || !('status' in result)) {
        return false;
    }
    if (typeof result.id !== 'string' || typeof result.status !== 'string') {
        return false;
    }
    if (result.status === 'completed') {
        return 'output' in result;
    }
    if (result.status === 'failed') {
        return 'error' in result && typeof result.error === 'string';
    }
    if (result.status === 'input_required') {
        return 'token' in result && typeof result.token === 'string';
    }
    return false;
}

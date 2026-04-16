import type { EnvironmentState, MemoryReader, Observation } from '@a2arium/callagent-core';
import type { Obs } from './types.js';
import { DEMO_THREAD_ID } from './types.js';

function firstConversationDelivery(env: EnvironmentState): Obs | undefined {
    for (const obs of env.inbox.current) {
        const o = obs as Observation;
        if (o.source !== 'conversation' || o.kind !== 'message.received') {
            continue;
        }
        const payload = o.payload as {
            kind?: string;
            message?: { id?: string; conversation?: { id?: string }; sequenceNumber?: number };
        };
        if (payload?.kind !== 'message.received' || !payload.message?.conversation?.id) {
            continue;
        }
        const threadId = payload.message.conversation.id;
        if (threadId !== DEMO_THREAD_ID) {
            continue;
        }
        const inboundMessageId = typeof payload.message.id === 'string' ? payload.message.id : undefined;
        return {
            kind: 'conversation_delivery',
            threadId,
            sequenceNumber: payload.message.sequenceNumber ?? 0,
            ...(inboundMessageId ? { inboundMessageId } : {}),
        };
    }
    return undefined;
}

export function perception(env: EnvironmentState, _alpha: unknown, _mem: MemoryReader): Obs {
    const conv = firstConversationDelivery(env);
    if (conv) {
        return conv;
    }
    const opened = env.inbox.current.find(
        (o) =>
            o.source === 'internal' &&
            o.kind === 'state.noted' &&
            typeof (o.payload as { phase?: unknown } | undefined)?.phase === 'string' &&
            (o.payload as { phase?: string }).phase === 'thread_opened'
    );
    if (opened) {
        const payload = opened.payload as { threadId?: unknown };
        if (typeof payload.threadId === 'string' && payload.threadId.length > 0) {
            const openOutboundMessageId =
                typeof (payload as { openOutboundMessageId?: unknown }).openOutboundMessageId === 'string'
                    ? (payload as { openOutboundMessageId: string }).openOutboundMessageId
                    : undefined;
            const openOutboundSequence =
                typeof (payload as { openOutboundSequence?: unknown }).openOutboundSequence === 'number'
                    ? (payload as { openOutboundSequence: number }).openOutboundSequence
                    : undefined;
            return {
                kind: 'thread_opened',
                threadId: payload.threadId,
                ...(openOutboundMessageId ? { openOutboundMessageId } : {}),
                ...(openOutboundSequence !== undefined ? { openOutboundSequence } : {}),
            };
        }
    }
    const userObs = env.inbox.current.find((o) => o.source === 'user' && o.kind === 'input.provided');
    if (!userObs) {
        return { kind: 'idle' };
    }
    const payload = userObs.payload as { value?: unknown };
    const v = payload?.value;
    const text =
        typeof v === 'string'
            ? v
            : v && typeof v === 'object' && v !== null && 'text' in v
              ? String((v as { text: unknown }).text)
              : undefined;
    if (!text) {
        return { kind: 'idle' };
    }
    return { kind: 'user_message', text };
}

import type { RuntimeStreamChatProjectionEvent } from '@a2arium/callagent-core';
import type { Attachment, ChatRoute, ChatSender, Markup } from '../../types.js';

export type StreamForwardState = {
    lastTyping: number;
    aggregatedText: string;
};

export type ForwardedStreamResult =
    | { kind: 'continue' }
    | { kind: 'input_required'; token: string; prompt?: string }
    | { kind: 'failed'; error: string }
    | { kind: 'completed'; output: unknown };

export function createStreamForwardState(): StreamForwardState {
    return { lastTyping: 0, aggregatedText: '' };
}

function isSendableMediaPart(part: RuntimeStreamChatProjectionEvent & { type: 'media' }): part is RuntimeStreamChatProjectionEvent & {
    type: 'media';
    media: Attachment & { caption?: string };
} {
    return part.media.type === 'image'
        || part.media.type === 'file'
        || part.media.type === 'audio'
        || part.media.type === 'video';
}

function parseMarkupValue(value: unknown): Markup | undefined {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || !('kind' in parsed)) {
        return undefined;
    }
    return parsed as Markup;
}

export async function forwardChatProjectionEvent(params: {
    sender: ChatSender;
    route: ChatRoute;
    state: StreamForwardState;
    event: RuntimeStreamChatProjectionEvent;
    now?: () => number;
}): Promise<ForwardedStreamResult> {
    const { sender, route, state, event, now = Date.now } = params;

    if (event.type === 'typing') {
        if (typeof sender.sendTyping === 'function') {
            const timestamp = now();
            if (timestamp - state.lastTyping > 1000) {
                state.lastTyping = timestamp;
                try { await sender.sendTyping(route); } catch { }
            }
        }
        return { kind: 'continue' };
    }

    if (event.type === 'message') {
        state.aggregatedText += event.text;
        try {
            await sender.sendMessage(route, event.text, event.parseMode ? { parseMode: event.parseMode } : undefined);
        } catch { }
        return { kind: 'continue' };
    }

    if (event.type === 'media' && typeof sender.sendMedia === 'function' && isSendableMediaPart(event)) {
        try { await sender.sendMedia(route, event.media); } catch { }
        return { kind: 'continue' };
    }

    if (event.type === 'markup' && typeof sender.sendMarkup === 'function') {
        try {
            const markup = parseMarkupValue(event.value);
            if (markup) {
                await sender.sendMarkup(route, markup);
            }
        } catch { }
        return { kind: 'continue' };
    }

    if (event.type === 'input_required') {
        return { kind: 'input_required', token: event.token, prompt: event.prompt };
    }

    if (event.type === 'error') {
        return { kind: 'failed', error: event.message };
    }

    if (event.type === 'completed') {
        return {
            kind: 'completed',
            output: state.aggregatedText ? { text: state.aggregatedText } : { ok: true },
        };
    }

    return { kind: 'continue' };
}

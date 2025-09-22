import type { ChatRoute, ChatSender, Markup, MessageNormalized, Network } from '../types.js';

/** Minimal CallMessenger surface we rely on */
export type MinimalCallMessenger = {
    send: (conversationId: string, markup: Markup) => Promise<void>;
};

/** Create a ChatSender backed by callMessenger */
export function createCallMessengerChatSender(cm: MinimalCallMessenger): ChatSender {
    return {
        async sendMessage(route: ChatRoute, text: string, _opts?: { parseMode?: 'plain' | 'markdown' }) {
            // Prefer HTML; consumers can adjust parsing rules inside callMessenger
            const markup: Markup = { kind: 'text', html: text };
            await cm.send(`${route.network}:${route.conversationId}`, markup);
        },
        async sendTyping(_route: ChatRoute) {
            // No-op for now; callMessenger can simulate typing per channel in the future
        },
        async sendMedia(route: ChatRoute, media: any) {
            // Map images; fallback to text notice for other types for now
            if (media?.type === 'image') {
                const markup: Markup = {
                    kind: 'image',
                    url: media.url,
                    base64: media.bytesBase64,
                    caption: media.caption
                };
                await cm.send(`${route.network}:${route.conversationId}`, markup);
                return;
            }
            // Basic mappings for file/audio/video: send a button/link fallback or a notice
            if (media?.type === 'file' && media.url) {
                const markup: Markup = {
                    kind: 'buttons',
                    prompt: media.caption || 'File available:',
                    buttons: [{ title: media.filename || 'Download file', payload: { action: 'open_url', url: media.url } }]
                };
                await cm.send(`${route.network}:${route.conversationId}`, markup);
                return;
            }
            if ((media?.type === 'audio' || media?.type === 'video') && media.url) {
                const markup: Markup = { kind: 'text', html: `${media.type === 'audio' ? 'Audio' : 'Video'}: <a href="${media.url}">${media.filename || 'Open'}</a>` };
                await cm.send(`${route.network}:${route.conversationId}`, markup);
                return;
            }
            const notice: Markup = { kind: 'text', html: 'Unsupported media type in this channel.' };
            await cm.send(`${route.network}:${route.conversationId}`, notice);
        },
        async sendMarkup(route: ChatRoute, markup: Markup) {
            // Minimal runtime validation of markup
            if (!markup || typeof markup !== 'object' || !('kind' in markup)) {
                await cm.send(`${route.network}:${route.conversationId}`, { kind: 'text', html: 'Unsupported content.' });
                return;
            }
            await cm.send(`${route.network}:${route.conversationId}`, markup);
        }
    };
}

/**
 * Normalize a callMessenger inbound event to MessageNormalized for chat-bridge.
 * Expects event shape per callMessenger docs: { type, conversationId, channel, message?, payload? }
 */
export function normalizeFromCallMessengerEvent(e: any): MessageNormalized | null {
    if (!e) return null;
    const channel = (e.channel as Network) || e.network || deriveChannelFromConversation(e.conversationId);
    if (!channel) return null;
    const conv = stripChannelPrefix(e.conversationId);
    const messageId = String(
        e.message?.message_id || e.update_id || e.id || Date.now()
    );
    const base: MessageNormalized = {
        network: channel,
        conversationId: conv,
        userId: e.userId,
        messageId,
        text: undefined,
        attachments: []
    };

    // Standard inbound from adapters
    if (e.type === 'message.received' && e.message) {
        if (typeof e.message.text === 'string') base.text = e.message.text;
        else if (typeof e.message.html === 'string') base.text = e.message.html;
        if (e.message.type === 'image') {
            base.attachments?.push({ type: 'image', url: e.message.url, bytesBase64: (e.message as any).base64 });
        }
        if (e.message.type === 'location') {
            base.text = base.text || `${e.message.name || 'Location'} (${e.message.lat}, ${e.message.lng})`;
        }
        return base;
    }

    // Already-mapped CM events (createCallMessenger on('message.received') mapping)
    if (e.type === undefined && (typeof e.text === 'string' || e.payload !== undefined) && e.network && e.conversationId) {
        base.text = typeof e.text === 'string' ? e.text : JSON.stringify(e.payload ?? {});
        return base;
    }

    if (e.type === 'button.clicked') {
        base.text = JSON.stringify(e.payload ?? {});
        return base;
    }

    return null;
}

function deriveChannelFromConversation(conversationId?: string): Network | null {
    if (!conversationId) return null;
    const idx = conversationId.indexOf(':');
    return (idx > 0 ? conversationId.slice(0, idx) : '') as Network;
}

function stripChannelPrefix(conversationId?: string): string {
    if (!conversationId) return '';
    const idx = conversationId.indexOf(':');
    return idx > 0 ? conversationId.slice(idx + 1) : conversationId;
}

/**
 * Convenience helper: constructs a bridge using callMessenger and auto-wires event listeners.
 */
export function createBridgeForCallMessenger(
    cm: MinimalCallMessenger & { on: (event: string, handler: (e: any) => void) => void },
    createBridgeFn: (opts: { chatSender: ReturnType<typeof createCallMessengerChatSender> }) => { handleIncomingMessage: (m: MessageNormalized) => Promise<void> }
): { unsubscribe: () => void } {
    const chatSender = createCallMessengerChatSender(cm);
    const bridge = createBridgeFn({ chatSender });
    const onMessage = async (e: any) => {
        const m = normalizeFromCallMessengerEvent(e);
        if (m) await bridge.handleIncomingMessage(m);
    };
    cm.on('message.received', onMessage);
    cm.on('button.clicked', onMessage);
    return { unsubscribe: () => { /* callMessenger core can expose off() in future */ } };
}



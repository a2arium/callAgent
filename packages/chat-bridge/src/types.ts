export type Network = 'telegram' | 'slack' | 'web' | string;

export type Attachment = {
    type: 'image' | 'file' | 'audio' | 'video' | 'location' | 'other';
    url?: string;
    bytesBase64?: string;
    mime?: string;
    filename?: string;
    width?: number;
    height?: number;
    durationMs?: number;
};

// Unified markup for multi-channel chat (object or JSON string)
export type TextMarkup = {
    kind: 'text';
    html?: string;
    markdown?: string;
};

export type ImageMarkup = {
    kind: 'image';
    url?: string;
    base64?: string;
    caption?: string;
};

export type LocationMarkup = {
    kind: 'location';
    lat: number;
    lng: number;
    name?: string;
    address?: string;
};

export type ButtonsMarkup = {
    kind: 'buttons';
    prompt?: string;
    buttons: Array<{ title: string; payload: unknown }>;
};

export type Markup = TextMarkup | ImageMarkup | LocationMarkup | ButtonsMarkup;

export type MessageNormalized = {
    network: Network;
    conversationId: string;
    userId?: string;
    messageId: string;
    text?: string;
    attachments?: Attachment[];
    replyToMessageId?: string;
    raw?: unknown;
};

export type ChatRoute = { network: Network; conversationId: string; userId?: string };

export type ChatSender = {
    sendMessage(route: ChatRoute, text: string, options?: { parseMode?: 'plain' | 'markdown' | 'html' }): Promise<void>;
    sendTyping?(route: ChatRoute): Promise<void>;
    sendMedia?(route: ChatRoute, media: Attachment & { caption?: string }): Promise<void>;
    sendMarkup?(route: ChatRoute, markup: Markup): Promise<void>;
};

export type SessionState = 'idle' | 'running' | 'waitingInput';

export type SessionRecord = {
    key: string;
    agentId: string;
    taskId: string;
    state: SessionState;
    token?: string;
    lastEventSeq?: number;
    lastActivityAt: number;
};

export type SessionStore = {
    get(key: string): Promise<SessionRecord | null>;
    upsert(rec: SessionRecord): Promise<void>;
    clear(key: string): Promise<void>;
    // Optional idempotency helpers
    markProcessed?: (key: string, messageId: string) => Promise<void>;
    wasProcessed?: (key: string, messageId: string) => Promise<boolean>;
};

export type AgentSelector = (msg: MessageNormalized, current: SessionRecord | null) => Promise<string>;

export type ChatEvent =
    | { type: 'reply'; taskId: string; seq: number; ts: string; text: string }
    | { type: 'progress'; taskId: string; seq: number; ts: string; pct?: number; status?: string }
    | { type: 'input_required'; taskId: string; seq: number; ts: string; token: string; prompt?: string }
    | { type: 'completed'; taskId: string; seq: number; ts: string; output?: unknown }
    | { type: 'error'; taskId: string; seq: number; ts: string; code?: string; message: string }
    | { type: 'media'; taskId: string; seq: number; ts: string; media: Attachment & { caption?: string } };

export type RealtimePublisher = { publish: (channelKey: string, event: ChatEvent) => Promise<void> };

export type ResultPayload =
    | { id: string; status: 'completed'; output: unknown }
    | { id: string; status: 'failed'; error: string }
    | { id: string; status: 'input_required'; token: string; prompt?: string };

export type Invoker = {
    start: (params: { id: string; input: unknown; agentId: string; tenantId?: string; route: ChatRoute }) => Promise<ResultPayload>;
    resume: (params: { id: string; token: string; input: unknown; tenantId?: string; route: ChatRoute }) => Promise<ResultPayload>;
};

export type BridgeOptions = {
    sessionStore: SessionStore;
    agentSelector: AgentSelector;
    chatSender: ChatSender;
    invoker: Invoker;
    realtime?: RealtimePublisher;
    timeouts?: { inputWaitMs?: number; typingThrottleMs?: number };
    tenantIdResolver?: (msg: MessageNormalized) => string;
    logger?: {
        debug: (msg: string, meta?: Record<string, unknown>) => void;
        info: (msg: string, meta?: Record<string, unknown>) => void;
        warn: (msg: string, meta?: Record<string, unknown>) => void;
        error: (msg: string, meta?: Record<string, unknown>) => void;
    };
    metrics?: {
        incr: (name: string, value?: number, tags?: Record<string, string>) => void;
        observe?: (name: string, value: number, tags?: Record<string, string>) => void;
    };
};

export type Bridge = {
    handleIncomingMessage(msg: MessageNormalized): Promise<void>;
};


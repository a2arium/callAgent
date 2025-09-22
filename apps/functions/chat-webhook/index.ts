import { createBridge, ProgrammaticInvoker, PrismaSessionStore, getChatPrismaClient } from '@a2arium/callagent-chat-bridge';
import type { BridgeOptions, MessageNormalized } from '@a2arium/callagent-chat-bridge';

// Session mapping store for conversations (Prisma-backed)
const sessionStore = new PrismaSessionStore(getChatPrismaClient());

const agentSelector = async () => 'orchestrator-agent';

const chatSender = {
    async sendMessage() { },
    async sendTyping() { },
    async sendMedia() { }
} as BridgeOptions['chatSender'];

// Minimal working memory session store for TaskEngine demo
// Define a local type to avoid cross-package build-time dependency
export type WorkingMemorySessionStore = {
    getSessionSnapshot: (tenantId: string, sessionId: string) => Promise<{ wmVersion: bigint; snapshot: Record<string, unknown>; agentId: string; updatedAt: string } | null>;
    writeSnapshotCAS: (params: { tenantId: string; sessionId: string; agentId: string; expectedWmVersion: bigint; snapshot: Record<string, unknown> }) => Promise<{ newVersion: bigint }>;
    appendEvent: (params: { tenantId: string; sessionId: string; type: string; payload: Record<string, unknown> }) => Promise<{ eventId: string; seq: number }>;
    listEventsSince: (params: { tenantId: string; sessionId: string; sinceSeq: number }) => Promise<Array<{ eventId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string }>>;
    enqueueOutbox: (params: { tenantId: string; topic: string; key: string; payload: Record<string, unknown> }) => Promise<void>;
};

const wmStore: WorkingMemorySessionStore = {
    async getSessionSnapshot() { return { wmVersion: BigInt(0), snapshot: {}, agentId: 'default', updatedAt: new Date().toISOString() }; },
    async writeSnapshotCAS() { return { newVersion: BigInt(0) }; },
    async appendEvent() { return { eventId: '0', seq: 0 }; },
    async listEventsSince() { return []; },
    async enqueueOutbox() { }
};

const invoker = new ProgrammaticInvoker({ sessionStore: wmStore as any, chatSender });

const logger = {
    debug: (msg: string, meta?: Record<string, unknown>) => console.debug(`[bridge] ${msg}`, meta || {}),
    info: (msg: string, meta?: Record<string, unknown>) => console.info(`[bridge] ${msg}`, meta || {}),
    warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`[bridge] ${msg}`, meta || {}),
    error: (msg: string, meta?: Record<string, unknown>) => console.error(`[bridge] ${msg}`, meta || {})
};
const metrics = {
    incr: (_name: string, _value: number = 1, _tags?: Record<string, string>) => { /* hook into your metrics here */ },
    observe: (_name: string, _value: number, _tags?: Record<string, string>) => { /* histogram hook */ }
};

const bridge = createBridge({ sessionStore, agentSelector, chatSender, invoker, logger, metrics });

export async function handler(event: { body?: string }): Promise<{ statusCode: number; body: string }> {
    try {
        const body = event.body ? JSON.parse(event.body) : {};
        const messages: MessageNormalized[] = Array.isArray(body) ? body : [body];
        for (const msg of messages) {
            await bridge.handleIncomingMessage(msg);
        }
        return { statusCode: 200, body: 'OK' };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { statusCode: 500, body: message };
    }
}


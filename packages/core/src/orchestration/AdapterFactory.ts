import { z } from 'zod';
import { createInMemoryEventBus } from '../eventbus/inMemoryEventBus.js';
import { createDbMessageLog } from '../eventbus/dbMessageLog.js';
import { createInProcessDurableSubscription } from '../eventbus/inProcessDurableSubscription.js';
import type { DurableSubscriptionPersistence } from '../eventbus/inProcessDurableSubscription.js';
import type { IEventBus } from '../public-types/eventbus/types.js';
import type { MessageLog } from '../public-types/messageLog/types.js';
import type { DurableSubscription } from '../public-types/messageLog/durableSubscription.types.js';
import { AdapterErrorThrowable } from '../public-types/eventbus/error.js';
import type { SessionManager } from './SessionManager.js';

const NatsClusterSchema = z.object({
    servers: z.array(z.string()).min(1),
});

export const EventBusAdapterConfigSchema = z.discriminatedUnion('adapter', [
    z.object({ adapter: z.literal('in-memory') }),
    z.object({
        adapter: z.literal('nats'),
        nats: NatsClusterSchema,
    }),
]);

export const MessageLogAdapterConfigSchema = z.discriminatedUnion('adapter', [
    z.object({ adapter: z.literal('in-memory') }),
    z.object({ adapter: z.literal('database') }),
    z.object({
        adapter: z.literal('nats'),
        nats: NatsClusterSchema.extend({
            stream: z.string().min(1).optional(),
            idempotencyKvBucket: z.string().min(1).optional(),
        }),
    }),
]);

export const TransportAdapterConfigSchema = z.object({
    eventBus: EventBusAdapterConfigSchema.optional(),
    messageLog: MessageLogAdapterConfigSchema.optional(),
});

export type TransportAdapterConfig = z.infer<typeof TransportAdapterConfigSchema>;
export type EventBusAdapterConfig = z.infer<typeof EventBusAdapterConfigSchema>;
export type MessageLogAdapterConfig = z.infer<typeof MessageLogAdapterConfigSchema>;

export type ResolvedTransportAdapters = {
    eventBus: IEventBus;
    /** Inner message log (without topic-stream wrapper). TaskEngine wraps with `wrapMessageLogWithTopicStream`. */
    messageLog: MessageLog;
    createDurableSubscription: (ctx: {
        tenantId: string;
        persistence: DurableSubscriptionPersistence;
    }) => DurableSubscription;
    close?: () => Promise<void>;
};

function isModuleNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== 'object') {
        return false;
    }
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
}

type NatsTransportModule = {
    createNatsTransportAdapters: (opts: {
        servers: string[];
        streamName?: string;
        idempotencyKvBucket?: string;
    }) => Promise<{
        eventBus: IEventBus;
        messageLog: MessageLog;
        close: () => Promise<void>;
    }>;
    createNatsJetStreamEventBusStandalone: (opts: { servers: string[] }) => Promise<{
        eventBus: IEventBus;
        close: () => Promise<void>;
    }>;
};

async function loadNatsModule(): Promise<NatsTransportModule> {
    try {
        /** Non-literal specifier so `tsc` does not pull workspace sources into the core program graph. */
        const pkg = `@a2arium/${'callagent-eventbus-nats'}`;
        return (await import(pkg)) as NatsTransportModule;
    } catch (err) {
        if (isModuleNotFoundError(err)) {
            throw new AdapterErrorThrowable({
                kind: 'AdapterNotInstalled',
                adapterId: 'nats',
                packageName: '@a2arium/callagent-eventbus-nats',
            });
        }
        throw err;
    }
}

function defaultCreateDurableSubscription(deps: {
    messageLog: MessageLog;
    eventBus: IEventBus;
}): (ctx: { tenantId: string; persistence: DurableSubscriptionPersistence }) => DurableSubscription {
    return (ctx) =>
        createInProcessDurableSubscription({
            tenantId: ctx.tenantId,
            messageLog: deps.messageLog,
            eventBus: deps.eventBus,
            persistence: ctx.persistence,
        });
}

function assertCompatiblePair(
    eventBusCfg: EventBusAdapterConfig,
    messageLogCfg: MessageLogAdapterConfig
): void {
    if (messageLogCfg.adapter === 'nats' && eventBusCfg.adapter !== 'nats') {
        throw new AdapterErrorThrowable({
            kind: 'AdapterConfigInvalid',
            adapterId: 'transport',
            issues: [
                'messageLog.adapter "nats" requires eventBus.adapter "nats" so topic stream notifications and durable replay share the broker.',
            ],
        });
    }
}

function toConnectError(e: unknown): AdapterErrorThrowable {
    if (e instanceof AdapterErrorThrowable) {
        return e;
    }
    const cause = e instanceof Error ? e.message : String(e);
    return new AdapterErrorThrowable({
        kind: 'AdapterConnectFailed',
        adapterId: 'nats',
        cause,
    });
}

const KNOWN_EVENT_BUS_ADAPTERS = new Set(['in-memory', 'nats']);
const KNOWN_MESSAGE_LOG_ADAPTERS = new Set(['in-memory', 'database', 'nats']);

/**
 * Rejects adapter ids that are syntactically present but not in the registry (5.4c.3),
 * before Zod turns them into a generic config error.
 */
function throwIfUnknownAdapterTransport(raw: unknown): void {
    if (raw === null || typeof raw !== 'object') {
        return;
    }
    const root = raw as Record<string, unknown>;
    const eb = root.eventBus;
    if (eb !== null && typeof eb === 'object' && 'adapter' in eb) {
        const a = (eb as { adapter?: unknown }).adapter;
        if (typeof a === 'string' && !KNOWN_EVENT_BUS_ADAPTERS.has(a)) {
            throw new AdapterErrorThrowable({
                kind: 'AdapterUnknown',
                adapterId: a,
            });
        }
    }
    const ml = root.messageLog;
    if (ml !== null && typeof ml === 'object' && 'adapter' in ml) {
        const a = (ml as { adapter?: unknown }).adapter;
        if (typeof a === 'string' && !KNOWN_MESSAGE_LOG_ADAPTERS.has(a)) {
            throw new AdapterErrorThrowable({
                kind: 'AdapterUnknown',
                adapterId: a,
            });
        }
    }
}

/**
 * Resolves transport adapters from an optional config bag. Defaults match single-process installs:
 * in-memory event bus + database-backed message log (`SessionManager`).
 */
export async function resolveTransportAdapters(params: {
    transport?: unknown;
    sessionManager: SessionManager;
}): Promise<ResolvedTransportAdapters> {
    throwIfUnknownAdapterTransport(params.transport ?? {});
    const parsedRoot = TransportAdapterConfigSchema.safeParse(params.transport ?? {});
    if (!parsedRoot.success) {
        throw new AdapterErrorThrowable({
            kind: 'AdapterConfigInvalid',
            adapterId: 'transport',
            issues: parsedRoot.error.issues.map((i) => i.message),
        });
    }

    const eventBusCfg: EventBusAdapterConfig = parsedRoot.data.eventBus ?? { adapter: 'in-memory' };
    const messageLogCfg: MessageLogAdapterConfig = parsedRoot.data.messageLog ?? { adapter: 'database' };

    assertCompatiblePair(eventBusCfg, messageLogCfg);

    if (eventBusCfg.adapter === 'nats' && messageLogCfg.adapter === 'nats') {
        const mod = await loadNatsModule();
        try {
            const bundle = await mod.createNatsTransportAdapters({
                servers: eventBusCfg.nats.servers,
                streamName: messageLogCfg.nats.stream,
                idempotencyKvBucket: messageLogCfg.nats.idempotencyKvBucket,
            });
            return {
                eventBus: bundle.eventBus,
                messageLog: bundle.messageLog,
                createDurableSubscription: defaultCreateDurableSubscription({
                    messageLog: bundle.messageLog,
                    eventBus: bundle.eventBus,
                }),
                close: bundle.close,
            };
        } catch (e) {
            throw toConnectError(e);
        }
    }

    let close: (() => Promise<void>) | undefined;
    let eventBus: IEventBus;

    if (eventBusCfg.adapter === 'in-memory') {
        eventBus = createInMemoryEventBus();
    } else {
        const mod = await loadNatsModule();
        try {
            const s = await mod.createNatsJetStreamEventBusStandalone({ servers: eventBusCfg.nats.servers });
            eventBus = s.eventBus;
            close = s.close;
        } catch (e) {
            throw toConnectError(e);
        }
    }

    const messageLog = createDbMessageLog(params.sessionManager);

    return {
        eventBus,
        messageLog,
        createDurableSubscription: defaultCreateDurableSubscription({ messageLog, eventBus }),
        close,
    };
}

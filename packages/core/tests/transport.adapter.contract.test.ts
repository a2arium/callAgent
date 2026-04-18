import { describe, it, expect } from '@jest/globals';
import { createInMemoryEventBus } from '../src/eventbus/inMemoryEventBus.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';
import { createBusEvent } from '../src/eventbus/busEventHelpers.js';
import { createInProcessDurableSubscription } from '../src/eventbus/inProcessDurableSubscription.js';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import {
    resolveTransportAdapters,
    TransportAdapterConfigSchema,
} from '../src/orchestration/AdapterFactory.js';
import { AdapterErrorThrowable } from '../src/public-types/eventbus/error.js';
import { runEventBusContract } from '../src/testing/eventBusContract.js';
import { runMessageLogContract } from '../src/testing/messageLogContract.js';
import { runDurableSubscriptionContract } from '../src/testing/durableSubscriptionContract.js';
import { v7 as uuidv7 } from 'uuid';

runEventBusContract('IEventBus (in-memory)', async () => ({
    eventBus: createInMemoryEventBus(),
}));

runMessageLogContract('MessageLog (database / in-memory store)', async () => {
    const sessionManager = new SessionManager(new InMemorySessionManager());
    return {
        messageLog: createDbMessageLog(sessionManager),
    };
});

const durableMaxRetries = 3;

runDurableSubscriptionContract('DurableSubscription (in-process + DB log)', async () => {
    const tenantId = 'dur-tenant';
    const streamId = 'dur-stream';
    const consumerId = 'dur-consumer';
    const sessionManager = new SessionManager(new InMemorySessionManager());
    const messageLog = createDbMessageLog(sessionManager);
    const eventBus = createInMemoryEventBus();
    const durable = createInProcessDurableSubscription({
        tenantId,
        messageLog,
        eventBus,
        persistence: sessionManager,
        maxHandlerRetries: durableMaxRetries,
    });
    return {
        durable,
        tenantId,
        streamId,
        consumerId,
        messageLog,
        eventBus,
        expectedMaxHandlerRetries: durableMaxRetries,
    };
});

describe('Transport adapter contracts (5.4c baseline)', () => {
    describe('resolveTransportAdapters', () => {
        it('rejects unknown adapter id with AdapterUnknown', async () => {
            const sm = new SessionManager(new InMemorySessionManager());
            try {
                await resolveTransportAdapters({
                    transport: { eventBus: { adapter: 'kafka' } },
                    sessionManager: sm,
                });
                expect(true).toBe(false);
            } catch (e) {
                expect(e).toBeInstanceOf(AdapterErrorThrowable);
                if (e instanceof AdapterErrorThrowable) {
                    expect(e.body.kind).toBe('AdapterUnknown');
                    if (e.body.kind === 'AdapterUnknown') {
                        expect(e.body.adapterId).toBe('kafka');
                    }
                }
            }
        });

        it('defaults to in-memory bus and database-backed message log', async () => {
            const sm = new SessionManager(new InMemorySessionManager());
            const r = await resolveTransportAdapters({ sessionManager: sm });
            await r.eventBus.publish(
                createBusEvent({
                    channel: 'c',
                    cloud: {
                        id: uuidv7(),
                        type: 't',
                        source: '/s',
                        time: new Date().toISOString(),
                        data: {},
                    },
                })
            );
            const append = await r.messageLog.append({
                tenantId: 't',
                conversationId: 'conv',
                conversationKind: 'topic',
                senderAgentId: 'a',
                senderMemberId: 'm',
                speechAct: 'inform',
                payload: {},
                deliveries: [{ recipientAgentId: 'a2', recipientMemberId: 'm2', sessionId: 'sx' }],
            });
            expect(append.kind).toBe('appended');
        });
    });

    describe('TransportAdapterConfigSchema', () => {
        it('accepts NATS-shaped config', () => {
            const parsed = TransportAdapterConfigSchema.safeParse({
                eventBus: { adapter: 'nats', nats: { servers: ['nats://127.0.0.1:4222'] } },
                messageLog: {
                    adapter: 'nats',
                    nats: { servers: ['nats://127.0.0.1:4222'], stream: 'S' },
                },
            });
            expect(parsed.success).toBe(true);
        });
    });
});

const itBroker = process.env.RUN_BROKER_TESTS === '1' ? it : it.skip;
const natsServers = (process.env.NATS_URL ?? 'nats://127.0.0.1:4222').split(',').map((s) => s.trim());

const describeBroker = process.env.RUN_BROKER_TESTS === '1' ? describe : describe.skip;

describeBroker('NATS JetStream shared contracts (RUN_BROKER_TESTS=1)', () => {
    runEventBusContract('IEventBus (NATS)', async () => {
        const { createNatsTransportAdapters } = await import('@a2arium/callagent-eventbus-nats');
        const bundle = await createNatsTransportAdapters({
            servers: natsServers,
            streamName: `CALLAGENT_TEST_${Date.now()}`,
            idempotencyKvBucket: `CALLAGENT_IDEMP_${Date.now()}`,
        });
        return { eventBus: bundle.eventBus, close: bundle.close };
    });

    runMessageLogContract('MessageLog (NATS)', async () => {
        const { createNatsTransportAdapters } = await import('@a2arium/callagent-eventbus-nats');
        const bundle = await createNatsTransportAdapters({
            servers: natsServers,
            streamName: `CALLAGENT_TEST_${Date.now()}`,
            idempotencyKvBucket: `CALLAGENT_IDEMP_${Date.now()}`,
        });
        return { messageLog: bundle.messageLog, close: bundle.close };
    });

    runDurableSubscriptionContract('DurableSubscription (NATS bus+log + in-process)', async () => {
        const { createNatsTransportAdapters } = await import('@a2arium/callagent-eventbus-nats');
        const { createNatsJetStreamDurableSubscription } = await import('@a2arium/callagent-core');
        const bundle = await createNatsTransportAdapters({
            servers: natsServers,
            streamName: `CALLAGENT_TEST_${Date.now()}`,
            idempotencyKvBucket: `CALLAGENT_IDEMP_${Date.now()}`,
        });
        const tenantId = 'nat-dur-tenant';
        const streamId = 'nat-dur-stream';
        const consumerId = 'nat-dur-consumer';
        const sessionManager = new SessionManager(new InMemorySessionManager());
        const durable = createNatsJetStreamDurableSubscription({
            tenantId,
            messageLog: bundle.messageLog,
            eventBus: bundle.eventBus,
            persistence: sessionManager,
            maxHandlerRetries: durableMaxRetries,
        });
        return {
            durable,
            tenantId,
            streamId,
            consumerId,
            messageLog: bundle.messageLog,
            eventBus: bundle.eventBus,
            expectedMaxHandlerRetries: durableMaxRetries,
            close: bundle.close,
        };
    });
});

describe('NATS JetStream adapters (RUN_BROKER_TESTS=1, optional)', () => {
    itBroker(
        'event bus optional backpressure accounts for handler completion',
        async () => {
            const { createNatsTransportAdapters } = await import('@a2arium/callagent-eventbus-nats');
            const { BackpressureManager } = await import('@a2arium/callagent-core');
            const unackedTrail: number[] = [];
            const bp = new BackpressureManager(
                {
                    bufferThreshold: 1,
                    throttleThreshold: 2,
                    pauseThreshold: 3,
                    maxRetries: 3,
                },
                (ev) => {
                    unackedTrail.push(ev.unackedCount);
                }
            );
            const bundle = await createNatsTransportAdapters({
                servers: natsServers,
                streamName: `CALLAGENT_TEST_${Date.now()}`,
                idempotencyKvBucket: `CALLAGENT_IDEMP_${Date.now()}`,
                eventBusBackpressure: bp,
                eventBusBackpressureTenantId: 't-bp',
            });
            try {
                let done!: () => void;
                const handlerDone = new Promise<void>((r) => {
                    done = r;
                });
                const sub = await bundle.eventBus.subscribe('chan.bp', async () => {
                    await new Promise((r) => setTimeout(r, 30));
                    done();
                });
                await bundle.eventBus.publish(
                    createBusEvent({
                        channel: 'chan.bp',
                        cloud: {
                            id: uuidv7(),
                            type: 'evt.bp',
                            source: '/x',
                            time: new Date().toISOString(),
                            data: {},
                        },
                    })
                );
                await handlerDone;
                expect(unackedTrail.length).toBeGreaterThan(0);
                expect(unackedTrail[unackedTrail.length - 1]).toBe(0);
                await sub.unsubscribe();
            } finally {
                await bundle.close();
            }
        },
        30_000
    );
});

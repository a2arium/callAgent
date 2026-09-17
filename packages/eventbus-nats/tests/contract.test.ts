import { afterAll, beforeAll, describe } from '@jest/globals';
import { createNatsJetStreamDurableSubscription } from '@a2arium/callagent-core';
import {
    runDurableSubscriptionContract,
    runEventBusContract,
    runMessageLogContract,
} from '@a2arium/callagent-core/testing/contracts';
import { InMemorySessionManager } from '../../core/src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../../core/src/orchestration/SessionManager.js';
import { createNatsTransportAdapters } from '../src/index.js';

const runBroker = process.env.RUN_BROKER_TESTS === '1';
const describeBroker = runBroker ? describe : describe.skip;

const durableMaxRetries = 3;

describeBroker('@a2arium/callagent-eventbus-nats — shared contracts', () => {
    let servers: string[];
    let stopBroker: () => Promise<void>;

    beforeAll(async () => {
        const envUrl = process.env.NATS_URL;
        if (envUrl) {
            servers = envUrl.split(',').map((s) => s.trim());
            stopBroker = async () => {};
            return;
        }
        const { NatsContainer } = await import('@testcontainers/nats');
        const c = await new NatsContainer('nats:2.10-alpine').withJetStream().start();
        const opt = c.getConnectionOptions();
        const raw = opt.servers;
        servers = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
        if (servers.length === 0) {
            throw new Error('NATS testcontainer did not expose servers');
        }
        stopBroker = async () => {
            await c.stop();
        };
    }, 120_000);

    afterAll(async () => {
        await stopBroker();
    });

    runEventBusContract('IEventBus (JetStream)', async () => {
        const bundle = await createNatsTransportAdapters({
            servers,
            streamName: `EC_NB_${Date.now()}`,
            idempotencyKvBucket: `EC_ID_${Date.now()}`,
        });
        return { eventBus: bundle.eventBus, close: bundle.close };
    });

    runMessageLogContract('MessageLog (JetStream)', async () => {
        const bundle = await createNatsTransportAdapters({
            servers,
            streamName: `EC_NB_${Date.now()}`,
            idempotencyKvBucket: `EC_ID_${Date.now()}`,
        });
        return { messageLog: bundle.messageLog, close: bundle.close };
    });

    runDurableSubscriptionContract('DurableSubscription (JetStream bundle)', async () => {
        const bundle = await createNatsTransportAdapters({
            servers,
            streamName: `EC_NB_${Date.now()}`,
            idempotencyKvBucket: `EC_ID_${Date.now()}`,
        });
        const tenantId = 'ec-tenant';
        const streamId = 'ec-stream';
        const consumerId = 'ec-consumer';
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

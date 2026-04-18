import { connect } from 'nats';
import {
    NatsJetStreamEventBus,
    type NatsEventBusDispatchPressure,
    type NatsJetStreamEventBusOptions,
} from './NatsJetStreamEventBus.js';
import { NatsJetStreamMessageLog } from './NatsJetStreamMessageLog.js';

export {
    NatsJetStreamEventBus,
    type NatsEventBusDispatchPressure,
    type NatsJetStreamEventBusOptions,
} from './NatsJetStreamEventBus.js';
export { NatsJetStreamMessageLog } from './NatsJetStreamMessageLog.js';

export async function createNatsJetStreamEventBusStandalone(opts: { servers: string[] }): Promise<{
    eventBus: NatsJetStreamEventBus;
    close: () => Promise<void>;
}> {
    const nc = await connect({ servers: opts.servers });
    const bus = new NatsJetStreamEventBus(nc);
    return {
        eventBus: bus,
        close: async () => {
            await nc.drain();
        },
    };
}

export async function createNatsTransportAdapters(opts: {
    servers: string[];
    streamName?: string;
    idempotencyKvBucket?: string;
    /** Optional `NatsJetStreamEventBus` options (subject prefix, backpressure). */
    eventBus?: NatsJetStreamEventBusOptions;
    /** Shorthand when only backpressure is needed (e.g. core `BackpressureManager`). */
    eventBusBackpressure?: NatsEventBusDispatchPressure;
    eventBusBackpressureTenantId?: string;
    eventBusSubjectPrefix?: string;
}): Promise<{
    eventBus: NatsJetStreamEventBus;
    messageLog: NatsJetStreamMessageLog;
    close: () => Promise<void>;
}> {
    const nc = await connect({ servers: opts.servers });
    const js = nc.jetstream();
    const jsm = await nc.jetstreamManager();
    const busOpts: NatsJetStreamEventBusOptions | undefined =
        opts.eventBus ??
        (opts.eventBusBackpressure !== undefined ||
        opts.eventBusBackpressureTenantId !== undefined ||
        opts.eventBusSubjectPrefix !== undefined
            ? {
                  subjectPrefix: opts.eventBusSubjectPrefix,
                  backpressure: opts.eventBusBackpressure,
                  backpressureTenantId: opts.eventBusBackpressureTenantId,
              }
            : undefined);
    const bus = busOpts !== undefined ? new NatsJetStreamEventBus(nc, busOpts) : new NatsJetStreamEventBus(nc);
    const messageLog = new NatsJetStreamMessageLog({
        connection: nc,
        jetstream: js,
        jetstreamManager: jsm,
        streamName: opts.streamName,
        idempotencyKvBucket: opts.idempotencyKvBucket,
    });
    return {
        eventBus: bus,
        messageLog,
        close: async () => {
            await nc.drain();
        },
    };
}

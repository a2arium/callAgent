import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { IEventBus } from '@a2arium/callagent-core';
import type { HatchetOutboxBootstrap } from '@a2arium/callagent-driver-hatchet';

loadNearestEnv();

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8790);

async function main(): Promise<void> {
    const [
        {
            bootstrapCompositionRoot,
            createApiRouter,
        },
        {
            DEMO_AGENT_ID,
            registerDemoAgent,
        },
        {
            WorkingMemorySessionStore,
        },
    ] = await Promise.all([
        import('@a2arium/callagent-core'),
        import('./demoAgent.js'),
        import('@a2arium/callagent-memory-sql'),
    ]);

    const sessionStore = process.env.MEMORY_DATABASE_URL
        ? new WorkingMemorySessionStore()
        : undefined;

    let hatchetBootstrap: HatchetOutboxBootstrap | undefined;
    let transportClose: (() => Promise<void>) | undefined;
    let eventBus: IEventBus | undefined;

    if (process.env.CALLAGENT_OUTBOX_DISPATCHER?.toLowerCase() === 'hatchet') {
        const natsSpec = '@a2arium/callagent-eventbus-nats';
        const hatchetSpec = '@a2arium/callagent-driver-hatchet';
        const [{ createNatsJetStreamEventBusStandalone }, { resolveHatchetOutboxBootstrap }] =
            await Promise.all([import(natsSpec), import(hatchetSpec)]);
        const natsUrl = process.env.NATS_URL ?? 'nats://localhost:4222';
        const nats = await createNatsJetStreamEventBusStandalone({ servers: [natsUrl] });
        eventBus = nats.eventBus;
        transportClose = nats.close;
        hatchetBootstrap = resolveHatchetOutboxBootstrap({ sessionStore, eventBus });
    }

    const { engine, shutdown: shutdownComposition } = await bootstrapCompositionRoot({
        registerAgents: registerDemoAgent,
        taskEngine: {
            sessionStore,
            eventBus,
            transportClose,
            runtimeDriverFactory: hatchetBootstrap?.runtimeDriverFactory,
        },
    });

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use((req, _res, next) => {
        const tenant = req.header('x-tenant-id');
        if (tenant) {
            (req as { tenantId?: string }).tenantId = tenant;
        }
        next();
    });

    app.get('/health', (_req, res) => {
        res.json({
            ok: true,
            agentId: DEMO_AGENT_ID,
            rpc: '/rpc',
        });
    });
    app.use('/', createApiRouter());

    const server = app.listen(port, host, () => {
        console.log(`Runtime host listening on http://${host}:${port}`);
        console.log(`RPC URL: http://${host}:${port}/rpc`);
        console.log(`Demo agent: ${DEMO_AGENT_ID}`);
        console.log('Viewer: node apps/docs/streaming-harness/viewer/server.mjs');
    });

    const shutdown = async () => {
        console.log('Stopping runtime host...');
        shutdownComposition();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    process.once('SIGINT', () => {
        void shutdown().finally(() => process.exit(0));
    });
    process.once('SIGTERM', () => {
        void shutdown().finally(() => process.exit(0));
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

function loadNearestEnv(): void {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
        const candidate = join(dir, '.env');
        if (existsSync(candidate)) {
            loadDotenv({ path: candidate });
            return;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    loadDotenv();
}

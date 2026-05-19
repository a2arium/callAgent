import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

loadNearestEnv();

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8790);

async function main(): Promise<void> {
    const [
        {
            EngineLocator,
            TaskEngine,
            createApiRouter,
            createInMemoryEventBus,
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

    await registerDemoAgent();

    const eventBus = createInMemoryEventBus();
    const sessionStore = process.env.MEMORY_DATABASE_URL
        ? new WorkingMemorySessionStore()
        : undefined;
    const engine = new TaskEngine({ eventBus, sessionStore });
    EngineLocator.setEngine(engine);

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
        EngineLocator.setEngine(null);
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

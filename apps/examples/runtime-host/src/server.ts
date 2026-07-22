import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { loadWorkspaces } from '@a2arium/callagent-core';
import type { IEventBus } from '@a2arium/callagent-core';
import type { HatchetOutboxBootstrap } from '@a2arium/callagent-driver-hatchet';

loadNearestEnv();

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8790);

async function main(): Promise<void> {
    const [
        {
            bootstrapCompositionRoot,
            createRuntimeApiRouter,
            createOperatorApiRouter,
        },
        {
            DEMO_AGENT_ID,
            registerDemoAgent,
        },
        {
            PHASE2_LOOP_AGENT_ID,
            registerPhase2LoopAgent,
        },
        {
            PHASE2_PARENT_AGENT_ID,
            registerPhase2ParentAgent,
        },
        {
            WorkingMemorySessionStore,
        },
    ] = await Promise.all([
        import('@a2arium/callagent-core'),
        import('./demoAgent.js'),
        import('@a2arium/phase2-loop-agent'),
        import('@a2arium/phase2-parent-agent'),
        import('@a2arium/callagent-memory-sql'),
    ]);

    const sessionStore = process.env.MEMORY_DATABASE_URL
        ? new WorkingMemorySessionStore()
        : undefined;

    let hatchetBootstrap: HatchetOutboxBootstrap | undefined;
    let transportClose: (() => Promise<void>) | undefined;
    let eventBus: IEventBus | undefined;

    if (process.env.CALLAGENT_OUTBOX_DISPATCHER?.toLowerCase() === 'hatchet') {
        console.log('CALLAGENT_OUTBOX_DISPATCHER=hatchet; initializing Hatchet outbox mode');
        console.log(`NATS_URL: ${process.env.NATS_URL ?? 'nats://localhost:4222'}`);
        console.log(`HATCHET_CLIENT_HOST_PORT: ${process.env.HATCHET_CLIENT_HOST_PORT ?? '(default)'}`);
        console.log(`HATCHET_CLIENT_TLS_STRATEGY: ${process.env.HATCHET_CLIENT_TLS_STRATEGY ?? '(default)'}`);
        const natsSpec = '@a2arium/callagent-eventbus-nats';
        const hatchetSpec = '@a2arium/callagent-driver-hatchet';
        const [{ createNatsJetStreamEventBusStandalone }, { resolveHatchetOutboxBootstrap }] =
            await Promise.all([import(natsSpec), import(hatchetSpec)]);
        const natsUrl = process.env.NATS_URL ?? 'nats://localhost:4222';
        const nats = await createNatsJetStreamEventBusStandalone({ servers: [natsUrl] });
        eventBus = nats.eventBus;
        transportClose = nats.close;
        hatchetBootstrap = resolveHatchetOutboxBootstrap({ sessionStore, eventBus });
        console.log('Hatchet outbox mode bootstrapped');
    } else {
        console.log('CALLAGENT_OUTBOX_DISPATCHER is not hatchet; using polling outbox mode');
    }

    const { engine, shutdown: shutdownComposition } = await bootstrapCompositionRoot({
        registerAgents: async () => {
            await registerDemoAgent();
            await registerPhase2LoopAgent();
            await registerPhase2ParentAgent();
            await loadWorkspaces();
        },
        taskEngine: {
            sessionStore,
            eventBus,
            transportClose,
            runtimeDriverFactory: hatchetBootstrap?.runtimeDriverFactory,
        },
    });

    const production = process.env.CALLAGENT_MODE === 'production' || process.env.NODE_ENV === 'production';
    const operatorEnabled = process.env.CALLAGENT_OPERATOR_ENABLED !== 'false' && (sessionStore !== undefined || production);
    let operatorAuth: Awaited<ReturnType<typeof import('@a2arium/callagent-operator-auth')['createOperatorAuthRuntime']>> | undefined;
    if (operatorEnabled) {
        if (!sessionStore) throw new Error('MEMORY_DATABASE_URL is required when Observer authentication is enabled');
        const { createOperatorAuthRuntime, validateOperatorAuthEnvironment } = await import('@a2arium/callagent-operator-auth');
        const { baseURL, secret } = validateOperatorAuthEnvironment(process.env, production);
        operatorAuth = createOperatorAuthRuntime({
            prisma: sessionStore.getPrismaClient(),
            baseURL,
            secret,
            production,
            log: (message) => console.log(message),
        });
        await operatorAuth.bootstrap();
    } else {
        console.warn('Observer authentication is disabled; configure MEMORY_DATABASE_URL and BETTER_AUTH_SECRET to enable it');
    }

    const app = express();
    if (operatorAuth) {
        app.all('/operator-api/auth/*splat', operatorAuth.authHandler);
    }
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
            phase2AgentId: PHASE2_LOOP_AGENT_ID,
            phase2ParentAgentId: PHASE2_PARENT_AGENT_ID,
            rpc: '/rpc',
            operatorViewer: '/operator',
        });
    });
    const serverDir = dirname(fileURLToPath(import.meta.url));
    const operatorViewerDist = [
        process.env.OPERATOR_VIEWER_DIST,
        join(process.cwd(), 'apps/operator-viewer/dist'),
        join(serverDir, '../../../operator-viewer/dist'),
    ].find((candidate): candidate is string =>
        typeof candidate === 'string' && existsSync(join(candidate, 'index.html'))
    );
    const sendOperatorConfig = (_req: express.Request, res: express.Response) => {
        res.json({
            hatchetDashboardUrl: process.env.HATCHET_DASHBOARD_URL ?? 'http://127.0.0.1:8080',
            hatchetDashboardTenantId: process.env.HATCHET_DASHBOARD_TENANT_ID ??
                '707d0855-80ab-4e1f-a156-f1c4546cbf52',
            environment: process.env.OPERATOR_ENVIRONMENT ?? 'local-dev',
        });
    };
    if (operatorAuth) {
        app.use('/operator-api', operatorAuth.managementRouter);
        app.get('/operator-api/config', operatorAuth.operatorMiddleware, sendOperatorConfig);
        app.use('/operator-api', createOperatorApiRouter(operatorAuth.operatorMiddleware));
    } else {
        app.use('/operator-api', (_req, res) => {
            res.status(503).json({
                error: 'OPERATOR_AUTH_NOT_CONFIGURED',
                message: 'Configure MEMORY_DATABASE_URL and BETTER_AUTH_SECRET to enable Observer',
            });
        });
    }
    if (operatorViewerDist !== undefined) {
        app.use('/operator', express.static(operatorViewerDist));
        app.get('/operator', (_req, res) => {
            res.redirect('/operator/');
        });
        app.get(/^\/operator\/.*/, (_req, res) => {
            res.sendFile(join(operatorViewerDist, 'index.html'));
        });
    }
    app.use('/', createRuntimeApiRouter());

    const server = app.listen(port, host, () => {
        console.log(`Runtime host listening on http://${host}:${port}`);
        console.log(`RPC URL: http://${host}:${port}/rpc`);
        console.log(`Demo agent: ${DEMO_AGENT_ID}`);
        console.log(`Phase 2 loop agent: ${PHASE2_LOOP_AGENT_ID}`);
        console.log(`Phase 2 parent agent: ${PHASE2_PARENT_AGENT_ID}`);
        console.log(
            operatorViewerDist
                ? `Operator viewer: http://${host}:${port}/operator`
                : 'Operator viewer: not built (run yarn workspace @a2arium/operator-viewer build)'
        );
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

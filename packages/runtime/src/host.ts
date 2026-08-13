import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    bootstrapCompositionRoot,
    createOperatorApiRouter,
    createRuntimeApiRouter,
    type AgentScheduleService,
    type IEventBus,
} from '@a2arium/callagent-core';
import type { HatchetOutboxBootstrap } from '@a2arium/callagent-driver-hatchet';
import { readRuntimeWorkspaceDescriptor } from './descriptor.js';
import { registerWorkspaceAgents } from './registerWorkspaceAgents.js';

type NatsModule = {
    createNatsJetStreamEventBusStandalone: (options: { servers: string[] }) => Promise<{
        eventBus: IEventBus;
        close: () => Promise<void>;
    }>;
};

type HatchetModule = {
    resolveHatchetOutboxBootstrap: (options: {
        sessionStore: InstanceType<typeof import('@a2arium/callagent-memory-sql')['WorkingMemorySessionStore']> | undefined;
        eventBus: IEventBus;
    }) => HatchetOutboxBootstrap;
    createHatchetAgentScheduleService: (options: {
        prisma: ReturnType<InstanceType<typeof import('@a2arium/callagent-memory-sql')['WorkingMemorySessionStore']>['getPrismaClient']>;
    }) => AgentScheduleService;
};

async function importNats(): Promise<NatsModule> {
    const spec = '@a2arium/callagent-eventbus-nats';
    return import(spec) as Promise<NatsModule>;
}

async function importHatchet(): Promise<HatchetModule> {
    const spec = '@a2arium/callagent-driver-hatchet';
    return import(spec) as Promise<HatchetModule>;
}

async function main(): Promise<void> {
    const descriptor = await readRuntimeWorkspaceDescriptor();
    const { WorkingMemorySessionStore } = await import('@a2arium/callagent-memory-sql');
    const sessionStore = process.env.MEMORY_DATABASE_URL ? new WorkingMemorySessionStore() : undefined;
    let hatchetBootstrap: HatchetOutboxBootstrap | undefined;
    let transportClose: (() => Promise<void>) | undefined;
    let eventBus: IEventBus | undefined;
    let scheduleService: AgentScheduleService | undefined;

    if (process.env.CALLAGENT_OUTBOX_DISPATCHER?.toLowerCase() === 'hatchet') {
        const [{ createNatsJetStreamEventBusStandalone }, { resolveHatchetOutboxBootstrap }] = await Promise.all([importNats(), importHatchet()]);
        const nats = await createNatsJetStreamEventBusStandalone({ servers: [process.env.NATS_URL ?? 'nats://localhost:4222'] });
        eventBus = nats.eventBus;
        transportClose = nats.close;
        hatchetBootstrap = resolveHatchetOutboxBootstrap({ sessionStore, eventBus });
    }
    let registered: Awaited<ReturnType<typeof registerWorkspaceAgents>> | undefined;
    const { shutdown: shutdownComposition } = await bootstrapCompositionRoot({
        registerAgents: async () => {
            registered = await registerWorkspaceAgents(descriptor);
        },
        taskEngine: { sessionStore, eventBus, transportClose, runtimeDriverFactory: hatchetBootstrap?.runtimeDriverFactory },
    });
    if (sessionStore && hatchetBootstrap) {
        const { createHatchetAgentScheduleService } = await importHatchet();
        scheduleService = createHatchetAgentScheduleService({ prisma: sessionStore.getPrismaClient() });
    }
    const production = process.env.CALLAGENT_MODE === 'production' || process.env.NODE_ENV === 'production';
    const operatorEnabled = process.env.CALLAGENT_OPERATOR_ENABLED !== 'false' && (sessionStore !== undefined || production);
    let operatorAuth: Awaited<ReturnType<typeof import('@a2arium/callagent-operator-auth')['createOperatorAuthRuntime']>> | undefined;
    if (operatorEnabled) {
        if (!sessionStore) throw new Error('MEMORY_DATABASE_URL is required when Observer authentication is enabled');
        const { createOperatorAuthRuntime, validateOperatorAuthEnvironment } = await import('@a2arium/callagent-operator-auth');
        const { baseURL, secret } = validateOperatorAuthEnvironment(process.env, production);
        operatorAuth = createOperatorAuthRuntime({ prisma: sessionStore.getPrismaClient(), baseURL, secret, production, log: console.log });
        await operatorAuth.bootstrap();
    }
    const app = express();
    if (operatorAuth) app.all('/operator-api/auth/*splat', operatorAuth.authHandler);
    app.use(express.json({ limit: '1mb' }));
    app.get('/health', (_req, res) => res.json({ ok: true, rpc: '/rpc' }));
    app.get('/ready', (_req, res) => res.json({ ok: true, workspaceFingerprint: descriptor.fingerprint, agents: descriptor.workspaces.flatMap((workspace) => workspace.agents.map((agent) => agent.id)).sort() }));
    if (operatorAuth) {
        app.use('/operator-api', operatorAuth.managementRouter);
        app.get('/operator-api/config', operatorAuth.operatorMiddleware, (_req, res) => res.json({
            hatchetDashboardUrl: process.env.HATCHET_DASHBOARD_URL ?? 'http://127.0.0.1:8080',
            hatchetDashboardTenantId: process.env.HATCHET_DASHBOARD_TENANT_ID ?? '707d0855-80ab-4e1f-a156-f1c4546cbf52',
            environment: process.env.OPERATOR_ENVIRONMENT ?? 'local-dev',
        }));
        app.use('/operator-api', createOperatorApiRouter(operatorAuth.operatorMiddleware, { scheduleService }));
    } else {
        app.use('/operator-api', (_req, res) => res.status(503).json({
            error: 'OPERATOR_AUTH_NOT_CONFIGURED',
            message: 'Configure MEMORY_DATABASE_URL and BETTER_AUTH_SECRET to enable Observer',
        }));
    }
    const observer = join(dirname(fileURLToPath(import.meta.url)), 'observer');
    if (process.env.CALLAGENT_OBSERVER_ENABLED !== 'false' && existsSync(join(observer, 'index.html'))) {
        app.use('/operator', express.static(observer));
        app.get('/operator', (_req, res) => res.redirect('/operator/'));
        app.get(/^\/operator\/.*/, (_req, res) => res.sendFile(join(observer, 'index.html')));
    }
    app.use('/', createRuntimeApiRouter());
    const server = app.listen(Number(process.env.PORT ?? 8790), process.env.HOST ?? '127.0.0.1', () => {
        if (!registered) throw new Error('Runtime host started without registering workspace agents');
        console.log(`CALLAGENT_RUNTIME_READY ${JSON.stringify(registered)}`);
        console.log('Runtime host ready');
    });
    const shutdown = async () => {
        shutdownComposition();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
    process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

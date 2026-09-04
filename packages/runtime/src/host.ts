import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    bootstrapCompositionRoot,
    createOperatorApiRouter,
    createRuntimeApiRouter,
    type AgentScheduleService,
    AgentScheduleError,
    type IEventBus,
    validateOperatorRawPayloadBudget,
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

export type RuntimeProcessHandle = {
    workspaceFingerprint: string;
    agents: { fingerprint: string; agentIds: string[] };
    stop: () => Promise<void>;
};

export class HatchetScheduleReadiness {
    private healthy = false;
    private stopped = false;
    private timer?: NodeJS.Timeout;
    private attempt = 0;

    constructor(private readonly probe: () => Promise<void>) {}

    start(): void { void this.run(); }
    isHealthy(): boolean { return this.healthy; }
    stop(): void {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
    }

    private async run(): Promise<void> {
        try {
            await this.probe();
            this.healthy = true;
            this.attempt = 0;
        } catch (error) {
            this.healthy = false;
            this.attempt += 1;
            console.warn('HATCHET_SCHEDULE_API_UNAVAILABLE', {
                message: error instanceof Error ? error.message : String(error),
            });
        }
        if (this.stopped) return;
        const delay = this.healthy ? 30_000 : Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt - 1, 5));
        this.timer = setTimeout(() => void this.run(), delay);
        this.timer.unref?.();
    }
}

export function gateScheduleService(service: AgentScheduleService, readiness: HatchetScheduleReadiness): AgentScheduleService {
    return new Proxy(service, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
                if (!readiness.isHealthy()) {
                    throw new AgentScheduleError(
                        'SCHEDULE_PROVIDER_UNAVAILABLE',
                        'Hatchet schedule API is temporarily unavailable',
                        503
                    );
                }
                return value.apply(target, args);
            };
        },
    }) as AgentScheduleService;
}

export function databaseMigrationReadinessCode(
    markerPath: string | undefined,
    markerExists: (path: string) => boolean = existsSync,
): 'DATABASE_MIGRATIONS_PENDING' | undefined {
    if (!markerPath) return undefined;
    return markerExists(markerPath) ? undefined : 'DATABASE_MIGRATIONS_PENDING';
}

export async function startRuntimeHost(options: { descriptorPath?: string } = {}): Promise<RuntimeProcessHandle> {
    // Fail before accepting work. Silently clamping a too-small graph budget
    // makes an operator deployment appear healthy while ignoring its config.
    validateOperatorRawPayloadBudget();
    const descriptor = await readRuntimeWorkspaceDescriptor(options);
    const { WorkingMemorySessionStore } = await import('@a2arium/callagent-memory-sql');
    const sessionStore = process.env.MEMORY_DATABASE_URL ? new WorkingMemorySessionStore() : undefined;
    let hatchetBootstrap: HatchetOutboxBootstrap | undefined;
    let transportClose: (() => Promise<void>) | undefined;
    let eventBus: IEventBus | undefined;
    let scheduleService: AgentScheduleService | undefined;
    let scheduleReadiness: HatchetScheduleReadiness | undefined;

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
        const rawScheduleService = createHatchetAgentScheduleService({ prisma: sessionStore.getPrismaClient() });
        const probeContext = {
            tenantId: process.env.CALLAGENT_OPERATOR_TENANT_ID ?? 'default',
            actorId: 'hatchet-readiness',
            actorType: 'service' as const,
            production: true,
            role: 'viewer' as const,
        };
        scheduleReadiness = new HatchetScheduleReadiness(async () => {
            await rawScheduleService.list(probeContext, { limit: 1 });
        });
        scheduleService = gateScheduleService(rawScheduleService, scheduleReadiness);
        scheduleReadiness.start();
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
    app.get('/ready', (_req, res) => {
        const databaseCode = databaseMigrationReadinessCode(process.env.CALLAGENT_MIGRATION_MARKER_PATH);
        if (databaseCode) {
            res.status(503).json({ ok: false, code: databaseCode });
            return;
        }
        if (scheduleReadiness && !scheduleReadiness.isHealthy()) {
            res.status(503).json({ ok: false, code: 'HATCHET_SCHEDULE_API_UNAVAILABLE' });
            return;
        }
        res.json({ ok: true, workspaceFingerprint: descriptor.fingerprint, agents: descriptor.workspaces.flatMap((workspace) => workspace.agents.map((agent) => agent.id)).sort() });
    });
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
    const server = await new Promise<ReturnType<typeof app.listen>>((resolveServer, reject) => {
        const listening = app.listen(Number(process.env.PORT ?? 8790), process.env.HOST ?? '127.0.0.1');
        listening.once('listening', () => resolveServer(listening));
        listening.once('error', reject);
    });
    if (!registered) {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        shutdownComposition();
        throw new Error('Runtime host started without registering workspace agents');
    }
    let stopped = false;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        scheduleReadiness?.stop();
        shutdownComposition();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    return {
        workspaceFingerprint: descriptor.fingerprint,
        agents: registered,
        stop,
    };
}

async function main(): Promise<void> {
    const runtime = await startRuntimeHost();
    console.log(`CALLAGENT_RUNTIME_READY ${JSON.stringify(runtime.agents)}`);
    console.log('Runtime host ready');
    process.once('SIGINT', () => void runtime.stop().finally(() => process.exit(0)));
    process.once('SIGTERM', () => void runtime.stop().finally(() => process.exit(0)));
}

const invokedAsEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntry) main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

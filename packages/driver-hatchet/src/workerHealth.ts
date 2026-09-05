import { createHash, randomUUID } from 'node:crypto';
import type { HatchetClient } from './hatchetClient.js';

export type WorkerHealthMonitor = { stop: () => Promise<void>; instanceId: string; workerName: string };

const requiredWorkflows = ['aplret.outbox.dispatch', 'aplret.task', 'aplret.task-state', 'aplret.segment', 'aplret.timer.fire'];

export async function startWorkerHealthMonitor(params: {
    prisma: any;
    hatchet: HatchetClient;
    workerName: string;
    instanceId?: string;
    tenantId?: string;
    installationId?: string;
    intervalMs?: number;
    leaseMs?: number;
    initialRegistrationGraceMs?: number;
    onStreamUnavailable?: (error: Error) => void;
    onHealthy?: (heartbeatAt: Date) => void;
}): Promise<WorkerHealthMonitor> {
    const tenantId = params.tenantId ?? process.env.CALLAGENT_OPERATOR_TENANT_ID ?? process.env.CALLAGENT_OPERATOR_BOOTSTRAP_TENANT_ID ?? 'default';
    const installationId = params.installationId ?? (process.env.CALLAGENT_RUNTIME_INSTALLATION_ID?.trim() || 'default');
    const instanceId = params.instanceId ?? randomUUID();
    const workflowHash = createHash('sha256').update(requiredWorkflows.join('\n')).digest('hex');
    const leaseMs = params.leaseMs ?? 30_000;
    const startedAt = Date.now();
    const initialRegistrationGraceMs = params.initialRegistrationGraceMs ?? 30_000;
    let stopped = false;
    let readyOnce = false;
    const persist = async (state: 'ready' | 'failed' | 'stopped', error?: unknown, heartbeatAt?: Date) => {
        const now = new Date();
        const healthy = state === 'ready';
        const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
        await params.prisma.runtimeWorkerHealth.upsert({
            where: { tenantId_installationId_instanceId: { tenantId, installationId, instanceId } },
            create: { tenantId, installationId, instanceId, workerName: params.workerName, state, workflowHash, observedAt: now, heartbeatAt: healthy ? heartbeatAt ?? now : null, leaseUntil: new Date(healthy ? now.getTime() + leaseMs : now.getTime()), ...(message ? { errorCode: 'HATCHET_WORKER_STREAM_UNAVAILABLE', errorMessage: message.slice(0, 500) } : {}) },
            update: { state, workflowHash, observedAt: now, heartbeatAt: healthy ? heartbeatAt ?? now : null, leaseUntil: new Date(healthy ? now.getTime() + leaseMs : now.getTime()), errorCode: healthy ? null : state === 'stopped' ? null : 'HATCHET_WORKER_STREAM_UNAVAILABLE', errorMessage: healthy || state === 'stopped' ? null : message?.slice(0, 500) },
        });
    };
    const unavailable = async (error: Error) => {
        await persist('failed', error);
        // Hatchet's SDK readiness handshake can complete before the worker is
        // visible as ACTIVE through the REST API. Keep readiness degraded, but
        // do not kill a healthy process during that bounded registration race.
        if (readyOnce || Date.now() - startedAt >= initialRegistrationGraceMs) {
            params.onStreamUnavailable?.(error);
        }
    };
    const probe = async () => {
        try {
            const workers = await (params.hatchet as any).workers.list();
            const worker = (workers.rows ?? workers.data ?? workers).find((item: any) => item.name === params.workerName);
            if (!worker || worker.status !== 'ACTIVE') {
                const error = new Error('Hatchet worker is not ACTIVE');
                await unavailable(error);
                return;
            }
            const heartbeatAt = worker.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt) : undefined;
            if (!heartbeatAt || !Number.isFinite(heartbeatAt.getTime()) || Date.now() - heartbeatAt.getTime() > leaseMs) {
                const error = new Error('Hatchet worker heartbeat is stale');
                await unavailable(error);
                return;
            }
            // Hatchet 0.105 exposes registered handlers as `actions` using
            // `<workflow>:<action>` strings. Retain compatibility with SDK/API
            // versions that expose a richer `registeredWorkflows` collection.
            const registered = new Set<string>([
                ...(worker.registeredWorkflows ?? [])
                    .map((workflow: { name?: unknown }) => workflow.name)
                    .filter((name: unknown): name is string => typeof name === 'string'),
                ...(worker.actions ?? [])
                    .filter((action: unknown): action is string => typeof action === 'string')
                    .map((action: string) => action.split(':', 1)[0]!),
            ]);
            const missing = requiredWorkflows.filter((workflow) => !registered.has(workflow));
            if (missing.length > 0) {
                const error = new Error(`Hatchet worker is missing required workflows: ${missing.join(', ')}`);
                await unavailable(error);
                return;
            }
            readyOnce = true;
            await persist('ready', undefined, heartbeatAt);
            params.onHealthy?.(heartbeatAt);
        } catch (error) {
            await unavailable(error instanceof Error ? error : new Error(String(error)));
        }
    };
    await probe();
    const timer = setInterval(() => { if (!stopped) void probe(); }, params.intervalMs ?? 10_000);
    timer.unref?.();
    return { instanceId, workerName: params.workerName, stop: async () => { stopped = true; clearInterval(timer); await persist('stopped'); } };
}

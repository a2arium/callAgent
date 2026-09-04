import { createHash, randomUUID } from 'node:crypto';
import type { HatchetClient } from './hatchetClient.js';

export type WorkerHealthMonitor = { stop: () => Promise<void>; instanceId: string; workerName: string };

const requiredWorkflows = ['aplret.outbox.dispatch', 'aplret.task', 'aplret.task-state', 'aplret.segment', 'aplret.timer.fire'];

export async function startWorkerHealthMonitor(params: {
    prisma: any;
    hatchet: HatchetClient;
    workerName: string;
    tenantId?: string;
    installationId?: string;
    intervalMs?: number;
    leaseMs?: number;
    onStreamUnavailable?: (error: Error) => void;
}): Promise<WorkerHealthMonitor> {
    const tenantId = params.tenantId ?? process.env.CALLAGENT_OPERATOR_TENANT_ID ?? process.env.CALLAGENT_OPERATOR_BOOTSTRAP_TENANT_ID ?? 'default';
    const installationId = params.installationId ?? (process.env.CALLAGENT_RUNTIME_INSTALLATION_ID?.trim() || 'default');
    const instanceId = randomUUID();
    const workflowHash = createHash('sha256').update(requiredWorkflows.join('\n')).digest('hex');
    const leaseMs = params.leaseMs ?? 30_000;
    let stopped = false;
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
    const probe = async () => {
        try {
            const workers = await (params.hatchet as any).workers.list();
            const worker = (workers.rows ?? workers.data ?? workers).find((item: any) => item.name === params.workerName);
            if (!worker || worker.status !== 'ACTIVE') {
                const error = new Error('Hatchet worker is not ACTIVE');
                await persist('failed', error);
                params.onStreamUnavailable?.(error);
                return;
            }
            const heartbeatAt = worker.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt) : undefined;
            if (!heartbeatAt || !Number.isFinite(heartbeatAt.getTime()) || Date.now() - heartbeatAt.getTime() > leaseMs) {
                const error = new Error('Hatchet worker heartbeat is stale');
                await persist('failed', error);
                params.onStreamUnavailable?.(error);
                return;
            }
            const registered = new Set((worker.registeredWorkflows ?? []).map((workflow: { name?: unknown }) => workflow.name).filter((name: unknown): name is string => typeof name === 'string'));
            const missing = requiredWorkflows.filter((workflow) => !registered.has(workflow));
            if (missing.length > 0) {
                const error = new Error(`Hatchet worker is missing required workflows: ${missing.join(', ')}`);
                await persist('failed', error);
                params.onStreamUnavailable?.(error);
                return;
            }
            await persist('ready', undefined, heartbeatAt);
        } catch (error) { await persist('failed', error); }
    };
    await probe();
    const timer = setInterval(() => { if (!stopped) void probe(); }, params.intervalMs ?? 10_000);
    timer.unref?.();
    return { instanceId, workerName: params.workerName, stop: async () => { stopped = true; clearInterval(timer); await persist('stopped'); } };
}

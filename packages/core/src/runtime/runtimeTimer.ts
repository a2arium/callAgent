import { createHash, randomUUID } from 'node:crypto';
import type { RuntimeDriverIds, RuntimeWakeEvent } from './runtimeDriver.js';

export type RuntimeTimerKind = 'token_expiry' | 'sleep' | 'child_timeout' | 'task_run_timeout';
export type RuntimeTimerStatus = 'scheduled' | 'firing' | 'fired' | 'canceled';
export type TimerExpiredReason = 'input_timeout' | 'sleep_due' | 'child_timeout' | 'task_run_timeout';

export type RuntimeTimerRecord = {
    id: string;
    tenantId: string;
    taskId: string;
    agentId: string | null;
    rootTaskId: string | null;
    token: string;
    timerId: string;
    dueAt: Date;
    kind: string;
    status: string;
    idempotencyKey: string;
    fireLeaseId: string | null;
    fireLeaseUntil: Date | null;
    payload: unknown;
    providerRunId: string | null;
    providerTaskRunId: string | null;
    error: unknown;
    firedAt: Date | null;
    canceledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
};

export type RuntimeTimerScheduleParams = RuntimeDriverIds & {
    token: string;
    fireAt: string;
    kind: RuntimeTimerKind;
    payload?: unknown;
    rootTaskId?: string;
};

export type RuntimeTimerFireLease = {
    timer: RuntimeTimerRecord;
    fireLeaseId: string;
};

type RuntimeTimerDelegate = {
    upsert(args: any): Promise<RuntimeTimerRecord>;
    updateMany(args: any): Promise<{ count: number }>;
    update(args: any): Promise<RuntimeTimerRecord>;
    findFirst(args: any): Promise<RuntimeTimerRecord | null>;
    findMany(args: any): Promise<RuntimeTimerRecord[]>;
};

export type RuntimeTimerPrisma = {
    runtimeTimer: RuntimeTimerDelegate;
};

export function deriveRuntimeTimerId(params: {
    tenantId: string;
    taskId: string;
    token: string;
    fireAt: string;
    kind: RuntimeTimerKind;
}): string {
    const hash = createHash('sha256')
        .update(`${params.tenantId}\0${params.taskId}\0${params.token}\0${params.fireAt}\0${params.kind}`)
        .digest('hex');
    return `timer:${hash}`;
}

export function deriveRuntimeTimerIdempotencyKey(params: {
    tenantId: string;
    taskId: string;
    token: string;
    timerId: string;
}): string {
    return `timer:${params.tenantId}:${params.taskId}:${params.token}:${params.timerId}`;
}

export function timerKindToReason(kind: RuntimeTimerKind | string): TimerExpiredReason {
    if (kind === 'sleep') return 'sleep_due';
    if (kind === 'child_timeout') return 'child_timeout';
    if (kind === 'task_run_timeout') return 'task_run_timeout';
    return 'input_timeout';
}

export function timerRecordToWake(timer: RuntimeTimerRecord, firedAt = new Date()): RuntimeWakeEvent {
    return {
        kind: 'timer',
        token: timer.token,
        timerId: timer.timerId,
        dueAt: timer.dueAt.toISOString(),
        firedAt: firedAt.toISOString(),
        reason: timerKindToReason(timer.kind),
        ...(timer.payload !== null && timer.payload !== undefined ? { payload: timer.payload } : {}),
    };
}

export class RuntimeTimerRepository {
    constructor(private readonly prisma: RuntimeTimerPrisma) {}

    async schedule(params: RuntimeTimerScheduleParams): Promise<RuntimeTimerRecord> {
        const timerId = deriveRuntimeTimerId({
            tenantId: params.tenantId,
            taskId: params.taskId,
            token: params.token,
            fireAt: params.fireAt,
            kind: params.kind,
        });
        const idempotencyKey = deriveRuntimeTimerIdempotencyKey({
            tenantId: params.tenantId,
            taskId: params.taskId,
            token: params.token,
            timerId,
        });
        const existing = await this.prisma.runtimeTimer.findFirst({
            where: { idempotencyKey },
            orderBy: { createdAt: 'asc' },
        });
        if (existing !== null && (existing.status === 'fired' || existing.status === 'canceled')) {
            return existing;
        }
        const dueAt = new Date(params.fireAt);
        const payload = params.payload ?? undefined;
        return this.prisma.runtimeTimer.upsert({
            where: { idempotencyKey },
            create: {
                tenantId: params.tenantId,
                taskId: params.taskId,
                agentId: params.agentId ?? null,
                rootTaskId: params.rootTaskId ?? params.taskId,
                token: params.token,
                timerId,
                dueAt,
                kind: params.kind,
                status: 'scheduled',
                idempotencyKey,
                ...(payload !== undefined ? { payload } : {}),
            },
            update: {
                agentId: params.agentId ?? null,
                rootTaskId: params.rootTaskId ?? params.taskId,
                dueAt,
                kind: params.kind,
                status: 'scheduled',
                canceledAt: null,
                firedAt: null,
                fireLeaseId: null,
                fireLeaseUntil: null,
                error: undefined,
                ...(payload !== undefined ? { payload } : {}),
            },
        });
    }

    async cancelTaskTimers(params: { tenantId: string; taskId: string; token?: string }): Promise<number> {
        const result = await this.prisma.runtimeTimer.updateMany({
            where: {
                tenantId: params.tenantId,
                taskId: params.taskId,
                ...(params.token !== undefined ? { token: params.token } : {}),
                status: { in: ['scheduled', 'firing'] },
            },
            data: {
                status: 'canceled',
                canceledAt: new Date(),
                fireLeaseId: null,
                fireLeaseUntil: null,
            },
        });
        return result.count;
    }

    async acquireFireLease(params: {
        tenantId: string;
        taskId: string;
        token: string;
        timerId: string;
        now?: Date;
        leaseTtlMs: number;
    }): Promise<RuntimeTimerFireLease | null> {
        const now = params.now ?? new Date();
        const timer = await this.prisma.runtimeTimer.findFirst({
            where: {
                tenantId: params.tenantId,
                taskId: params.taskId,
                token: params.token,
                timerId: params.timerId,
                dueAt: { lte: now },
                OR: [
                    { status: 'scheduled' },
                    { status: 'firing', fireLeaseUntil: { lt: now } },
                ],
            },
            orderBy: { dueAt: 'asc' },
        });
        if (timer === null) {
            return null;
        }
        const fireLeaseId = randomUUID();
        const fireLeaseUntil = new Date(now.getTime() + params.leaseTtlMs);
        const result = await this.prisma.runtimeTimer.updateMany({
            where: {
                id: timer.id,
                OR: [
                    { status: 'scheduled' },
                    { status: 'firing', fireLeaseUntil: { lt: now } },
                ],
            },
            data: {
                status: 'firing',
                fireLeaseId,
                fireLeaseUntil,
                error: undefined,
            },
        });
        if (result.count !== 1) {
            return null;
        }
        const leased = await this.prisma.runtimeTimer.update({
            where: { id: timer.id },
            data: {},
        });
        return { timer: leased, fireLeaseId };
    }

    async markFired(params: { id: string; fireLeaseId: string; firedAt?: Date }): Promise<boolean> {
        const result = await this.prisma.runtimeTimer.updateMany({
            where: { id: params.id, fireLeaseId: params.fireLeaseId, status: 'firing' },
            data: {
                status: 'fired',
                firedAt: params.firedAt ?? new Date(),
                fireLeaseUntil: null,
            },
        });
        return result.count === 1;
    }

    async markFiredByTimerId(params: {
        tenantId: string;
        taskId: string;
        token: string;
        timerId: string;
        firedAt?: Date;
    }): Promise<boolean> {
        const result = await this.prisma.runtimeTimer.updateMany({
            where: {
                tenantId: params.tenantId,
                taskId: params.taskId,
                token: params.token,
                timerId: params.timerId,
                status: { in: ['scheduled', 'firing'] },
            },
            data: {
                status: 'fired',
                firedAt: params.firedAt ?? new Date(),
                fireLeaseId: null,
                fireLeaseUntil: null,
            },
        });
        return result.count === 1;
    }

    async attachProviderRun(params: {
        id: string;
        providerRunId?: string | null;
        providerTaskRunId?: string | null;
    }): Promise<void> {
        await this.prisma.runtimeTimer.update({
            where: { id: params.id },
            data: {
                providerRunId: params.providerRunId ?? null,
                providerTaskRunId: params.providerTaskRunId ?? null,
            },
        });
    }

    async markFailed(params: { id: string; fireLeaseId?: string; error: unknown }): Promise<void> {
        await this.prisma.runtimeTimer.updateMany({
            where: {
                id: params.id,
                ...(params.fireLeaseId !== undefined ? { fireLeaseId: params.fireLeaseId } : {}),
            },
            data: {
                status: 'scheduled',
                fireLeaseId: null,
                fireLeaseUntil: null,
                error: params.error,
            },
        });
    }

    async listDue(params: { now?: Date; take: number }): Promise<RuntimeTimerRecord[]> {
        const now = params.now ?? new Date();
        return this.prisma.runtimeTimer.findMany({
            where: {
                dueAt: { lte: now },
                status: { in: ['scheduled', 'firing'] },
                OR: [
                    { status: 'scheduled' },
                    { status: 'firing', fireLeaseUntil: { lt: now } },
                ],
            },
            orderBy: [{ dueAt: 'asc' }, { timerId: 'asc' }],
            take: params.take,
        });
    }

    async listScheduled(params: { take: number }): Promise<RuntimeTimerRecord[]> {
        const now = new Date();
        return this.prisma.runtimeTimer.findMany({
            where: {
                OR: [
                    { status: 'scheduled' },
                    { status: 'firing', fireLeaseUntil: { lt: now } },
                ],
            },
            orderBy: [{ dueAt: 'asc' }, { timerId: 'asc' }],
            take: params.take,
        });
    }
}

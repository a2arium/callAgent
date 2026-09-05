import { randomUUID } from 'node:crypto';
import { TaskTurnCoordinatorStateError } from '@a2arium/callagent-types/task-turn-coordinator-state';
import { TaskTurnSupersededError } from '@a2arium/callagent-types/task-turn-superseded';
import { defaultMetricsRegistry } from '../observability/metrics.js';
import { logger } from '@a2arium/callagent-utils';
import {
    addProcessedSegmentKey,
    snapshotHasProcessedSegmentKey,
} from '../runtime/segmentProcessedKeys.js';
import { isTaskLifecycleTerminal, readTaskLifecycle } from './TaskLifecycle.js';
import type { SessionManager } from './SessionManager.js';
import { reconcileSnapshotMutation } from './persistence/SnapshotRepository.js';

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_RENEWAL_SAFETY_MS = 40_000;
const DEFAULT_TAKEOVER_GRACE_MS = 10_000;
const log = logger.createLogger({ prefix: 'TaskTurnCoordinator' });

export type TaskTurnRuntimeSurface = 'direct' | 'in_process' | 'hatchet';
export type TaskTurnRecoveryReason = 'lease_expired' | 'worker_lifetime_lost';

export type TaskTurnRuntimeOwner = {
    installationId: string;
    instanceId: string;
    workerName: string;
    rootProviderRunId?: string;
};

export type TaskTurnLeaseConfig = {
    leaseMs: number;
    heartbeatMs: number;
    renewalSafetyMs: number;
    takeoverGraceMs: number;
};

export type TaskTurnClaim = {
    claimId: string;
    fence: string;
    ownerId: string;
    requestKey: string;
    claimedGeneration: string;
    turnSeq: number;
    acquiredAt: string;
    heartbeatAt: string;
    expiresAt: string;
    runtimeSurface: TaskTurnRuntimeSurface;
    runtimeOwner?: TaskTurnRuntimeOwner;
};

export type ActiveTaskTurnClaim = TaskTurnClaim & {
    phase: 'claimed' | 'executing' | 'committing';
};

export type TaskTurnRecoveryDisposition =
    | 'recovery_staged'
    | 'already_recovering'
    | 'not_expired'
    | 'competing_owner'
    | 'terminal'
    | 'settled';

export type TaskTurnCoordinatorState = {
    schemaVersion: 1;
    /**
     * Durable execution-surface affinity for the task. Once selected, every
     * subsequent wake must be claimed on the same runtime surface. Optional on
     * read for snapshots written before affinity was introduced.
     */
    runtimeSurface?: TaskTurnRuntimeSurface;
    nextFence: string;
    nextTurnSeq: number;
    requestedGeneration: string;
    completedGeneration: string;
    active?: ActiveTaskTurnClaim;
    dispatchIntent?: {
        generation: string;
        /** Logical segment already assigned to this generation during an earlier claim. */
        turnSeq?: number;
        deliveryKey: string;
        runtimeSurface: TaskTurnRuntimeSurface;
        createdAt: string;
        enqueuedAt?: string;
        recovery?: {
            reason: TaskTurnRecoveryReason;
            sourceClaim: ActiveTaskTurnClaim;
            stagedAt?: string;
        };
    };
};

export type RequestTaskTurnResult =
    | { disposition: 'acquired'; claim: TaskTurnClaim; replacedClaim?: TaskTurnClaim; staged: boolean }
    | {
          disposition: 'queued';
          activeClaim?: TaskTurnClaim;
          staged: boolean;
          availableAt?: string;
          recoveryHint?: TaskTurnRecoveryHint;
      }
    | { disposition: 'matching_replay'; staged: false }
    | { disposition: 'terminal'; staged: false };

export type TaskTurnCompletionDisposition = 'committed' | 'terminal' | 'superseded';

export type TaskTurnRecoveryHint = {
    reason: TaskTurnRecoveryReason;
    generation: string;
    deliveryKey: string;
    turnSeq: number;
};

export type WorkerLifetimeRecoveryProvenance = {
    sourceProviderRunId: string;
    sourceClaimId: string;
    sourceFence: string;
    generation: string;
    turnSeq: number;
    stagedAt: string;
    replacementProviderRunId?: string;
    replacementClaimId?: string;
    replacementFence?: string;
};

export function readWorkerLifetimeRecoveryProvenance(snapshot: Record<string, unknown>): WorkerLifetimeRecoveryProvenance[] {
    const meta = asRecord(snapshot.meta);
    const rows = Array.isArray(meta?.workerLifetimeRecoveries) ? meta.workerLifetimeRecoveries : [];
    return rows.flatMap((value) => {
        const row = asRecord(value);
        if (!row || typeof row.sourceProviderRunId !== 'string' || typeof row.sourceClaimId !== 'string' ||
            typeof row.sourceFence !== 'string' || typeof row.generation !== 'string' ||
            !Number.isSafeInteger(row.turnSeq) || typeof row.stagedAt !== 'string') return [];
        return [{
            sourceProviderRunId: row.sourceProviderRunId,
            sourceClaimId: row.sourceClaimId,
            sourceFence: row.sourceFence,
            generation: row.generation,
            turnSeq: row.turnSeq as number,
            stagedAt: row.stagedAt,
            ...(typeof row.replacementProviderRunId === 'string' ? { replacementProviderRunId: row.replacementProviderRunId } : {}),
            ...(typeof row.replacementClaimId === 'string' ? { replacementClaimId: row.replacementClaimId } : {}),
            ...(typeof row.replacementFence === 'string' ? { replacementFence: row.replacementFence } : {}),
        }];
    }).slice(-8);
}

function appendWorkerLifetimeRecoveryProvenance(
    snapshot: Record<string, unknown>,
    sourceClaim: ActiveTaskTurnClaim,
    stagedAt: string,
): Record<string, unknown> {
    const providerRunId = sourceClaim.runtimeOwner?.rootProviderRunId;
    if (!providerRunId) return snapshot;
    const meta = asRecord(snapshot.meta) ?? {};
    const rows = readWorkerLifetimeRecoveryProvenance(snapshot).filter((row) =>
        row.sourceClaimId !== sourceClaim.claimId || row.sourceFence !== sourceClaim.fence
    );
    rows.push({
        sourceProviderRunId: providerRunId,
        sourceClaimId: sourceClaim.claimId,
        sourceFence: sourceClaim.fence,
        generation: sourceClaim.claimedGeneration,
        turnSeq: sourceClaim.turnSeq,
        stagedAt,
    });
    return { ...snapshot, meta: { ...meta, workerLifetimeRecoveries: rows.slice(-8) } };
}

function recordWorkerLifetimeReplacement(
    snapshot: Record<string, unknown>,
    sourceClaim: ActiveTaskTurnClaim,
    replacement: TaskTurnClaim,
): Record<string, unknown> {
    const meta = asRecord(snapshot.meta) ?? {};
    const rows = readWorkerLifetimeRecoveryProvenance(snapshot).map((row) =>
        row.sourceClaimId === sourceClaim.claimId && row.sourceFence === sourceClaim.fence
            ? {
                  ...row,
                  ...(replacement.runtimeOwner?.rootProviderRunId ? { replacementProviderRunId: replacement.runtimeOwner.rootProviderRunId } : {}),
                  replacementClaimId: replacement.claimId,
                  replacementFence: replacement.fence,
              }
            : row
    );
    return { ...snapshot, meta: { ...meta, workerLifetimeRecoveries: rows.slice(-8) } };
}

function readRuntimeOwner(value: unknown, field: string, tenantId: string, taskId: string): TaskTurnRuntimeOwner | undefined {
    if (value === undefined) return undefined;
    const owner = asRecord(value);
    if (owner === undefined ||
        typeof owner.installationId !== 'string' || owner.installationId.length === 0 || owner.installationId.length > 200 ||
        typeof owner.instanceId !== 'string' || owner.instanceId.length === 0 || owner.instanceId.length > 200 ||
        typeof owner.workerName !== 'string' || owner.workerName.length === 0 || owner.workerName.length > 300 ||
        (owner.rootProviderRunId !== undefined && (typeof owner.rootProviderRunId !== 'string' || owner.rootProviderRunId.length === 0 || owner.rootProviderRunId.length > 300))) {
        return invalid(tenantId, taskId, `${field} is invalid`);
    }
    return {
        installationId: owner.installationId,
        instanceId: owner.instanceId,
        workerName: owner.workerName,
        ...(owner.rootProviderRunId !== undefined ? { rootProviderRunId: owner.rootProviderRunId } : {}),
    };
}

function positiveInteger(value: string | undefined, fallback: number): number {
    if (value === undefined || value.length === 0) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`Expected a positive integer, received ${value}`);
    }
    return parsed;
}

export function resolveTaskTurnLeaseConfig(env: NodeJS.ProcessEnv = process.env): TaskTurnLeaseConfig {
    const config = {
        leaseMs: positiveInteger(env.CALLAGENT_TASK_TURN_LEASE_MS, DEFAULT_LEASE_MS),
        heartbeatMs: positiveInteger(env.CALLAGENT_TASK_TURN_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS),
        renewalSafetyMs: positiveInteger(env.CALLAGENT_TASK_TURN_RENEWAL_SAFETY_MS, DEFAULT_RENEWAL_SAFETY_MS),
        takeoverGraceMs: positiveInteger(env.CALLAGENT_TASK_TURN_TAKEOVER_GRACE_MS, DEFAULT_TAKEOVER_GRACE_MS),
    };
    if (config.heartbeatMs >= config.leaseMs / 2) {
        throw new Error('Task turn heartbeat must be less than half of the lease duration.');
    }
    if (config.takeoverGraceMs >= config.leaseMs) {
        throw new Error('Task turn takeover grace must be less than the lease duration.');
    }
    if (config.renewalSafetyMs < config.heartbeatMs ||
        config.renewalSafetyMs + config.heartbeatMs >= config.leaseMs) {
        throw new Error('Task turn renewal safety window is inconsistent with heartbeat and lease duration.');
    }
    return config;
}

function invalid(tenantId: string, taskId: string, reason: string): never {
    throw new TaskTurnCoordinatorStateError({ tenantId, taskId, reason });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function decimal(value: unknown, field: string, tenantId: string, taskId: string): bigint {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
        return invalid(tenantId, taskId, `${field} must be a non-negative decimal string`);
    }
    return BigInt(value);
}

function timestamp(value: unknown, field: string, tenantId: string, taskId: string): string {
    if (typeof value !== 'string') return invalid(tenantId, taskId, `${field} must be an ISO timestamp`);
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
        return invalid(tenantId, taskId, `${field} must be a canonical ISO timestamp`);
    }
    return value;
}

function readRecoverySourceClaim(
    value: unknown,
    counters: { nextFence: bigint; requested: bigint; completed: bigint; nextTurnSeq: number },
    tenantId: string,
    taskId: string
): ActiveTaskTurnClaim {
    const candidate = asRecord(value);
    if (candidate === undefined) return invalid(tenantId, taskId, 'dispatchIntent.recovery.sourceClaim must be an object');
    const fence = decimal(candidate.fence, 'dispatchIntent.recovery.sourceClaim.fence', tenantId, taskId);
    const generation = decimal(
        candidate.claimedGeneration,
        'dispatchIntent.recovery.sourceClaim.claimedGeneration',
        tenantId,
        taskId
    );
    if (fence <= 0n || fence > counters.nextFence || generation <= counters.completed || generation > counters.requested) {
        return invalid(tenantId, taskId, 'dispatchIntent recovery source exceeds coordinator counters');
    }
    if (typeof candidate.claimId !== 'string' || candidate.claimId.length === 0 ||
        typeof candidate.ownerId !== 'string' || candidate.ownerId.length === 0 ||
        typeof candidate.requestKey !== 'string' || candidate.requestKey.length === 0 ||
        !Number.isSafeInteger(candidate.turnSeq) || (candidate.turnSeq as number) <= 0 ||
        (candidate.turnSeq as number) > counters.nextTurnSeq ||
        !['claimed', 'executing', 'committing'].includes(String(candidate.phase)) ||
        !['direct', 'in_process', 'hatchet'].includes(String(candidate.runtimeSurface))) {
        return invalid(tenantId, taskId, 'dispatchIntent recovery source identity is invalid');
    }
    const acquiredAt = timestamp(
        candidate.acquiredAt,
        'dispatchIntent.recovery.sourceClaim.acquiredAt',
        tenantId,
        taskId
    );
    const heartbeatAt = timestamp(
        candidate.heartbeatAt,
        'dispatchIntent.recovery.sourceClaim.heartbeatAt',
        tenantId,
        taskId
    );
    const expiresAt = timestamp(
        candidate.expiresAt,
        'dispatchIntent.recovery.sourceClaim.expiresAt',
        tenantId,
        taskId
    );
    if (Date.parse(acquiredAt) > Date.parse(heartbeatAt) || Date.parse(heartbeatAt) >= Date.parse(expiresAt)) {
        return invalid(tenantId, taskId, 'dispatchIntent recovery source timestamps are not monotonic');
    }
    return {
        claimId: candidate.claimId,
        ownerId: candidate.ownerId,
        requestKey: candidate.requestKey,
        fence: fence.toString(),
        claimedGeneration: generation.toString(),
        turnSeq: candidate.turnSeq as number,
        phase: candidate.phase as ActiveTaskTurnClaim['phase'],
        runtimeSurface: candidate.runtimeSurface as TaskTurnRuntimeSurface,
        acquiredAt,
        heartbeatAt,
        expiresAt,
        ...(readRuntimeOwner(candidate.runtimeOwner, 'dispatchIntent.recovery.sourceClaim.runtimeOwner', tenantId, taskId) !== undefined
            ? { runtimeOwner: readRuntimeOwner(candidate.runtimeOwner, 'dispatchIntent.recovery.sourceClaim.runtimeOwner', tenantId, taskId)! }
            : {}),
    };
}

function initialState(): TaskTurnCoordinatorState {
    return {
        schemaVersion: 1,
        nextFence: '0',
        nextTurnSeq: 0,
        requestedGeneration: '0',
        completedGeneration: '0',
    };
}

function readState(
    snapshot: Record<string, unknown>,
    tenantId: string,
    taskId: string,
    allowInitialize = false
): TaskTurnCoordinatorState {
    const meta = snapshot.meta;
    const raw = meta !== null && typeof meta === 'object' && !Array.isArray(meta)
        ? (meta as Record<string, unknown>).turnCoordinator
        : undefined;
    if (raw === undefined) {
        if (allowInitialize) return initialState();
        return invalid(tenantId, taskId, 'state is missing');
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return invalid(tenantId, taskId, 'state must be an object');
    }
    const value = raw as Record<string, unknown>;
    if (value.schemaVersion !== 1) return invalid(tenantId, taskId, 'unsupported schemaVersion');
    const nextFence = decimal(value.nextFence, 'nextFence', tenantId, taskId);
    const requested = decimal(value.requestedGeneration, 'requestedGeneration', tenantId, taskId);
    const completed = decimal(value.completedGeneration, 'completedGeneration', tenantId, taskId);
    if (completed > requested) return invalid(tenantId, taskId, 'completedGeneration exceeds requestedGeneration');
    if (!Number.isSafeInteger(value.nextTurnSeq) || (value.nextTurnSeq as number) < 0) {
        return invalid(tenantId, taskId, 'nextTurnSeq must be a non-negative safe integer');
    }
    let active: TaskTurnCoordinatorState['active'];
    if (value.active !== undefined) {
        if (value.active === null || typeof value.active !== 'object' || Array.isArray(value.active)) {
            return invalid(tenantId, taskId, 'active must be an object');
        }
        const candidate = value.active as Record<string, unknown>;
        const fence = decimal(candidate.fence, 'active.fence', tenantId, taskId);
        const generation = decimal(candidate.claimedGeneration, 'active.claimedGeneration', tenantId, taskId);
        if (fence !== nextFence || generation > requested || generation <= completed) {
            return invalid(tenantId, taskId, 'active claim exceeds coordinator counters');
        }
        if (typeof candidate.claimId !== 'string' || candidate.claimId.length === 0 ||
            typeof candidate.ownerId !== 'string' || candidate.ownerId.length === 0 ||
            typeof candidate.requestKey !== 'string' || candidate.requestKey.length === 0) {
            return invalid(tenantId, taskId, 'active claim identity is invalid');
        }
        if (!Number.isSafeInteger(candidate.turnSeq) || (candidate.turnSeq as number) <= 0 ||
            (candidate.turnSeq as number) !== (value.nextTurnSeq as number)) {
            return invalid(tenantId, taskId, 'active turnSeq is invalid');
        }
        if (!['claimed', 'executing', 'committing'].includes(String(candidate.phase)) ||
            !['direct', 'in_process', 'hatchet'].includes(String(candidate.runtimeSurface))) {
            return invalid(tenantId, taskId, 'active phase or runtime surface is invalid');
        }
        const acquiredAt = timestamp(candidate.acquiredAt, 'active.acquiredAt', tenantId, taskId);
        const heartbeatAt = timestamp(candidate.heartbeatAt, 'active.heartbeatAt', tenantId, taskId);
        const expiresAt = timestamp(candidate.expiresAt, 'active.expiresAt', tenantId, taskId);
        if (Date.parse(acquiredAt) > Date.parse(heartbeatAt) || Date.parse(heartbeatAt) >= Date.parse(expiresAt)) {
            return invalid(tenantId, taskId, 'active timestamps are not monotonic');
        }
        active = {
            claimId: candidate.claimId,
            ownerId: candidate.ownerId,
            requestKey: candidate.requestKey,
            fence: fence.toString(),
            claimedGeneration: generation.toString(),
            turnSeq: candidate.turnSeq as number,
            phase: candidate.phase as TaskTurnCoordinatorState['active'] extends infer A ? A extends { phase: infer P } ? P : never : never,
            runtimeSurface: candidate.runtimeSurface as TaskTurnRuntimeSurface,
            acquiredAt,
            heartbeatAt,
            expiresAt,
            ...(readRuntimeOwner(candidate.runtimeOwner, 'active.runtimeOwner', tenantId, taskId) !== undefined
                ? { runtimeOwner: readRuntimeOwner(candidate.runtimeOwner, 'active.runtimeOwner', tenantId, taskId)! }
                : {}),
        };
    }
    let dispatchIntent: TaskTurnCoordinatorState['dispatchIntent'];
    if (value.dispatchIntent !== undefined) {
        if (value.dispatchIntent === null || typeof value.dispatchIntent !== 'object' || Array.isArray(value.dispatchIntent)) {
            return invalid(tenantId, taskId, 'dispatchIntent must be an object');
        }
        const candidate = value.dispatchIntent as Record<string, unknown>;
        const generation = decimal(candidate.generation, 'dispatchIntent.generation', tenantId, taskId);
        const recovery = candidate.recovery === undefined
            ? undefined
            : (() => {
                  const rawRecovery = asRecord(candidate.recovery);
                  if (rawRecovery?.reason !== 'lease_expired' && rawRecovery?.reason !== 'worker_lifetime_lost') {
                      return invalid(tenantId, taskId, 'dispatchIntent recovery reason is invalid');
                  }
                  return {
                      reason: rawRecovery.reason as TaskTurnRecoveryReason,
                      sourceClaim: readRecoverySourceClaim(rawRecovery.sourceClaim, {
                          nextFence,
                          requested,
                          completed,
                          nextTurnSeq: value.nextTurnSeq as number,
                      }, tenantId, taskId),
                      ...(rawRecovery.stagedAt !== undefined
                          ? { stagedAt: timestamp(rawRecovery.stagedAt, 'dispatchIntent.recovery.stagedAt', tenantId, taskId) }
                          : {}),
                  };
              })();
        if ((recovery === undefined
                ? generation !== requested
                : generation !== BigInt(recovery.sourceClaim.claimedGeneration)) ||
            generation > requested || generation <= completed ||
            typeof candidate.deliveryKey !== 'string' || candidate.deliveryKey.length === 0 ||
            !['direct', 'in_process', 'hatchet'].includes(String(candidate.runtimeSurface))) {
            return invalid(tenantId, taskId, 'dispatchIntent is inconsistent');
        }
        const createdAt = timestamp(candidate.createdAt, 'dispatchIntent.createdAt', tenantId, taskId);
        const enqueuedAt = candidate.enqueuedAt !== undefined
            ? timestamp(candidate.enqueuedAt, 'dispatchIntent.enqueuedAt', tenantId, taskId)
            : undefined;
        if (candidate.turnSeq !== undefined &&
            (!Number.isSafeInteger(candidate.turnSeq) || (candidate.turnSeq as number) <= 0 ||
                (candidate.turnSeq as number) > (value.nextTurnSeq as number))) {
            return invalid(tenantId, taskId, 'dispatchIntent.turnSeq is invalid');
        }
        if (recovery !== undefined && (
            candidate.turnSeq !== recovery.sourceClaim.turnSeq ||
            candidate.runtimeSurface !== recovery.sourceClaim.runtimeSurface ||
            (taskId !== 'unknown'
                ? candidate.deliveryKey !== `${taskId}:turn-request:${generation}`
                : !candidate.deliveryKey.endsWith(`:turn-request:${generation}`))
        )) {
            return invalid(tenantId, taskId, 'dispatchIntent recovery lineage is inconsistent');
        }
        if (enqueuedAt !== undefined && Date.parse(enqueuedAt) < Date.parse(createdAt)) {
            return invalid(tenantId, taskId, 'dispatchIntent timestamps are not monotonic');
        }
        dispatchIntent = {
            generation: generation.toString(),
            ...(candidate.turnSeq !== undefined ? { turnSeq: candidate.turnSeq as number } : {}),
            deliveryKey: candidate.deliveryKey,
            runtimeSurface: candidate.runtimeSurface as TaskTurnRuntimeSurface,
            createdAt,
            ...(enqueuedAt !== undefined ? { enqueuedAt } : {}),
            ...(recovery !== undefined ? { recovery } : {}),
        };
    }
    if (active !== undefined && dispatchIntent !== undefined) {
        return invalid(tenantId, taskId, 'active claim and dispatch intent cannot coexist');
    }
    const explicitSurface = value.runtimeSurface;
    if (explicitSurface !== undefined && !['direct', 'in_process', 'hatchet'].includes(String(explicitSurface))) {
        return invalid(tenantId, taskId, 'runtimeSurface is invalid');
    }
    const runtimeSurface = (explicitSurface as TaskTurnRuntimeSurface | undefined) ??
        active?.runtimeSurface ?? dispatchIntent?.runtimeSurface;
    if (runtimeSurface !== undefined && active !== undefined && active.runtimeSurface !== runtimeSurface) {
        return invalid(tenantId, taskId, 'active runtime surface conflicts with task affinity');
    }
    if (runtimeSurface !== undefined && dispatchIntent !== undefined && dispatchIntent.runtimeSurface !== runtimeSurface) {
        return invalid(tenantId, taskId, 'dispatch runtime surface conflicts with task affinity');
    }
    return {
        schemaVersion: 1,
        ...(runtimeSurface !== undefined ? { runtimeSurface } : {}),
        nextFence: nextFence.toString(),
        nextTurnSeq: value.nextTurnSeq as number,
        requestedGeneration: requested.toString(),
        completedGeneration: completed.toString(),
        ...(active ? { active } : {}),
        ...(dispatchIntent ? { dispatchIntent } : {}),
    };
}

function writeState(snapshot: Record<string, unknown>, state: TaskTurnCoordinatorState): Record<string, unknown> {
    const meta = snapshot.meta !== null && typeof snapshot.meta === 'object' && !Array.isArray(snapshot.meta)
        ? snapshot.meta as Record<string, unknown>
        : {};
    return { ...snapshot, meta: { ...meta, turnCoordinator: state } };
}

function storageTime(value: string, tenantId: string, taskId: string): number {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return invalid(tenantId, taskId, 'storage clock is invalid');
    return parsed;
}

export function readTaskTurnCoordinator(
    snapshot: unknown,
    identity: { tenantId?: string; taskId?: string; allowInitialize?: boolean } = {}
): TaskTurnCoordinatorState {
    return readState(
        (snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {}) as Record<string, unknown>,
        identity.tenantId ?? 'unknown',
        identity.taskId ?? 'unknown',
        identity.allowInitialize ?? false
    );
}

export type RecoverExpiredTaskTurnClaimParams = {
    tenantId: string;
    taskId: string;
    expectedClaim: Pick<TaskTurnClaim, 'claimId' | 'fence' | 'claimedGeneration' | 'expiresAt'>;
    storageNow: string;
};

export function recoverExpiredTaskTurnClaimInSnapshot(
    snapshot: Record<string, unknown>,
    params: RecoverExpiredTaskTurnClaimParams
): {
    snapshot: Record<string, unknown>;
    disposition: TaskTurnRecoveryDisposition;
    sourceClaim?: ActiveTaskTurnClaim;
    recoveryLagMs?: number;
} {
    if (isTaskLifecycleTerminal(readTaskLifecycle(snapshot, params.taskId))) {
        return { snapshot, disposition: 'terminal' };
    }
    const state = readState(snapshot, params.tenantId, params.taskId);
    const expected = params.expectedClaim;
    const recovering = state.dispatchIntent?.recovery?.sourceClaim;
    if (recovering?.claimId === expected.claimId && recovering.fence === expected.fence) {
        return { snapshot, disposition: 'already_recovering', sourceClaim: recovering };
    }
    if (BigInt(state.completedGeneration) >= BigInt(expected.claimedGeneration)) {
        return { snapshot, disposition: 'settled' };
    }
    const active = state.active;
    if (active?.claimId !== expected.claimId || active.fence !== expected.fence ||
        active.claimedGeneration !== expected.claimedGeneration) {
        return { snapshot, disposition: 'competing_owner' };
    }
    const nowMs = storageTime(params.storageNow, params.tenantId, params.taskId);
    if (nowMs < Date.parse(active.expiresAt)) {
        return { snapshot, disposition: 'not_expired', sourceClaim: active };
    }
    const dispatchIntent: NonNullable<TaskTurnCoordinatorState['dispatchIntent']> = {
        generation: active.claimedGeneration,
        turnSeq: active.turnSeq,
        deliveryKey: `${params.taskId}:turn-request:${active.claimedGeneration}`,
        runtimeSurface: active.runtimeSurface,
        createdAt: params.storageNow,
        recovery: {
            reason: 'lease_expired',
            sourceClaim: active,
        },
    };
    return {
        snapshot: writeState(snapshot, { ...state, active: undefined, dispatchIntent }),
        disposition: 'recovery_staged',
        sourceClaim: active,
        recoveryLagMs: Math.max(0, nowMs - Date.parse(active.expiresAt)),
    };
}

export function recoverWorkerLostTaskTurnClaimInSnapshot(
    snapshot: Record<string, unknown>,
    params: {
        tenantId: string;
        taskId: string;
        expectedClaim: TaskTurnClaim;
        runtimeOwner: TaskTurnRuntimeOwner;
        storageNow: string;
    }
): {
    snapshot: Record<string, unknown>;
    disposition: Exclude<TaskTurnRecoveryDisposition, 'not_expired'>;
    sourceClaim?: ActiveTaskTurnClaim;
} {
    if (isTaskLifecycleTerminal(readTaskLifecycle(snapshot, params.taskId))) {
        return { snapshot, disposition: 'terminal' };
    }
    const state = readState(snapshot, params.tenantId, params.taskId);
    const expected = params.expectedClaim;
    const recovering = state.dispatchIntent?.recovery;
    if (recovering?.reason === 'worker_lifetime_lost' &&
        recovering.sourceClaim.claimId === expected.claimId &&
        recovering.sourceClaim.fence === expected.fence) {
        return { snapshot, disposition: 'already_recovering', sourceClaim: recovering.sourceClaim };
    }
    if (BigInt(state.completedGeneration) >= BigInt(expected.claimedGeneration)) {
        return { snapshot, disposition: 'settled' };
    }
    const active = state.active;
    if (active?.claimId !== expected.claimId || active.fence !== expected.fence ||
        active.claimedGeneration !== expected.claimedGeneration) {
        return { snapshot, disposition: 'competing_owner' };
    }
    if (active.runtimeSurface !== 'hatchet' || active.runtimeOwner === undefined ||
        active.runtimeOwner.installationId !== params.runtimeOwner.installationId ||
        active.runtimeOwner.instanceId !== params.runtimeOwner.instanceId ||
        active.runtimeOwner.workerName !== params.runtimeOwner.workerName ||
        active.runtimeOwner.rootProviderRunId !== params.runtimeOwner.rootProviderRunId) {
        return { snapshot, disposition: 'competing_owner', sourceClaim: active };
    }
    const dispatchIntent: NonNullable<TaskTurnCoordinatorState['dispatchIntent']> = {
        generation: active.claimedGeneration,
        turnSeq: active.turnSeq,
        deliveryKey: `${params.taskId}:turn-request:${active.claimedGeneration}`,
        runtimeSurface: active.runtimeSurface,
        createdAt: params.storageNow,
        recovery: {
            reason: 'worker_lifetime_lost',
            sourceClaim: active,
            stagedAt: params.storageNow,
        },
    };
    const stagedSnapshot = writeState(snapshot, { ...state, active: undefined, dispatchIntent });
    return {
        snapshot: appendWorkerLifetimeRecoveryProvenance(stagedSnapshot, active, params.storageNow),
        disposition: 'recovery_staged',
        sourceClaim: active,
    };
}

export async function recoverWorkerLostTaskTurnClaim(params: {
    session: SessionManager;
    tenantId: string;
    taskId: string;
    agentId?: string;
    expectedClaim: TaskTurnClaim;
    runtimeOwner: TaskTurnRuntimeOwner;
    now?: () => number;
}): Promise<{ disposition: Exclude<TaskTurnRecoveryDisposition, 'not_expired'>; sourceClaim?: ActiveTaskTurnClaim }> {
    const reconciled = await reconcileSnapshotMutation({
        session: params.session,
        tenantId: params.tenantId,
        sessionId: params.taskId,
        agentId: params.agentId,
        operation: 'task.turn.recover_worker_lifetime',
        now: params.now,
        mutate: ({ snapshot, storageNow }) => {
            const result = recoverWorkerLostTaskTurnClaimInSnapshot(snapshot, { ...params, storageNow });
            return result.disposition === 'recovery_staged'
                ? { kind: 'write' as const, snapshot: result.snapshot, value: result }
                : { kind: 'noop' as const, value: result };
        },
    });
    defaultMetricsRegistry.increment('task_turn_worker_recovery_total', {
        outcome: reconciled.value.disposition,
        runtimeSurface: 'hatchet',
    });
    return reconciled.value;
}

export async function recoverExpiredTaskTurnClaim(params: {
    session: SessionManager;
    tenantId: string;
    taskId: string;
    agentId?: string;
    expectedClaim: RecoverExpiredTaskTurnClaimParams['expectedClaim'];
    now?: () => number;
}): Promise<{ disposition: TaskTurnRecoveryDisposition; sourceClaim?: ActiveTaskTurnClaim }> {
    const reconciled = await reconcileSnapshotMutation({
        session: params.session,
        tenantId: params.tenantId,
        sessionId: params.taskId,
        agentId: params.agentId,
        operation: 'task.turn.recover_expired',
        now: params.now,
        mutate: ({ snapshot, storageNow }) => {
            const result = recoverExpiredTaskTurnClaimInSnapshot(snapshot, {
                tenantId: params.tenantId,
                taskId: params.taskId,
                expectedClaim: params.expectedClaim,
                storageNow,
            });
            return result.disposition === 'recovery_staged'
                ? { kind: 'write' as const, snapshot: result.snapshot, value: result }
                : { kind: 'noop' as const, value: result };
        },
    });
    defaultMetricsRegistry.increment('task_turn_expiry_recovery_total', {
        outcome: reconciled.value.disposition,
        runtimeSurface: reconciled.value.sourceClaim?.runtimeSurface ?? 'unknown',
    });
    if (reconciled.value.disposition === 'recovery_staged' && reconciled.value.recoveryLagMs !== undefined) {
        defaultMetricsRegistry.observeDuration(
            'task_turn_expiry_recovery_lag_ms',
            reconciled.value.recoveryLagMs,
            { runtimeSurface: reconciled.value.sourceClaim?.runtimeSurface ?? 'unknown' }
        );
        log.warn('Expired task turn lease staged for durable recovery', {
            tenantId: params.tenantId,
            taskId: params.taskId,
            claimId: reconciled.value.sourceClaim?.claimId,
            fence: reconciled.value.sourceClaim?.fence,
            generation: reconciled.value.sourceClaim?.claimedGeneration,
            turnSeq: reconciled.value.sourceClaim?.turnSeq,
            runtimeSurface: reconciled.value.sourceClaim?.runtimeSurface,
            recoveryLagMs: reconciled.value.recoveryLagMs,
        });
    }
    return {
        disposition: reconciled.value.disposition,
        ...(reconciled.value.sourceClaim !== undefined ? { sourceClaim: reconciled.value.sourceClaim } : {}),
    };
}

export function stageTaskTurnRequestInSnapshot(params: {
    snapshot: Record<string, unknown>;
    tenantId: string;
    taskId: string;
    requestKey: string;
    runtimeSurface: TaskTurnRuntimeSurface;
    storageNow: string;
    stageWake?: (snapshot: Record<string, unknown>, storageNow: string) => Record<string, unknown>;
    allowInitialize?: boolean;
}): { snapshot: Record<string, unknown>; state: TaskTurnCoordinatorState; staged: boolean } {
    const current = readState(params.snapshot, params.tenantId, params.taskId, params.allowInitialize);
    const runtimeSurface = current.runtimeSurface ?? params.runtimeSurface;
    if (current.runtimeSurface !== undefined && current.runtimeSurface !== params.runtimeSurface) {
        return invalid(
            params.tenantId,
            params.taskId,
            `runtime surface ${params.runtimeSurface} cannot serve task affined to ${current.runtimeSurface}`
        );
    }
    if (snapshotHasProcessedSegmentKey(params.snapshot, params.requestKey)) {
        return { snapshot: params.snapshot, state: current, staged: false };
    }
    let snapshot = params.stageWake?.(params.snapshot, params.storageNow) ?? params.snapshot;
    snapshot = addProcessedSegmentKey(snapshot, params.requestKey);
    const requested = BigInt(current.requestedGeneration) + 1n;
    const state: TaskTurnCoordinatorState = {
        ...current,
        runtimeSurface,
        requestedGeneration: requested.toString(),
        ...(!current.active && current.dispatchIntent?.recovery === undefined ? {
            dispatchIntent: {
                generation: requested.toString(),
                deliveryKey: `${params.taskId}:turn-request:${requested}`,
                runtimeSurface,
                createdAt: params.storageNow,
            },
        } : {}),
    };
    return { snapshot: writeState(snapshot, state), state, staged: true };
}

/**
 * Pre-authorizes the first root turn without consuming its delivery key.
 * Admission must not call stageTaskTurnRequestInSnapshot: that helper adds the
 * request key to processedKeys, causing the eventual start delivery to replay
 * instead of execute.
 */
export function admitInitialTaskTurnInSnapshot(params: {
    snapshot: Record<string, unknown>;
    tenantId: string;
    taskId: string;
    runtimeSurface: TaskTurnRuntimeSurface;
    storageNow: string;
}): {
    snapshot: Record<string, unknown>;
    state: TaskTurnCoordinatorState;
} {
    const current = readState(
        params.snapshot,
        params.tenantId,
        params.taskId,
        true
    );
    if (
        current.requestedGeneration !== '0' ||
        current.completedGeneration !== '0' ||
        current.active !== undefined ||
        current.dispatchIntent !== undefined
    ) {
        return invalid(params.tenantId, params.taskId, 'initial task turn is already initialized');
    }
    if (current.runtimeSurface !== undefined && current.runtimeSurface !== params.runtimeSurface) {
        return invalid(params.tenantId, params.taskId, 'initial task turn runtime surface conflicts');
    }
    const generation = '1';
    const state: TaskTurnCoordinatorState = {
        ...current,
        runtimeSurface: params.runtimeSurface,
        requestedGeneration: generation,
        dispatchIntent: {
            generation,
            deliveryKey: `${params.taskId}:turn-request:${generation}`,
            runtimeSurface: params.runtimeSurface,
            createdAt: params.storageNow,
        },
    };
    return { snapshot: writeState(params.snapshot, state), state };
}

/**
 * Advances already-authorized durable demand from inside another winning CAS
 * (for example a child/tool terminal claim). The caller's own tombstone is the
 * idempotency guard, so this helper deliberately does not add a processed key.
 */
export function advanceTaskTurnGenerationInSnapshot(params: {
    snapshot: Record<string, unknown>;
    tenantId: string;
    taskId: string;
    runtimeSurface: TaskTurnRuntimeSurface;
    storageNow: string;
}): { snapshot: Record<string, unknown>; state: TaskTurnCoordinatorState } {
    const current = readState(params.snapshot, params.tenantId, params.taskId);
    const runtimeSurface = current.runtimeSurface ?? params.runtimeSurface;
    const requested = BigInt(current.requestedGeneration) + 1n;
    const state: TaskTurnCoordinatorState = {
        ...current,
        runtimeSurface,
        requestedGeneration: requested.toString(),
        ...(!current.active && current.dispatchIntent?.recovery === undefined ? {
            dispatchIntent: {
                generation: requested.toString(),
                deliveryKey: `${params.taskId}:turn-request:${requested}`,
                runtimeSurface,
                createdAt: params.storageNow,
            },
        } : {}),
    };
    return { snapshot: writeState(params.snapshot, state), state };
}

/**
 * Consumes an admitted dispatch without a segment claim. This is reserved for
 * authoritative terminal shortcuts such as a durable result-cache hit.
 */
export function settleUnclaimedTaskTurnInSnapshot(params: {
    snapshot: Record<string, unknown>;
    tenantId: string;
    taskId: string;
    generation: string;
    deliveryKey: string;
}): { snapshot: Record<string, unknown>; changed: boolean } {
    const current = readState(params.snapshot, params.tenantId, params.taskId);
    if (BigInt(current.completedGeneration) >= BigInt(params.generation)) {
        return { snapshot: params.snapshot, changed: false };
    }
    if (
        current.active !== undefined ||
        current.dispatchIntent?.generation !== params.generation ||
        current.dispatchIntent.deliveryKey !== params.deliveryKey ||
        current.requestedGeneration !== params.generation
    ) {
        return invalid(params.tenantId, params.taskId, 'unclaimed terminal shortcut does not match dispatch intent');
    }
    return {
        snapshot: writeState(params.snapshot, {
            ...current,
            completedGeneration: params.generation,
            dispatchIntent: undefined,
        }),
        changed: true,
    };
}

/**
 * A durable task terminal wins over every queued, claimed, or executing turn.
 * This is used by out-of-band terminal reconciliation where no live claim is
 * trustworthy enough to complete normally.
 */
export function finalizeTaskTurnsForTerminalSnapshot(params: {
    snapshot: Record<string, unknown>;
    tenantId: string;
    taskId: string;
}): { snapshot: Record<string, unknown>; changed: boolean } {
    const meta = params.snapshot.meta;
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta) ||
        !Object.prototype.hasOwnProperty.call(meta, 'taskTurnCoordinator')) {
        return { snapshot: params.snapshot, changed: false };
    }
    const current = readState(params.snapshot, params.tenantId, params.taskId);
    if (current.active === undefined && current.dispatchIntent === undefined &&
        current.completedGeneration === current.requestedGeneration) {
        return { snapshot: params.snapshot, changed: false };
    }
    return {
        snapshot: writeState(params.snapshot, {
            ...current,
            completedGeneration: current.requestedGeneration,
            active: undefined,
            dispatchIntent: undefined,
        }),
        changed: true,
    };
}

export async function requestTaskTurn(params: {
    session: SessionManager;
    tenantId: string;
    taskId: string;
    agentId?: string;
    ownerId: string;
    requestKey: string;
    runtimeSurface?: TaskTurnRuntimeSurface;
    runtimeOwner?: TaskTurnRuntimeOwner;
    leaseMs?: number;
    takeoverGraceMs?: number;
    now?: () => number;
    claimIdFactory?: () => string;
    stageWake?: (snapshot: Record<string, unknown>, storageNow: string) => Record<string, unknown>;
    allowInitialize?: boolean;
    /** Claims an already-staged dispatch intent without accepting another wake. */
    recoveryGeneration?: string;
}): Promise<{ result: RequestTaskTurnResult; snapshot: Record<string, unknown> }> {
    const config = resolveTaskTurnLeaseConfig();
    const leaseMs = params.leaseMs ?? config.leaseMs;
    const takeoverGraceMs = params.takeoverGraceMs ?? config.takeoverGraceMs;
    const proposedClaimId = (params.claimIdFactory ?? randomUUID)();
    const surface = params.runtimeSurface ?? 'in_process';
    let futureSkewRecovered = false;
    let replacedClaim: TaskTurnClaim | undefined;
    let firstSubmissionClaim: { admittedAt: string; claimedAt: string; runtimeSurface: TaskTurnRuntimeSurface } | undefined;
    const reconciled = await reconcileSnapshotMutation<RequestTaskTurnResult>({
        session: params.session,
        tenantId: params.tenantId,
        sessionId: params.taskId,
        agentId: params.agentId,
        operation: 'task.turn.request',
        now: params.now,
        mutate: ({ snapshot, storageNow }) => {
            firstSubmissionClaim = undefined;
            replacedClaim = undefined;
            if (isTaskLifecycleTerminal(readTaskLifecycle(snapshot, params.taskId))) {
                return { kind: 'noop', value: { disposition: 'terminal', staged: false } };
            }
            const staged = params.recoveryGeneration !== undefined
                ? (() => {
                      const state = readState(snapshot, params.tenantId, params.taskId);
                      if (state.dispatchIntent?.generation !== params.recoveryGeneration ||
                          state.dispatchIntent.deliveryKey !== params.requestKey) {
                          return { snapshot, state, staged: false };
                      }
                      return { snapshot, state, staged: false };
                  })()
                : stageTaskTurnRequestInSnapshot({
                      snapshot,
                      tenantId: params.tenantId,
                      taskId: params.taskId,
                      requestKey: params.requestKey,
                      runtimeSurface: surface,
                      storageNow,
                      stageWake: params.stageWake,
                      allowInitialize: params.allowInitialize,
                  });
            let current = staged.state;
            let stagedSnapshot = staged.snapshot;
            if (current.dispatchIntent?.recovery !== undefined) {
                replacedClaim = current.dispatchIntent.recovery.sourceClaim;
            }
            if (params.recoveryGeneration === undefined && current.dispatchIntent?.recovery !== undefined) {
                const value: RequestTaskTurnResult = {
                    disposition: 'queued',
                    staged: staged.staged,
                    recoveryHint: {
                        reason: current.dispatchIntent.recovery.reason,
                        generation: current.dispatchIntent.generation,
                        deliveryKey: current.dispatchIntent.deliveryKey,
                        turnSeq: current.dispatchIntent.turnSeq!,
                    },
                };
                return staged.staged
                    ? { kind: 'write', snapshot: stagedSnapshot, value }
                    : { kind: 'noop', value };
            }
            const nowMs = storageTime(storageNow, params.tenantId, params.taskId);
            if (
                current.active !== undefined &&
                Date.parse(current.active.heartbeatAt) - nowMs > leaseMs
            ) {
                futureSkewRecovered = true;
                replacedClaim = current.active;
                current = {
                    ...current,
                    active: undefined,
                    dispatchIntent: {
                        generation: current.requestedGeneration,
                        ...(current.requestedGeneration === current.active.claimedGeneration
                            ? { turnSeq: current.active.turnSeq }
                            : {}),
                        deliveryKey: `${params.taskId}:turn-request:${current.requestedGeneration}`,
                        runtimeSurface: current.active.runtimeSurface,
                        createdAt: storageNow,
                    },
                };
                stagedSnapshot = writeState(stagedSnapshot, current);
            }
            if (current.active !== undefined) {
                const expiresAt = Date.parse(current.active.expiresAt);
                if (nowMs < expiresAt) {
                    const value: RequestTaskTurnResult = {
                        disposition: 'queued', activeClaim: current.active, staged: staged.staged,
                        availableAt: new Date(expiresAt + takeoverGraceMs).toISOString(),
                    };
                    return staged.staged ? { kind: 'write', snapshot: stagedSnapshot, value } : { kind: 'noop', value };
                }
                const availableAtMs = expiresAt + takeoverGraceMs;
                if (nowMs < availableAtMs) {
                    const value: RequestTaskTurnResult = {
                        disposition: 'queued', activeClaim: current.active, staged: staged.staged,
                        availableAt: new Date(availableAtMs).toISOString(),
                    };
                    return staged.staged ? { kind: 'write', snapshot: stagedSnapshot, value } : { kind: 'noop', value };
                }
                replacedClaim = current.active;
            }
            const requested = BigInt(current.requestedGeneration);
            const completed = BigInt(current.completedGeneration);
            if (params.recoveryGeneration !== undefined &&
                (current.dispatchIntent?.generation !== params.recoveryGeneration ||
                    current.dispatchIntent.deliveryKey !== params.requestKey)) {
                return { kind: 'noop', value: { disposition: 'matching_replay', staged: false } };
            }
            if (!staged.staged && requested <= completed) {
                return { kind: 'noop', value: { disposition: 'matching_replay', staged: false } };
            }
            const claimGeneration = current.dispatchIntent?.recovery !== undefined
                ? BigInt(current.dispatchIntent.generation)
                : requested;
            const fence = BigInt(current.nextFence) + 1n;
            const recoveredTurnSeq = current.active?.claimedGeneration === claimGeneration.toString()
                ? current.active.turnSeq
                : current.dispatchIntent?.generation === claimGeneration.toString()
                    ? current.dispatchIntent.turnSeq
                    : undefined;
            const turnSeq = recoveredTurnSeq ?? current.nextTurnSeq + 1;
            const claimSurface = current.runtimeSurface ?? current.dispatchIntent?.runtimeSurface ?? surface;
            if (claimSurface !== surface) {
                return invalid(
                    params.tenantId,
                    params.taskId,
                    `runtime surface ${surface} cannot claim task affined to ${claimSurface}`
                );
            }
            const claim: TaskTurnClaim = {
                claimId: proposedClaimId,
                fence: fence.toString(),
                ownerId: params.ownerId,
                requestKey: params.requestKey,
                claimedGeneration: claimGeneration.toString(),
                turnSeq,
                acquiredAt: storageNow,
                heartbeatAt: storageNow,
                expiresAt: new Date(nowMs + leaseMs).toISOString(),
                runtimeSurface: claimSurface,
                ...(claimSurface === 'hatchet' && params.runtimeOwner !== undefined
                    ? { runtimeOwner: params.runtimeOwner }
                    : {}),
            };
            const state: TaskTurnCoordinatorState = {
                ...current,
                runtimeSurface: claimSurface,
                nextFence: fence.toString(),
                nextTurnSeq: Math.max(current.nextTurnSeq, turnSeq),
                active: { ...claim, phase: 'claimed' },
                dispatchIntent: undefined,
            };
            let claimedSnapshot = writeState(stagedSnapshot, state);
            if (current.dispatchIntent?.recovery?.reason === 'worker_lifetime_lost') {
                claimedSnapshot = recordWorkerLifetimeReplacement(
                    claimedSnapshot,
                    current.dispatchIntent.recovery.sourceClaim,
                    claim,
                );
            }
            if (claimGeneration === 1n) {
                const meta = asRecord(claimedSnapshot.meta);
                const submission = asRecord(meta?.taskSubmission);
                if (
                    meta !== undefined &&
                    submission?.schemaVersion === 1 &&
                    typeof submission.admittedAt === 'string' &&
                    Number.isFinite(Date.parse(submission.admittedAt)) &&
                    submission.firstClaimedAt === undefined
                ) {
                    claimedSnapshot = {
                        ...claimedSnapshot,
                        meta: {
                            ...meta,
                            taskSubmission: { ...submission, firstClaimedAt: storageNow },
                        },
                    };
                    firstSubmissionClaim = {
                        admittedAt: submission.admittedAt,
                        claimedAt: storageNow,
                        runtimeSurface: claimSurface,
                    };
                }
            }
            return {
                kind: 'write',
                snapshot: claimedSnapshot,
                value: {
                    disposition: 'acquired',
                    claim,
                    ...(replacedClaim !== undefined ? { replacedClaim } : {}),
                    staged: staged.staged,
                },
            };
        },
    });
    defaultMetricsRegistry.increment('task_turn_request_total', { status: reconciled.value.disposition });
    if (futureSkewRecovered) {
        defaultMetricsRegistry.increment('task_turn_future_skew_recovery_total');
    }
    if (firstSubmissionClaim !== undefined) {
        defaultMetricsRegistry.observeDuration(
            'task_submission_admission_to_claim_ms',
            Date.parse(firstSubmissionClaim.claimedAt) - Date.parse(firstSubmissionClaim.admittedAt),
            { runtimeSurface: firstSubmissionClaim.runtimeSurface }
        );
    }
    return { result: reconciled.value, snapshot: reconciled.snapshot };
}

export async function renewTaskTurnClaim(params: {
    session: SessionManager;
    tenantId: string;
    taskId: string;
    agentId?: string;
    claim: TaskTurnClaim;
    leaseMs?: number;
    now?: () => number;
}): Promise<'renewed' | 'superseded' | 'terminal' | 'missing' | 'expired'> {
    const leaseMs = params.leaseMs ?? resolveTaskTurnLeaseConfig().leaseMs;
    const reconciled = await reconcileSnapshotMutation({
        session: params.session,
        tenantId: params.tenantId,
        sessionId: params.taskId,
        agentId: params.agentId,
        operation: 'task.turn.renew',
        now: params.now,
        mutate: ({ snapshot, storageNow }) => {
            if (isTaskLifecycleTerminal(readTaskLifecycle(snapshot, params.taskId))) {
                return { kind: 'noop', value: 'terminal' as const };
            }
            const state = readState(snapshot, params.tenantId, params.taskId);
            if (state.active === undefined) return { kind: 'noop', value: 'missing' as const };
            if (state.active.claimId !== params.claim.claimId || state.active.fence !== params.claim.fence) {
                return { kind: 'noop', value: 'superseded' as const };
            }
            const nowMs = storageTime(storageNow, params.tenantId, params.taskId);
            if (nowMs >= Date.parse(state.active.expiresAt)) return { kind: 'noop', value: 'expired' as const };
            return {
                kind: 'write',
                snapshot: writeState(snapshot, {
                    ...state,
                    active: {
                        ...state.active,
                        heartbeatAt: storageNow,
                        expiresAt: new Date(nowMs + leaseMs).toISOString(),
                    },
                }),
                value: 'renewed' as const,
            };
        },
    });
    return reconciled.value;
}

export async function releaseUnstartedTaskTurn(params: {
    session: SessionManager;
    tenantId: string;
    taskId: string;
    agentId?: string;
    claim: TaskTurnClaim;
    now?: () => number;
}): Promise<'released' | 'superseded' | 'terminal'> {
    const reconciled = await reconcileSnapshotMutation({
        session: params.session,
        tenantId: params.tenantId,
        sessionId: params.taskId,
        agentId: params.agentId,
        operation: 'task.turn.release_unstarted',
        now: params.now,
        mutate: ({ snapshot, storageNow }) => {
            if (isTaskLifecycleTerminal(readTaskLifecycle(snapshot, params.taskId))) {
                return { kind: 'noop', value: 'terminal' as const };
            }
            const state = readState(snapshot, params.tenantId, params.taskId);
            if (state.active?.claimId !== params.claim.claimId || state.active.fence !== params.claim.fence) {
                return { kind: 'noop', value: 'superseded' as const };
            }
            if (state.active.phase !== 'claimed') {
                // Once agent execution has started the generation must remain
                // recoverable through lease expiry; it cannot be made runnable
                // immediately by an ordinary release.
                return { kind: 'noop', value: 'superseded' as const };
            }
            const requested = BigInt(state.requestedGeneration);
            return {
                kind: 'write',
                snapshot: writeState(snapshot, {
                    ...state,
                    active: undefined,
                    dispatchIntent: {
                        generation: requested.toString(),
                        ...(requested.toString() === params.claim.claimedGeneration
                            ? { turnSeq: params.claim.turnSeq }
                            : {}),
                        deliveryKey: `${params.taskId}:turn-request:${requested}`,
                        runtimeSurface: params.claim.runtimeSurface,
                        createdAt: storageNow,
                    },
                }),
                value: 'released' as const,
            };
        },
    });
    return reconciled.value;
}

/** Compatibility alias for callers that only release a claim before agent execution. */
export const releaseTaskTurn = releaseUnstartedTaskTurn;

export function completeTaskTurnInSnapshot(
    snapshot: Record<string, unknown>,
    params: {
        tenantId?: string;
        taskId: string;
        claim: TaskTurnClaim;
        runtimeSurface?: TaskTurnRuntimeSurface;
        storageNow: string;
    }
): { snapshot: Record<string, unknown>; disposition: TaskTurnCompletionDisposition; scheduleNext: boolean } {
    const tenantId = params.tenantId ?? 'unknown';
    const state = readState(snapshot, tenantId, params.taskId);
    const nowMs = storageTime(params.storageNow, tenantId, params.taskId);
    if (state.active?.claimId !== params.claim.claimId || state.active.fence !== params.claim.fence ||
        nowMs >= Date.parse(state.active.expiresAt)) {
        return { snapshot, disposition: 'superseded', scheduleNext: false };
    }
    const claimed = BigInt(params.claim.claimedGeneration);
    const requested = BigInt(state.requestedGeneration);
    const terminal = isTaskLifecycleTerminal(readTaskLifecycle(snapshot, params.taskId));
    const completed = terminal ? requested : [BigInt(state.completedGeneration), claimed].reduce((a, b) => a > b ? a : b);
    const scheduleNext = !terminal && requested > completed;
    const next: TaskTurnCoordinatorState = {
        ...state,
        runtimeSurface: state.runtimeSurface ?? params.claim.runtimeSurface,
        completedGeneration: completed.toString(),
        active: undefined,
        dispatchIntent: scheduleNext
            ? {
                  generation: requested.toString(),
                  deliveryKey: `${params.taskId}:turn-request:${requested}`,
                  runtimeSurface: state.runtimeSurface ?? params.runtimeSurface ?? params.claim.runtimeSurface,
                  createdAt: params.storageNow,
              }
            : undefined,
    };
    return {
        snapshot: writeState(snapshot, next),
        disposition: terminal ? 'terminal' : 'committed',
        scheduleNext,
    };
}

export function assertCurrentTaskTurn(
    snapshot: Record<string, unknown>,
    params: {
        tenantId: string;
        taskId: string;
        claim: TaskTurnClaim;
        operation: string;
        storageNow?: string;
    }
): void {
    const active = readState(snapshot, params.tenantId, params.taskId).active;
    const current = active?.claimId === params.claim.claimId && active.fence === params.claim.fence;
    const unexpired = params.storageNow === undefined ||
        storageTime(params.storageNow, params.tenantId, params.taskId) < Date.parse(active?.expiresAt ?? '');
    if (current && unexpired && !isTaskLifecycleTerminal(readTaskLifecycle(snapshot, params.taskId))) return;
    throw new TaskTurnSupersededError({
        tenantId: params.tenantId,
        taskId: params.taskId,
        claimId: params.claim.claimId,
        fence: params.claim.fence,
        operation: params.operation,
    });
}

export function setTaskTurnPhaseInSnapshot(
    snapshot: Record<string, unknown>,
    params: {
        tenantId: string;
        taskId: string;
        claim: TaskTurnClaim;
        phase: 'executing' | 'committing';
        storageNow: string;
    }
): Record<string, unknown> {
    assertCurrentTaskTurn(snapshot, {
        tenantId: params.tenantId,
        taskId: params.taskId,
        claim: params.claim,
        operation: `turn.phase.${params.phase}`,
        storageNow: params.storageNow,
    });
    const state = readState(snapshot, params.tenantId, params.taskId);
    return writeState(snapshot, {
        ...state,
        active: { ...state.active!, phase: params.phase },
    });
}

export async function markTaskTurnExecuting(params: {
    session: SessionManager;
    tenantId: string;
    taskId: string;
    agentId?: string;
    claim: TaskTurnClaim;
}): Promise<Record<string, unknown>> {
    const reconciled = await reconcileSnapshotMutation({
        session: params.session,
        tenantId: params.tenantId,
        sessionId: params.taskId,
        agentId: params.agentId,
        operation: 'task.turn.executing',
        mutate: ({ snapshot, storageNow }) => ({
            kind: 'write',
            snapshot: setTaskTurnPhaseInSnapshot(snapshot, {
                tenantId: params.tenantId,
                taskId: params.taskId,
                claim: params.claim,
                phase: 'executing',
                storageNow,
            }),
            value: undefined,
        }),
    });
    return reconciled.snapshot;
}

export async function markTaskTurnDispatchEnqueued(params: {
    session: SessionManager;
    tenantId: string;
    taskId: string;
    agentId?: string;
    generation: string;
    deliveryKey: string;
    runtimeSurface: TaskTurnRuntimeSurface;
}): Promise<'marked' | 'stale'> {
    const reconciled = await reconcileSnapshotMutation({
        session: params.session,
        tenantId: params.tenantId,
        sessionId: params.taskId,
        agentId: params.agentId,
        operation: 'task.turn.dispatch_enqueued',
        mutate: ({ snapshot, storageNow }) => {
            const state = readState(snapshot, params.tenantId, params.taskId);
            if (state.dispatchIntent?.generation !== params.generation ||
                state.dispatchIntent.deliveryKey !== params.deliveryKey ||
                state.dispatchIntent.runtimeSurface !== params.runtimeSurface ||
                state.active !== undefined) {
                return { kind: 'noop', value: 'stale' as const };
            }
            return {
                kind: 'write',
                snapshot: writeState(snapshot, {
                    ...state,
                    dispatchIntent: { ...state.dispatchIntent, enqueuedAt: storageNow },
                }),
                value: 'marked' as const,
            };
        },
    });
    return reconciled.value;
}

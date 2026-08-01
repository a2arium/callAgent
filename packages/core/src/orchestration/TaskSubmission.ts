import { createHash } from 'node:crypto';
import type { ManifestProvenance } from '../types/turnTrace.js';
import type { TaskTurnRuntimeSurface } from './TaskTurnCoordinator.js';
import { admitInitialTaskTurnInSnapshot } from './TaskTurnCoordinator.js';
import {
    ensureTaskLifecycle,
    isTaskLifecycleTerminal,
    readTaskLifecycle,
    writeRootRunDeadline,
} from './TaskLifecycle.js';

export const TASK_SUBMISSION_PROTOCOL_VERSION = 1 as const;
export const MAX_TASK_RUN_TIMEOUT_MS = 2_147_483_647;

export type SubmitTaskParams = {
    tenantId: string;
    taskId: string;
    agentId: string;
    input: unknown;
    options?: { maxTurns?: number; taskRunTimeoutMs?: number };
    origin?: TaskSubmissionOrigin;
};

export type TaskSubmissionOrigin = {
    kind: 'schedule' | 'agent';
    scheduleId?: string;
    scheduleOccurrenceId?: string;
    submittedByTaskId?: string;
    scheduledFor?: string;
};

export type SubmitTaskResult = {
    taskId: string;
    status: 'accepted' | 'duplicate_active' | 'duplicate_terminal';
};

export type TaskSubmissionMetadata = {
    schemaVersion: 1;
    requestDigest: string;
    agentId: string;
    replyDeliveryMode: 'buffer';
    options: { maxTurns?: number; taskRunTimeoutMs?: number };
    admittedAt: string;
    firstClaimedAt?: string;
    origin?: TaskSubmissionOrigin;
};

export type TaskSubmissionErrorCode =
    | 'TASK_ADMISSION_UNAVAILABLE'
    | 'TASK_SUBMISSION_AGENT_UNAVAILABLE'
    | 'TASK_SUBMISSION_AGENT_UNSUPPORTED'
    | 'TASK_SUBMISSION_CONFLICT'
    | 'TASK_SUBMISSION_IDENTITY_INVALID'
    | 'TASK_SUBMISSION_INPUT_INVALID'
    | 'TASK_SUBMISSION_MANIFEST_INVALID'
    | 'TASK_SUBMISSION_OPTIONS_INVALID'
    | 'TASK_SUBMISSION_PUBLISH_TIMEOUT'
    | 'TASK_SUBMISSION_STATE_INCOMPATIBLE'
    | 'TASK_SUBMISSION_STATE_INVALID';

export class TaskSubmissionError extends Error {
    constructor(readonly code: TaskSubmissionErrorCode, message: string) {
        super(`${code}: ${message}`);
        this.name = 'TaskSubmissionError';
        Object.setPrototypeOf(this, TaskSubmissionError.prototype);
    }
}

function failJson(path: string, reason: string): never {
    throw new TaskSubmissionError(
        'TASK_SUBMISSION_INPUT_INVALID',
        `input at ${path} is not durable JSON: ${reason}`
    );
}

function canonicalJson(value: unknown, path: string, seen: WeakSet<object>): string {
    if (value === null) return 'null';
    switch (typeof value) {
        case 'string':
        case 'boolean':
            return JSON.stringify(value);
        case 'number':
            if (!Number.isFinite(value)) return failJson(path, 'numbers must be finite');
            return JSON.stringify(Object.is(value, -0) ? 0 : value);
        case 'undefined':
        case 'function':
        case 'symbol':
        case 'bigint':
            return failJson(path, `${typeof value} values are unsupported`);
        case 'object':
            break;
    }

    const object = value as object;
    if (seen.has(object)) return failJson(path, 'cycles are unsupported');
    seen.add(object);
    try {
        if (Array.isArray(value)) {
            const keys = Reflect.ownKeys(value);
            for (const key of keys) {
                if (key === 'length') continue;
                if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) {
                    return failJson(path, 'arrays cannot contain named or symbol properties');
                }
            }
            const entries: string[] = [];
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.prototype.hasOwnProperty.call(value, index)) {
                    return failJson(`${path}[${index}]`, 'sparse arrays are unsupported');
                }
                entries.push(canonicalJson(value[index], `${path}[${index}]`, seen));
            }
            return `[${entries.join(',')}]`;
        }

        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
            return failJson(path, 'only plain objects are supported');
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const symbols = Object.getOwnPropertySymbols(value);
        if (symbols.length > 0) return failJson(path, 'symbol properties are unsupported');
        const keys = Object.keys(descriptors).sort();
        const pairs: string[] = [];
        for (const key of keys) {
            const descriptor = descriptors[key]!;
            if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
                return failJson(`${path}.${key}`, 'properties must be enumerable data properties');
            }
            pairs.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, `${path}.${key}`, seen)}`);
        }
        return `{${pairs.join(',')}}`;
    } finally {
        seen.delete(object);
    }
}

export function canonicalizeTaskSubmissionInput(input: unknown): {
    input: unknown;
    canonical: string;
} {
    const canonical = canonicalJson(input, '$', new WeakSet<object>());
    return { input: JSON.parse(canonical) as unknown, canonical };
}

export function normalizeTaskSubmissionMaxTurns(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new TaskSubmissionError(
            'TASK_SUBMISSION_OPTIONS_INVALID',
            'options.maxTurns must be a positive safe integer'
        );
    }
    return value as number;
}

export function normalizeTaskSubmissionRunTimeout(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (
        !Number.isSafeInteger(value) ||
        (value as number) <= 0 ||
        (value as number) > MAX_TASK_RUN_TIMEOUT_MS
    ) {
        throw new TaskSubmissionError(
            'TASK_SUBMISSION_OPTIONS_INVALID',
            `options.taskRunTimeoutMs must be a positive integer no greater than ${MAX_TASK_RUN_TIMEOUT_MS}`
        );
    }
    return value as number;
}

const ORIGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function normalizeTaskSubmissionOrigin(value: unknown): TaskSubmissionOrigin | undefined {
    if (value === undefined) return undefined;
    const raw = record(value);
    if (raw === undefined || (raw.kind !== 'schedule' && raw.kind !== 'agent')) {
        throw new TaskSubmissionError('TASK_SUBMISSION_OPTIONS_INVALID', 'origin.kind must be schedule or agent');
    }
    const normalized: TaskSubmissionOrigin = { kind: raw.kind };
    for (const field of ['scheduleId', 'scheduleOccurrenceId', 'submittedByTaskId'] as const) {
        const candidate = raw[field];
        if (candidate === undefined) continue;
        if (typeof candidate !== 'string' || !ORIGIN_ID.test(candidate)) {
            throw new TaskSubmissionError('TASK_SUBMISSION_OPTIONS_INVALID', `origin.${field} is invalid`);
        }
        normalized[field] = candidate;
    }
    if (raw.scheduledFor !== undefined) {
        if (typeof raw.scheduledFor !== 'string' || !Number.isFinite(Date.parse(raw.scheduledFor))) {
            throw new TaskSubmissionError('TASK_SUBMISSION_OPTIONS_INVALID', 'origin.scheduledFor must be an ISO timestamp');
        }
        normalized.scheduledFor = new Date(raw.scheduledFor).toISOString();
    }
    if (normalized.kind === 'schedule' && (!normalized.scheduleId || !normalized.scheduleOccurrenceId)) {
        throw new TaskSubmissionError(
            'TASK_SUBMISSION_OPTIONS_INVALID',
            'scheduled submissions require scheduleId and scheduleOccurrenceId'
        );
    }
    if (normalized.kind === 'agent' && !normalized.submittedByTaskId) {
        throw new TaskSubmissionError(
            'TASK_SUBMISSION_OPTIONS_INVALID',
            'agent submissions require submittedByTaskId'
        );
    }
    return normalized;
}

export function taskSubmissionRequestDigest(params: {
    agentId: string;
    canonicalInput: string;
    maxTurns?: number;
    taskRunTimeoutMs?: number;
    origin?: TaskSubmissionOrigin;
}): string {
    // The timeout fragment is intentionally absent rather than null when the
    // option is omitted. This preserves the exact v1 digest bytes for tasks
    // admitted before taskRunTimeoutMs was introduced.
    const taskRunTimeoutFragment = params.taskRunTimeoutMs === undefined
        ? ''
        : `"taskRunTimeoutMs":${String(params.taskRunTimeoutMs)},`;
    const canonicalEnvelope =
        `{"agentId":${JSON.stringify(params.agentId)},` +
        `"input":${params.canonicalInput},` +
        `"maxTurns":${params.maxTurns === undefined ? 'null' : String(params.maxTurns)},` +
        taskRunTimeoutFragment +
        `"origin":${params.origin === undefined ? 'null' : canonicalJson(params.origin, '$.origin', new WeakSet<object>())},` +
        `"replyDeliveryMode":"buffer",` +
        `"schemaVersion":${TASK_SUBMISSION_PROTOCOL_VERSION}}`;
    return createHash('sha256').update(canonicalEnvelope, 'utf8').digest('hex');
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

export function readTaskSubmissionMetadata(
    snapshot: Record<string, unknown>
): TaskSubmissionMetadata | undefined {
    const raw = record(record(snapshot.meta)?.taskSubmission);
    if (raw === undefined) return undefined;
    const options = record(raw.options);
    const origin = normalizeTaskSubmissionOrigin(raw.origin);
    const maxTurns = options?.maxTurns;
    const taskRunTimeoutMs = options?.taskRunTimeoutMs;
    if (
        raw.schemaVersion !== TASK_SUBMISSION_PROTOCOL_VERSION ||
        typeof raw.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.requestDigest) ||
        typeof raw.agentId !== 'string' || raw.agentId.length === 0 ||
        raw.replyDeliveryMode !== 'buffer' ||
        options === undefined ||
        (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || (maxTurns as number) <= 0)) ||
        (taskRunTimeoutMs !== undefined && (
            !Number.isSafeInteger(taskRunTimeoutMs) ||
            (taskRunTimeoutMs as number) <= 0 ||
            (taskRunTimeoutMs as number) > MAX_TASK_RUN_TIMEOUT_MS
        )) ||
        typeof raw.admittedAt !== 'string' || !Number.isFinite(Date.parse(raw.admittedAt)) ||
        (raw.firstClaimedAt !== undefined &&
            (typeof raw.firstClaimedAt !== 'string' || !Number.isFinite(Date.parse(raw.firstClaimedAt))))
    ) {
        throw new TaskSubmissionError(
            'TASK_SUBMISSION_STATE_INVALID',
            'stored task submission metadata is malformed or unsupported'
        );
    }
    return {
        schemaVersion: 1,
        requestDigest: raw.requestDigest,
        agentId: raw.agentId,
        replyDeliveryMode: 'buffer',
        options: {
            ...(maxTurns !== undefined ? { maxTurns: maxTurns as number } : {}),
            ...(taskRunTimeoutMs !== undefined
                ? { taskRunTimeoutMs: taskRunTimeoutMs as number }
                : {}),
        },
        admittedAt: raw.admittedAt,
        ...(origin ? { origin } : {}),
        ...(typeof raw.firstClaimedAt === 'string' ? { firstClaimedAt: raw.firstClaimedAt } : {}),
    };
}

export function classifyTaskSubmission(params: {
    snapshot: Record<string, unknown>;
    taskId: string;
    requestDigest: string;
}): SubmitTaskResult['status'] | 'missing' {
    const stored = readTaskSubmissionMetadata(params.snapshot);
    if (stored === undefined) return 'missing';
    if (stored.requestDigest !== params.requestDigest) {
        throw new TaskSubmissionError(
            'TASK_SUBMISSION_CONFLICT',
            'task identity is already bound to a different submission'
        );
    }
    return isTaskLifecycleTerminal(readTaskLifecycle(params.snapshot, params.taskId))
        ? 'duplicate_terminal'
        : 'duplicate_active';
}

export function buildAdmittedTaskSnapshot(params: {
    tenantId: string;
    taskId: string;
    agentId: string;
    input: unknown;
    maxTurns?: number;
    taskRunTimeoutMs?: number;
    requestDigest: string;
    manifestProvenance: ManifestProvenance;
    runtimeSurface: TaskTurnRuntimeSurface;
    storageNow: string;
    origin?: TaskSubmissionOrigin;
}): { snapshot: Record<string, unknown>; generation: string; deliveryKey: string } {
    let snapshot: Record<string, unknown> = {
        meta: {
            agentId: params.agentId,
            initialInput: params.input,
            manifestProvenance: params.manifestProvenance,
            replyDeliveryMode: 'buffer',
            ...(params.maxTurns !== undefined ? { budgets: { maxTurns: params.maxTurns } } : {}),
            taskSubmission: {
                schemaVersion: TASK_SUBMISSION_PROTOCOL_VERSION,
                requestDigest: params.requestDigest,
                agentId: params.agentId,
                replyDeliveryMode: 'buffer',
                options: {
                    ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
                    ...(params.taskRunTimeoutMs !== undefined
                        ? { taskRunTimeoutMs: params.taskRunTimeoutMs }
                        : {}),
                },
                admittedAt: params.storageNow,
                ...(params.origin ? { origin: params.origin } : {}),
            } satisfies TaskSubmissionMetadata,
        },
    };
    snapshot = ensureTaskLifecycle(snapshot, {
        taskId: params.taskId,
        rootTaskId: params.taskId,
        ancestorTaskIds: [],
    });
    if (params.taskRunTimeoutMs !== undefined) {
        const startedAtMs = Date.parse(params.storageNow);
        snapshot = writeRootRunDeadline(snapshot, {
            timeoutMs: params.taskRunTimeoutMs,
            startedAt: params.storageNow,
            expiresAt: new Date(startedAtMs + params.taskRunTimeoutMs).toISOString(),
            source: 'task_submission',
            timerToken: 'root-run-timeout',
        });
    }
    const admitted = admitInitialTaskTurnInSnapshot({
        snapshot,
        tenantId: params.tenantId,
        taskId: params.taskId,
        runtimeSurface: params.runtimeSurface,
        storageNow: params.storageNow,
    });
    return {
        snapshot: admitted.snapshot,
        generation: admitted.state.dispatchIntent!.generation,
        deliveryKey: admitted.state.dispatchIntent!.deliveryKey,
    };
}

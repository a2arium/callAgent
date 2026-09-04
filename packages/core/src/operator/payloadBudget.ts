export type PayloadEnvelope =
    | { state: 'available'; contentType: string; value: unknown; truncated: boolean }
    | { state: 'artifact_only'; artifactId: string; summary?: string }
    | { state: 'hidden'; reason: string }
    | { state: 'not_captured'; reason?: string }
    | { state: 'too_large'; limitBytes: number; actualBytes?: number; summary?: string };

export type PayloadBudgetCode =
    | 'LIMIT_WM_SNAPSHOT_TOO_LARGE'
    | 'LIMIT_EVENT_PAYLOAD_TOO_LARGE'
    | 'LIMIT_DRIVER_METADATA_TOO_LARGE'
    | 'LIMIT_HATCHET_PAYLOAD_TOO_LARGE'
    | 'LIMIT_OPERATOR_RESPONSE_TOO_LARGE'
    | 'ARTIFACT_RESOLUTION_FAILED';

export type PayloadBudgetResult<T> =
    | { ok: true; value: T; sizeBytes: number }
    | {
          ok: false;
          value: T;
          code: PayloadBudgetCode;
          limitBytes: number;
          actualBytes: number;
          summary: string;
          fieldPath?: string;
      };

export const DEFAULT_EVENT_PAYLOAD_MAX_BYTES = 256 * 1024;
export const DEFAULT_DRIVER_METADATA_MAX_BYTES = 64 * 1024;
export const DEFAULT_HATCHET_PAYLOAD_MAX_BYTES = 64 * 1024;
export const DEFAULT_OPERATOR_RAW_PAYLOAD_MAX_BYTES = 1024 * 1024;
/** Smallest size that can safely contain the mandatory root graph shell. */
export const MIN_OPERATOR_RAW_PAYLOAD_MAX_BYTES = 16 * 1024;

const COMPACT_STRING_LIMIT = 1200;
const COMPACT_ARRAY_ITEMS = 8;
const COMPACT_OBJECT_KEYS = 24;
const COMPACT_DEPTH = 5;

export function readByteBudget(envName: string, fallback: number): number {
    const parsed = Number(process.env[envName]);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function measureJsonBytes(value: unknown): number {
    return Buffer.byteLength(safeJsonStringify(value), 'utf8');
}

export function enforcePayloadBudget<T>(
    value: T,
    params: {
        code: PayloadBudgetCode;
        limitBytes: number;
        fieldPath?: string;
        summary?: string;
    }
): PayloadBudgetResult<T> {
    const sizeBytes = measureJsonBytes(value);
    if (sizeBytes <= params.limitBytes) {
        return { ok: true, value, sizeBytes };
    }
    const compacted = compactPayload(value) as T;
    const compactedBytes = measureJsonBytes(compacted);
    return {
        ok: false,
        value: compactedBytes <= params.limitBytes
            ? compacted
            : budgetEnvelope(params.code, params.limitBytes, sizeBytes, params.summary) as T,
        code: params.code,
        limitBytes: params.limitBytes,
        actualBytes: sizeBytes,
        summary: params.summary ?? `${params.code}: payload exceeded ${params.limitBytes} bytes.`,
        ...(params.fieldPath ? { fieldPath: params.fieldPath } : {}),
    };
}

export function compactOperationalEventPayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
    const compacted = compactPayload(payload);
    if (!compacted || typeof compacted !== 'object' || Array.isArray(compacted)) {
        return compacted as Record<string, unknown>;
    }
    const output = compacted as Record<string, unknown>;
    for (const key of [
        'taskId',
        'agentId',
        'childAgentId',
        'childTaskId',
        'parentTaskId',
        'rootTaskId',
        'token',
        'traceId',
        'spanId',
        'turnSeq',
        'turnId',
        'turnTraceId',
        'status',
        'kind',
    ]) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) {
            output[key] = payload[key];
        }
    }
    if (type === 'turn.completed' && isRecord(payload.transition)) {
        output.transition = compactTransition(payload.transition);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'error')) {
        output.error = compactPayload(payload.error);
    }
    return output;
}

export function operatorPayloadEnvelope(value: unknown, limitBytes = readOperatorRawPayloadMaxBytes()): PayloadEnvelope {
    if (value === undefined || value === null) {
        return { state: 'not_captured' };
    }
    const sizeBytes = measureJsonBytes(value);
    if (sizeBytes <= limitBytes) {
        return {
            state: 'available',
            contentType: 'application/json',
            value,
            truncated: false,
        };
    }
    return {
        state: 'too_large',
        limitBytes,
        actualBytes: sizeBytes,
        summary: summarizePayload(value),
    };
}

export function isPayloadEnvelope(value: unknown): value is PayloadEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const state = (value as Record<string, unknown>).state;
    return state === 'available' ||
        state === 'artifact_only' ||
        state === 'hidden' ||
        state === 'not_captured' ||
        state === 'too_large';
}

export function budgetEnvelope(
    code: PayloadBudgetCode,
    limitBytes: number,
    actualBytes?: number,
    summary?: string
): PayloadEnvelope {
    return {
        state: 'too_large',
        limitBytes,
        ...(actualBytes !== undefined ? { actualBytes } : {}),
        summary: summary ?? `${code}: payload exceeded ${limitBytes} bytes.`,
    };
}

export function budgetErrorPayload(params: {
    code: PayloadBudgetCode;
    message?: string;
    limitBytes: number;
    actualBytes?: number;
    fieldPath?: string;
    eventType?: string;
}): Record<string, unknown> {
    return {
        code: params.code,
        message: params.message ?? `${params.code}: payload exceeded ${params.limitBytes} bytes.`,
        limitBytes: params.limitBytes,
        ...(params.actualBytes !== undefined ? { actualBytes: params.actualBytes } : {}),
        ...(params.fieldPath ? { fieldPath: params.fieldPath } : {}),
        ...(params.eventType ? { eventType: params.eventType } : {}),
    };
}

export function compactPayload(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'string') {
        if (value.length <= COMPACT_STRING_LIMIT) {
            return value;
        }
        return `${value.slice(0, COMPACT_STRING_LIMIT)}... [truncated ${value.length} chars]`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (Array.isArray(value)) {
        if (depth >= COMPACT_DEPTH) {
            return `[truncated array, ${value.length} items]`;
        }
        const items = value.slice(0, COMPACT_ARRAY_ITEMS).map((item) => compactPayload(item, depth + 1));
        return value.length > COMPACT_ARRAY_ITEMS
            ? [...items, `... [truncated ${value.length - COMPACT_ARRAY_ITEMS} items]`]
            : items;
    }
    if (typeof value === 'object') {
        if (isArtifactLike(value)) {
            return compactArtifactMetadata(value);
        }
        if (depth >= COMPACT_DEPTH) {
            return `[truncated object, ${Object.keys(value as Record<string, unknown>).length} keys]`;
        }
        const record = value as Record<string, unknown>;
        const output: Record<string, unknown> = {};
        const entries = Object.entries(record).slice(0, COMPACT_OBJECT_KEYS);
        for (const [key, entry] of entries) {
            output[key] = compactPayload(entry, depth + 1);
        }
        const omitted = Object.keys(record).length - entries.length;
        if (omitted > 0) {
            output.__truncatedKeys = omitted;
        }
        return output;
    }
    return String(value);
}

export function summarizePayload(value: unknown): string {
    if (typeof value === 'string') {
        return value.length > 160 ? `${value.slice(0, 160)}... [${value.length} chars]` : value;
    }
    if (Array.isArray(value)) {
        return `Array with ${value.length} item${value.length === 1 ? '' : 's'}.`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value as Record<string, unknown>);
        return `Object with ${keys.length} field${keys.length === 1 ? '' : 's'}${keys.length > 0 ? `: ${keys.slice(0, 8).join(', ')}` : ''}.`;
    }
    return String(value);
}

export function readEventPayloadMaxBytes(): number {
    return readByteBudget('CALLAGENT_EVENT_PAYLOAD_MAX_BYTES', DEFAULT_EVENT_PAYLOAD_MAX_BYTES);
}

export function readDriverMetadataMaxBytes(): number {
    return readByteBudget('CALLAGENT_DRIVER_METADATA_MAX_BYTES', DEFAULT_DRIVER_METADATA_MAX_BYTES);
}

export function readHatchetPayloadMaxBytes(): number {
    return readByteBudget('CALLAGENT_HATCHET_PAYLOAD_MAX_BYTES', DEFAULT_HATCHET_PAYLOAD_MAX_BYTES);
}

export function readOperatorRawPayloadMaxBytes(): number {
    const configured = readByteBudget('CALLAGENT_OPERATOR_RAW_PAYLOAD_MAX_BYTES', DEFAULT_OPERATOR_RAW_PAYLOAD_MAX_BYTES);
    return Math.max(MIN_OPERATOR_RAW_PAYLOAD_MAX_BYTES, configured);
}

export function validateOperatorRawPayloadBudget(env: NodeJS.ProcessEnv = process.env): void {
    const raw = env.CALLAGENT_OPERATOR_RAW_PAYLOAD_MAX_BYTES;
    if (raw === undefined || raw.trim().length === 0) return;
    const configured = Number(raw);
    if (!Number.isFinite(configured) || configured < MIN_OPERATOR_RAW_PAYLOAD_MAX_BYTES) {
        throw new Error(
            `CALLAGENT_OPERATOR_RAW_PAYLOAD_MAX_BYTES must be at least ${MIN_OPERATOR_RAW_PAYLOAD_MAX_BYTES} bytes.`,
        );
    }
}

function compactTransition(transition: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (typeof transition.kind === 'string') {
        result.kind = transition.kind;
    }
    if (Object.prototype.hasOwnProperty.call(transition, 'token')) {
        result.token = transition.token;
    }
    if (isRecord(transition.result)) {
        result.result = compactTransitionResult(transition.result);
    } else if (Object.prototype.hasOwnProperty.call(transition, 'result')) {
        result.result = compactPayload(transition.result);
    }
    return result;
}

function compactTransitionResult(result: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(result, 'ok')) {
        output.ok = result.ok;
    }
    if (Object.prototype.hasOwnProperty.call(result, 'error')) {
        output.error = compactPayload(result.error);
    }
    if (Object.prototype.hasOwnProperty.call(result, 'output')) {
        output.output = compactPayload(result.output);
    }
    if (Object.prototype.hasOwnProperty.call(result, 'data')) {
        output.data = compactPayload(result.data);
    }
    if (Object.prototype.hasOwnProperty.call(result, 'artifacts')) {
        output.artifacts = compactPayload(result.artifacts);
    }
    return output;
}

function safeJsonStringify(value: unknown): string {
    try {
        return JSON.stringify(value, (_key, nested) => typeof nested === 'bigint' ? nested.toString() : nested) ?? 'null';
    } catch {
        return JSON.stringify(compactPayload(value));
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isArtifactLike(value: object): boolean {
    const record = value as Record<string, unknown>;
    return record.kind === 'artifact_local' ||
        record.state === 'artifact_only' ||
        typeof record.artifactId === 'string' ||
        typeof record.id === 'string' && (record.kind === 'artifact' || record.type === 'artifact') ||
        typeof record.uri === 'string' && String(record.uri).startsWith('artifact:');
}

function compactArtifactMetadata(value: object): PayloadEnvelope {
    const record = value as Record<string, unknown>;
    const artifactId =
        typeof record.artifactId === 'string'
            ? record.artifactId
            : typeof record.id === 'string'
                ? record.id
                : typeof record.uri === 'string'
                    ? record.uri
                    : record.kind === 'artifact_local'
                        ? 'local'
                        : 'unknown';
    const mimeType = typeof record.mimeType === 'string' ? record.mimeType : undefined;
    const estimatedSize =
        typeof record.estimatedSize === 'number'
            ? record.estimatedSize
            : typeof record.size === 'number'
                ? record.size
                : record.kind === 'artifact_local' && typeof record.value === 'string'
                    ? record.value.length
                    : undefined;
    return {
        state: 'artifact_only',
        artifactId,
        summary: artifactId === 'local'
            ? 'Local artifact'
            : artifactId === 'unknown'
                ? 'Artifact reference'
                : `Artifact ${artifactId}`,
        ...(mimeType ? { mimeType } : {}),
        ...(estimatedSize !== undefined ? { estimatedSize } : {}),
    };
}

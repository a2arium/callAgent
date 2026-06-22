import type {
    PendingSummary,
    InboxObservationSummary,
    JsonValue,
    TurnUsage,
} from '../types/turnTrace.js';
import type { UsageInfo, PricingInfo } from './nodes/TelemetryNode.js';

const DEFAULT_MAX_DEPTH = 4;

/** Default max characters per string field sent to Opik (override with CALLAGENT_OPIK_MAX_STRING_CHARS). */
const OPIK_DEFAULT_MAX_STRING_CHARS = 8192;

const OPIK_DEFAULT_SANITIZE_DEPTH = 18;

const OPIK_DEFAULT_MAX_ARRAY_LENGTH = 128;

type OpikSanitizeOptions = {
    maxStringChars: number;
    maxDepth: number;
    maxArrayLength: number;
};

function readOpikMaxStringChars(): number {
    const raw = process.env.CALLAGENT_OPIK_MAX_STRING_CHARS;
    if (raw == null || raw === '') return OPIK_DEFAULT_MAX_STRING_CHARS;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : OPIK_DEFAULT_MAX_STRING_CHARS;
}

/**
 * Deep-copy and shrink payloads for external telemetry (Opik): long strings, huge arrays,
 * and artifact markers (kind === "artifact") are trimmed so traces stay under typical API limits.
 */
export function sanitizeForOpikPayload(
    value: unknown,
    options?: Partial<OpikSanitizeOptions>
): unknown {
    const opts: OpikSanitizeOptions = {
        maxStringChars: options?.maxStringChars ?? readOpikMaxStringChars(),
        maxDepth: options?.maxDepth ?? OPIK_DEFAULT_SANITIZE_DEPTH,
        maxArrayLength: options?.maxArrayLength ?? OPIK_DEFAULT_MAX_ARRAY_LENGTH,
    };
    return sanitizeForOpikPayloadInner(value, opts, 0);
}

function sanitizeForOpikPayloadInner(
    value: unknown,
    opts: OpikSanitizeOptions,
    depth: number
): unknown {
    if (depth > opts.maxDepth) {
        return '[max_depth]';
    }
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'string') {
        if (value.length <= opts.maxStringChars) {
            return value;
        }
        return `${value.slice(0, opts.maxStringChars)}… [truncated ${value.length} chars]`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'bigint') {
        return `${String(value)}n`;
    }
    if (typeof value === 'function') {
        return undefined;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Array.isArray(value)) {
        const cap = opts.maxArrayLength;
        const slice = value.slice(0, cap);
        const out = slice.map((item) =>
            sanitizeForOpikPayloadInner(item, opts, depth + 1)
        );
        if (value.length > cap) {
            out.push(`… [truncated ${value.length - cap} array items]`);
        }
        return out;
    }
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        if (obj.kind === 'artifact') {
            const slim: Record<string, unknown> = { kind: 'artifact' };
            for (const k of ['id', 'mimeType', 'estimatedSize', 'name', 'uri'] as const) {
                if (k in obj && obj[k] !== undefined) {
                    slim[k] = sanitizeForOpikPayloadInner(obj[k], opts, depth + 1);
                }
            }
            return slim;
        }
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
            const next = sanitizeForOpikPayloadInner(v, opts, depth + 1);
            if (next !== undefined) {
                result[k] = next;
            }
        }
        return result;
    }
    return String(value);
}

/**
 * Extract token information from pending state without leaking raw transport wrappers.
 */
export function summarizePending(
    pending: Record<string, unknown>
): PendingSummary {
    const inputs = pending.inputs as Record<string, unknown> | undefined;
    const tools = pending.tools as Record<string, unknown> | undefined;
    const children = pending.children as Record<string, unknown> | undefined;
    const events = pending.events as Record<string, unknown> | undefined;
    const controlVars = pending.controlVars as Record<string, unknown> | undefined;

    const inputTokens = inputs ? Object.keys(inputs) : [];
    const toolTokens = tools
        ? Object.entries(tools).map(([token, v]) => ({
              token,
              tool:
                  typeof v === 'object' && v !== null && 'tool' in v
                      ? String((v as { tool?: string }).tool ?? '')
                      : undefined,
          }))
        : [];
    const childTokens = children
        ? Object.entries(children).map(([token, v]) => ({
              token,
              agentId:
                  typeof v === 'object' && v !== null && 'agentId' in v
                      ? String((v as { agentId?: string }).agentId ?? '')
                      : undefined,
          }))
        : [];
    const eventTokens = events
        ? Object.entries(events).map(([token, v]) => ({
              token,
              type:
                  typeof v === 'object' && v !== null && 'type' in v
                      ? String((v as { type?: string }).type ?? '')
                      : undefined,
          }))
        : [];
    const stage =
        controlVars && typeof controlVars.stage === 'string'
            ? controlVars.stage
            : undefined;

    return {
        inputTokens,
        toolTokens,
        childTokens,
        ...(eventTokens.length > 0 ? { eventTokens } : {}),
        ...(stage !== undefined ? { stage } : {}),
    };
}

/**
 * Build a compact summary of inbox observations (source, kind, token) for TurnTrace.
 */
export function summarizeInbox(inbox: unknown[]): InboxObservationSummary[] {
    return inbox.map((item) => {
        const obs =
            typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
        const source = typeof obs.source === 'string' ? obs.source : 'unknown';
        const kind = typeof obs.kind === 'string' ? obs.kind : 'unknown';
        const payload =
            typeof obs.payload === 'object' && obs.payload !== null
                ? (obs.payload as Record<string, unknown>)
                : {};
        const token =
            typeof payload.token === 'string' ? payload.token : undefined;
        return {
            source,
            kind,
            ...(token !== undefined ? { hasToken: true, token } : {}),
        };
    });
}

/**
 * Recursively truncate large objects to prevent trace bloat.
 * Returns a JSON-serializable value with limited depth.
 */
export function compactModuleOutput(
    output: unknown,
    maxDepth: number = DEFAULT_MAX_DEPTH
): JsonValue {
    if (maxDepth <= 0) {
        if (typeof output === 'object' && output !== null) {
            return '[truncated]';
        }
    }
    if (
        output === null ||
        output === undefined ||
        typeof output === 'string' ||
        typeof output === 'number' ||
        typeof output === 'boolean'
    ) {
        return output as JsonValue;
    }
    if (Array.isArray(output)) {
        return output.map((item) =>
            compactModuleOutput(item, maxDepth - 1)
        ) as JsonValue;
    }
    if (typeof output === 'object') {
        const obj = output as Record<string, unknown>;
        const result: { [key: string]: JsonValue } = {};
        for (const [k, v] of Object.entries(obj)) {
            result[k] = compactModuleOutput(v, maxDepth - 1);
        }
        return result;
    }
    if (typeof output === 'function') {
        return undefined;
    }
    return null;
}

/**
 * Aggregate usage from LLM nodes into a single TurnUsage.
 */
export function aggregateUsage(
    llmNodes: Array<{ usage: UsageInfo; pricing: PricingInfo }>
): TurnUsage {
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let currency = 'USD';
    for (const node of llmNodes) {
        inputTokens += node.usage.inputTokens ?? 0;
        outputTokens += node.usage.outputTokens ?? 0;
        totalTokens += node.usage.totalTokens ?? 0;
        totalCost += node.pricing?.cost ?? 0;
        if (node.pricing?.currency) {
            currency = node.pricing.currency;
        }
    }
    return {
        inputTokens: inputTokens || undefined,
        outputTokens: outputTokens || undefined,
        totalTokens: totalTokens || undefined,
        totalCost: totalCost || undefined,
        currency,
        llmCalls: llmNodes.length || undefined,
    };
}

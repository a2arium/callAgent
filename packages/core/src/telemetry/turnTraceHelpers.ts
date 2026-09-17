import type {
    PendingSummary,
    InboxObservationSummary,
    JsonValue,
    TurnUsage,
} from '../types/turnTrace.js';
import type { UsageInfo, PricingInfo } from './nodes/TelemetryNode.js';

const DEFAULT_MAX_DEPTH = 4;

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

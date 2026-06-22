import type { Duration } from '@hatchet-dev/typescript-sdk/v1/client/duration.js';

const DEFAULT_EXECUTION_TIMEOUT_MS = 30 * 60 * 1000;
const EXECUTION_TIMEOUT_GRACE_MS = 60 * 1000;

export type AgentRuntimeBudgetSource = {
    resolved?: {
        runtimeManifest?: {
            budgets?: {
                latencyMs?: number;
                [key: string]: unknown;
            };
        };
    };
};

export function resolveHatchetExecutionTimeoutMs(
    budgets?: { latencyMs?: number } | null
): number {
    const latencyMs = budgets?.latencyMs;
    if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs <= 0) {
        return DEFAULT_EXECUTION_TIMEOUT_MS;
    }
    return latencyMs + EXECUTION_TIMEOUT_GRACE_MS;
}

export function formatHatchetDuration(ms: number): Duration {
    const minutes = Math.max(1, Math.ceil(ms / 60_000));
    return `${minutes}m` as Duration;
}

export function resolveHatchetExecutionTimeout(
    budgets?: { latencyMs?: number } | null
): Duration {
    return formatHatchetDuration(resolveHatchetExecutionTimeoutMs(budgets));
}

export function resolveAgentHatchetExecutionTimeout(
    agent?: AgentRuntimeBudgetSource | null
): Duration {
    return resolveHatchetExecutionTimeout(agent?.resolved?.runtimeManifest?.budgets);
}

export function resolveSharedSegmentHatchetExecutionTimeout(
    agents: Array<AgentRuntimeBudgetSource | null | undefined>
): Duration {
    if (agents.length === 0) {
        return resolveHatchetExecutionTimeout();
    }
    const maxMs = Math.max(
        ...agents.map((agent) =>
            resolveHatchetExecutionTimeoutMs(agent?.resolved?.runtimeManifest?.budgets)
        )
    );
    return formatHatchetDuration(maxMs);
}

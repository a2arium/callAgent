const DEFAULT_TERMINAL_BACKGROUND_TASK_TIMEOUT_MS = 60_000;
const DEFAULT_ACTIVE_BACKGROUND_TASK_TIMEOUT_MS = 15 * 60_000;
const ACTIVE_BACKGROUND_TASK_GRACE_MS = 30_000;

export type BackgroundTaskDrainTimeoutDecision = {
    timeoutMs: number;
    source: 'env' | 'real-run-env' | 'manifest-latency' | 'active-default' | 'terminal-default';
    activeGraph: boolean;
};

export const BACKGROUND_TASK_DRAIN_TIMEOUT_DEFAULTS = {
    terminalMs: DEFAULT_TERMINAL_BACKGROUND_TASK_TIMEOUT_MS,
    activeMs: DEFAULT_ACTIVE_BACKGROUND_TASK_TIMEOUT_MS,
    activeGraceMs: ACTIVE_BACKGROUND_TASK_GRACE_MS,
} as const;

const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'cancelled']);

export function parsePositiveInt(value: string | undefined, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : undefined;
}

export function resolveBackgroundTaskDrainTimeout(params: {
    explicitTimeoutMs?: string;
    realRunTimeoutMs?: string;
    latencyBudgetMs?: unknown;
    taskState?: string;
}): BackgroundTaskDrainTimeoutDecision {
    const explicitTimeoutMs = parseOptionalPositiveInt(params.explicitTimeoutMs);
    const activeGraph = !TERMINAL_STATES.has((params.taskState ?? '').toLowerCase());
    if (explicitTimeoutMs !== undefined) {
        return { timeoutMs: explicitTimeoutMs, source: 'env', activeGraph };
    }

    const realRunTimeoutMs = parseOptionalPositiveInt(params.realRunTimeoutMs);
    if (realRunTimeoutMs !== undefined) {
        return { timeoutMs: realRunTimeoutMs, source: 'real-run-env', activeGraph };
    }

    if (activeGraph) {
        const latencyBudgetMs = normalizePositiveNumber(params.latencyBudgetMs);
        if (latencyBudgetMs !== undefined) {
            return {
                timeoutMs: latencyBudgetMs + ACTIVE_BACKGROUND_TASK_GRACE_MS,
                source: 'manifest-latency',
                activeGraph,
            };
        }
        return {
            timeoutMs: DEFAULT_ACTIVE_BACKGROUND_TASK_TIMEOUT_MS,
            source: 'active-default',
            activeGraph,
        };
    }

    return {
        timeoutMs: DEFAULT_TERMINAL_BACKGROUND_TASK_TIMEOUT_MS,
        source: 'terminal-default',
        activeGraph,
    };
}

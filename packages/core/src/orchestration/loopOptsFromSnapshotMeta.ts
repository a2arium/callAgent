/**
 * Reads loop runner budgets from working-memory snapshot `meta`.
 * `TaskEngine.startTask` seeds `meta.budgets.maxTurns` from CLI `--max-turns`; `TaskExecutor.saveSnapshot`
 * persists `meta.budgets` from `loopOpts`. Older snapshots may have top-level `meta.maxTurns` only.
 */
export function readLoopBudgetsFromSnapshotMeta(
    meta: unknown
): { maxTurns: number; latencyMs?: number } | undefined {
    if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) {
        return undefined;
    }
    const m = meta as {
        budgets?: { maxTurns?: number; latencyMs?: number };
        maxTurns?: number;
        latencyMs?: number;
    };
    if (
        m.budgets != null &&
        typeof m.budgets === 'object' &&
        typeof m.budgets.maxTurns === 'number'
    ) {
        return { maxTurns: m.budgets.maxTurns, latencyMs: m.budgets.latencyMs };
    }
    if (typeof m.maxTurns === 'number') {
        return { maxTurns: m.maxTurns, latencyMs: m.latencyMs };
    }
    return undefined;
}

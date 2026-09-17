import type { RunnableTurnRequest } from '@a2arium/callagent-memory-engine';
import { defaultMetricsRegistry } from '../observability/metrics.js';
import type { TaskTurnRuntimeSurface } from './TaskTurnCoordinator.js';

/** Records the durable generation-one admission backlog for one runtime surface. */
export function observeTaskSubmissionBacklog(
    rows: readonly RunnableTurnRequest[],
    runtimeSurface: TaskTurnRuntimeSurface,
    nowMs = Date.now()
): { count: number; oldestAgeMs: number } {
    const submissions = rows.filter((row) =>
        row.generation === '1' && row.runtimeSurface === runtimeSurface
    );
    let oldestAgeMs = 0;
    for (const row of submissions) {
        const createdAtMs = typeof row.createdAt === 'string' ? Date.parse(row.createdAt) : Number.NaN;
        if (Number.isFinite(createdAtMs)) {
            oldestAgeMs = Math.max(oldestAgeMs, nowMs - createdAtMs);
        }
    }
    const dimensions = { runtimeSurface };
    defaultMetricsRegistry.setGauge('task_submission_pending_count', submissions.length, dimensions);
    defaultMetricsRegistry.setGauge('task_submission_oldest_age_ms', Math.max(0, oldestAgeMs), dimensions);
    return { count: submissions.length, oldestAgeMs: Math.max(0, oldestAgeMs) };
}

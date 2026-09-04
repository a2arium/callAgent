import { defaultMetricsRegistry } from '../observability/metrics.js';
import type { SessionManager } from './SessionManager.js';
import {
    recoverExpiredTaskTurnClaim,
    type TaskTurnRecoveryDisposition,
} from './TaskTurnCoordinator.js';

export type ExpiredTaskTurnRecoverySweepResult = {
    scanned: number;
    capped: boolean;
    outcomes: Partial<Record<TaskTurnRecoveryDisposition, number>>;
};

export async function sweepExpiredTaskTurnClaims(params: {
    session: SessionManager;
    runtimeSurface: 'hatchet' | 'in_process';
    pageSize?: number;
    maxCandidates?: number;
    concurrency?: number;
    now?: () => number;
}): Promise<ExpiredTaskTurnRecoverySweepResult> {
    const maxCandidates = Math.max(1, Math.min(5_000, params.maxCandidates ?? 500));
    const pageSize = Math.max(1, Math.min(100, params.pageSize ?? 100, maxCandidates));
    const concurrency = Math.max(1, Math.min(16, params.concurrency ?? 4));
    const outcomes: Partial<Record<TaskTurnRecoveryDisposition, number>> = {};
    let cursor: { expiresAt: string; tenantId: string; taskId: string } | undefined;
    let scanned = 0;
    let oldestExpiresAt: string | undefined;

    while (scanned < maxCandidates) {
        const rows = await params.session.listExpiredTaskTurnClaims({
            runtimeSurface: params.runtimeSurface,
            ...(cursor ? { cursor } : {}),
            limit: Math.min(pageSize, maxCandidates - scanned),
        });
        if (rows.length === 0) break;
        oldestExpiresAt ??= rows[0]?.expiresAt;
        await runBounded(rows, concurrency, async (row) => {
            const result = await recoverExpiredTaskTurnClaim({
                session: params.session,
                tenantId: row.tenantId,
                taskId: row.taskId,
                agentId: row.agentId,
                expectedClaim: {
                    claimId: row.claimId,
                    fence: row.fence,
                    claimedGeneration: row.claimedGeneration,
                    expiresAt: row.expiresAt,
                },
                now: params.now,
            });
            outcomes[result.disposition] = (outcomes[result.disposition] ?? 0) + 1;
        });
        scanned += rows.length;
        const last = rows.at(-1)!;
        cursor = { expiresAt: last.expiresAt, tenantId: last.tenantId, taskId: last.taskId };
        if (rows.length < pageSize) break;
    }

    const capped = scanned >= maxCandidates;
    defaultMetricsRegistry.setGauge('task_turn_expired_candidate_backlog_count', scanned, {
        runtimeSurface: params.runtimeSurface,
        capped: String(capped),
    });
    defaultMetricsRegistry.setGauge(
        'task_turn_expired_candidate_oldest_age_ms',
        oldestExpiresAt === undefined
            ? 0
            : Math.max(0, (params.now ?? Date.now)() - Date.parse(oldestExpiresAt)),
        { runtimeSurface: params.runtimeSurface }
    );
    return { scanned, capped, outcomes };
}

async function runBounded<T>(rows: T[], concurrency: number, worker: (row: T) => Promise<void>): Promise<void> {
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
        for (;;) {
            const current = index++;
            if (current >= rows.length) return;
            await worker(rows[current]!);
        }
    }));
}

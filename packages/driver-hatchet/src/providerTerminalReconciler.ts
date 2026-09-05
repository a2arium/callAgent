import {
    claimTaskTerminalInSnapshot,
    finalizeTaskTurnsForTerminalSnapshot,
    markDurableTaskTerminalEnqueued,
    readDurableTaskTerminal,
    readTaskTurnCoordinator,
    readWorkerLifetimeRecoveryProvenance,
    defaultMetricsRegistry,
    type SessionManager,
} from '@a2arium/callagent-core/unstable';
import type { HatchetClient } from './hatchetClient.js';

export type ProviderTerminalSignal = {
    tenantId: string;
    taskId: string;
    agentId?: string | null;
    providerRunId?: string | null;
    error?: unknown;
    observedAt: Date;
    source?: 'provider_callback' | 'provider_reconciler';
};

export type ProviderTerminalConvergenceResult =
    | 'converged'
    | 'deferred_active_claim'
    | 'superseded_by_recovery'
    | 'already_terminal';

/**
 * The sole SQL-backed path which makes a provider failure authoritative. It is
 * safe from both the worker callback and a later scan: snapshot CAS elects one
 * terminal winner and the delivery key makes final status publication idempotent.
 */
export async function convergeProviderTerminal(
    sessions: SessionManager,
    signal: ProviderTerminalSignal,
): Promise<ProviderTerminalConvergenceResult> {
    const loaded = await sessions.loadForMutation(signal.tenantId, signal.taskId);
    if (!loaded) return 'already_terminal';
    const snapshot = loaded.snapshot as Record<string, unknown>;
    const existingTerminal = readDurableTaskTerminal(snapshot);
    if (existingTerminal === undefined && signal.providerRunId) {
        const recovered = readWorkerLifetimeRecoveryProvenance(snapshot).some(
            (row) => row.sourceProviderRunId === signal.providerRunId
        );
        if (recovered) {
            defaultMetricsRegistry.increment('provider_terminal_convergence_total', { outcome: 'superseded_by_recovery' });
            return 'superseded_by_recovery';
        }
        try {
            const coordinator = readTaskTurnCoordinator(snapshot, {
                tenantId: signal.tenantId,
                taskId: signal.taskId,
            });
            if (coordinator.active?.runtimeSurface === 'hatchet' &&
                coordinator.active.runtimeOwner?.rootProviderRunId === signal.providerRunId) {
                defaultMetricsRegistry.increment('provider_terminal_convergence_total', { outcome: 'deferred_active_claim' });
                return 'deferred_active_claim';
            }
        } catch {
            // Legacy tasks without coordinator state retain the previous provider-terminal behavior.
        }
    }
    const error = normalizeProviderError(signal.error);
    const observedAt = signal.observedAt.toISOString();
    const claimed = claimTaskTerminalInSnapshot(loaded.snapshot as Record<string, unknown>, {
        taskId: signal.taskId,
        state: 'failed',
        claimedAt: observedAt,
        reason: error.code,
        allowProviderTimeoutCorrection: true,
        status: {
            state: 'failed',
            timestamp: observedAt,
            metadata: {
                source: signal.source ?? 'provider_reconciler',
                providerRunId: signal.providerRunId,
                providerTerminalAt: observedAt,
                code: error.code,
                message: error.message,
            },
        },
    });
    const finalizedTurns = finalizeTaskTurnsForTerminalSnapshot({
        snapshot: claimed.snapshot,
        tenantId: signal.tenantId,
        taskId: signal.taskId,
    });
    if (claimed.changed || finalizedTurns.changed) {
        const saved = await sessions.saveSnapshot({
            tenantId: signal.tenantId,
            sessionId: signal.taskId,
            agentId: signal.agentId ?? loaded.agentId ?? 'unknown',
            expectedWmVersion: loaded.wmVersion,
            snapshot: finalizedTurns.snapshot,
        });
        // A concurrent completion/cancellation won. Its snapshot is the truth.
        if (saved === null) return 'already_terminal';
    }

    const terminal = claimed.terminal;
    if (terminal.state !== 'failed') return 'already_terminal';
    if (!claimed.changed && terminal.enqueuedAt !== undefined) return 'already_terminal';
    const events = await sessions.listEventsSince({ tenantId: signal.tenantId, sessionId: signal.taskId, sinceSeq: -1 });
    if (!events.some((event) => event.type === 'task.failed' && (event.payload as Record<string, unknown>)?.deliveryKey === terminal.deliveryKey)) {
        await sessions.appendEvent(signal.tenantId, signal.taskId, 'task.failed', {
            taskId: signal.taskId,
            ...(signal.agentId ? { agentId: signal.agentId } : {}),
            deliveryKey: terminal.deliveryKey,
            authoritativeTerminal: true,
            code: error.code,
            error: error.message,
            source: signal.source ?? 'provider_reconciler',
            providerRunId: signal.providerRunId,
            ...(terminal.status.metadata?.supersedesDeliveryKey !== undefined
                ? { supersedesDeliveryKey: terminal.status.metadata.supersedesDeliveryKey }
                : {}),
        });
    }
    await sessions.enqueueOutbox(
        signal.tenantId,
        'task.status',
        signal.taskId,
        { taskId: signal.taskId, status: terminal.status, final: true, deliveryKey: terminal.deliveryKey },
        undefined,
        terminal.deliveryKey,
    );

    // A lost marker is harmless (the delivery key is unique), but writing it
    // avoids unnecessary work when the next reconciliation interval runs.
    const afterPublication = await sessions.loadForMutation(signal.tenantId, signal.taskId);
    if (afterPublication) {
        const updated = markDurableTaskTerminalEnqueued(
            afterPublication.snapshot as Record<string, unknown>, terminal.deliveryKey, new Date().toISOString(),
        );
        if (updated !== afterPublication.snapshot) {
            await sessions.saveSnapshot({
                tenantId: signal.tenantId,
                sessionId: signal.taskId,
                agentId: signal.agentId ?? afterPublication.agentId ?? 'unknown',
                expectedWmVersion: afterPublication.wmVersion,
                snapshot: updated,
            });
        }
    }
    const outcome = claimed.changed ? 'converged' : 'already_terminal';
    defaultMetricsRegistry.increment('provider_terminal_convergence_total', { outcome });
    return outcome;
}

/** Repairs failures that Hatchet recorded after its worker stream became unusable. */
export class ProviderTerminalReconciler {
    private readonly firstFailedObservation = new Map<string, number>();

    constructor(
        private readonly prisma: any,
        private readonly sessions: SessionManager,
        private readonly hatchet?: HatchetClient,
        private readonly now: () => Date = () => new Date(),
        private readonly failureConfirmationMs = 15_000,
    ) {}

    async scanOnce(limit = 100): Promise<number> {
        await this.recordProviderFailures(limit);
        const rows = await this.prisma.driverRun.findMany({
            where: { operation: { in: ['agent.run', 'agent.run.recovery'] }, status: 'failed', taskId: { not: null } },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
            take: limit,
        });
        let reconciled = 0;
        for (const row of rows) {
            if (await convergeProviderTerminal(this.sessions, {
                tenantId: row.tenantId,
                taskId: row.taskId,
                agentId: row.agentId,
                providerRunId: row.providerRunId,
                error: row.error,
                observedAt: row.updatedAt,
                source: 'provider_reconciler',
            }) === 'converged') reconciled += 1;
        }
        return reconciled;
    }

    /** Polling is independent of worker callbacks, so a dead listener cannot
     * leave a provider-terminal root logically running forever. */
    private async recordProviderFailures(limit: number): Promise<void> {
        if (!this.hatchet) return;
        const rows = await this.prisma.driverRun.findMany({
            where: {
                operation: { in: ['agent.run', 'agent.run.recovery'] },
                status: { in: ['queued', 'running'] },
                providerRunId: { not: null },
                taskId: { not: null },
            },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
            take: limit,
            select: { id: true, providerRunId: true },
        });
        for (const row of rows) {
            try {
                const status = await this.hatchet.runs.get_status(row.providerRunId);
                if (status !== 'FAILED') {
                    this.firstFailedObservation.delete(row.providerRunId);
                    continue;
                }
                const observedAt = this.now().getTime();
                const firstObservedAt = this.firstFailedObservation.get(row.providerRunId);
                if (firstObservedAt === undefined) {
                    this.firstFailedObservation.set(row.providerRunId, observedAt);
                    continue;
                }
                if (observedAt - firstObservedAt < this.failureConfirmationMs) continue;
                await this.prisma.driverRun.updateMany({
                    where: { id: row.id, status: { in: ['queued', 'running'] } },
                    data: {
                        status: 'failed',
                        error: { code: 'HATCHET_PROVIDER_FAILED', message: 'Hatchet reported this provider run as FAILED' },
                        updatedAt: this.now(),
                    },
                });
                this.firstFailedObservation.delete(row.providerRunId);
            } catch (error) {
                // A status probe is advisory. Its next interval retries without
                // turning a transient read failure into a task terminal state.
                console.warn('HATCHET_PROVIDER_STATUS_PROBE_FAILED', {
                    providerRunId: row.providerRunId,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
}

export function normalizeProviderError(error: unknown): { code: string; message: string } {
    const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const message = typeof value.message === 'string' ? value.message : String(error ?? 'Hatchet provider failed');
    return {
        code: /worker is not active|worker is not ACTIVE/i.test(message)
            ? 'HATCHET_WORKER_LIFETIME_LOST'
            : /(?:durable.*(?:unavailable|connection dropped)|stream.*(?:unavailable|closed)|connection.*refused)/i.test(message)
            ? 'HATCHET_DURABLE_STREAM_UNAVAILABLE'
            : 'HATCHET_PROVIDER_FAILED',
        message: message.slice(0, 500),
    };
}

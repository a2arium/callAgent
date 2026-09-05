import type { RunSegmentParams, SegmentResult, TurnExecutor } from '@a2arium/callagent-core/unstable';
import { defaultMetricsRegistry } from '@a2arium/callagent-core/unstable';

export class HatchetWorkerStreamUnavailableError extends Error {
    readonly code = 'HATCHET_WORKER_STREAM_UNAVAILABLE';

    constructor(message = 'Hatchet worker stream is unavailable') {
        super(message);
        this.name = 'HatchetWorkerStreamUnavailableError';
    }
}

export type HatchetExecutionDrainResult = {
    drained: boolean;
    activeCount: number;
};

/** Owns the lifetime of every agent segment accepted by one Hatchet worker instance. */
export class HatchetExecutionSupervisor implements TurnExecutor {
    private readonly lifetime = new AbortController();
    private readonly active = new Set<Promise<unknown>>();
    private accepting = true;

    constructor(private readonly delegate: TurnExecutor) {}

    get activeCount(): number {
        return this.active.size;
    }

    get isAccepting(): boolean {
        return this.accepting;
    }

    async runSegment(params: RunSegmentParams): Promise<SegmentResult> {
        if (!this.accepting || this.lifetime.signal.aborted) {
            throw abortReason(this.lifetime.signal);
        }
        const combined = combineAbortSignals(params.abortSignal, this.lifetime.signal);
        const execution = this.delegate.runSegment({ ...params, abortSignal: combined.signal });
        this.active.add(execution);
        defaultMetricsRegistry.setGauge('hatchet_worker_active_executions', this.active.size);
        try {
            return await execution;
        } finally {
            combined.dispose();
            this.active.delete(execution);
            defaultMetricsRegistry.setGauge('hatchet_worker_active_executions', this.active.size);
        }
    }

    abortAll(reason: Error): void {
        if (!this.accepting && this.lifetime.signal.aborted) return;
        this.accepting = false;
        const errorCode = (reason as Error & { code?: unknown }).code;
        defaultMetricsRegistry.increment('hatchet_worker_execution_abort_total', {
            errorCode: typeof errorCode === 'string'
                ? errorCode
                : reason.name,
        });
        this.lifetime.abort(reason);
    }

    async drain(timeoutMs: number): Promise<HatchetExecutionDrainResult> {
        const startedAt = Date.now();
        const active = Array.from(this.active);
        if (active.length === 0) return { drained: true, activeCount: 0 };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
            timer.unref?.();
        });
        const settled = Promise.allSettled(active).then(() => 'drained' as const);
        const outcome = await Promise.race([settled, timedOut]);
        if (timer) clearTimeout(timer);
        defaultMetricsRegistry.observeDuration('hatchet_worker_execution_drain_ms', Date.now() - startedAt, {
            status: outcome,
        });
        return { drained: outcome === 'drained', activeCount: this.active.size };
    }
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new HatchetWorkerStreamUnavailableError();
}

function combineAbortSignals(
    providerSignal: AbortSignal | undefined,
    workerSignal: AbortSignal
): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const signals = [providerSignal, workerSignal].filter((signal): signal is AbortSignal => signal !== undefined);
    const abort = (signal: AbortSignal) => controller.abort(
        signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'Operation aborted'))
    );
    const listeners = signals.map((signal) => {
        const listener = () => abort(signal);
        if (signal.aborted) abort(signal);
        else signal.addEventListener('abort', listener, { once: true });
        return { signal, listener };
    });
    return {
        signal: controller.signal,
        dispose: () => listeners.forEach(({ signal, listener }) => signal.removeEventListener('abort', listener)),
    };
}

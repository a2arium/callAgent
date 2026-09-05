export type HatchetWorkerLifetimeLostDetails = {
    installationId?: string;
    instanceId?: string;
    workerName?: string;
    rootProviderRunId?: string;
    reason?: string;
};

/** Internal control-flow signal: the exact Hatchet worker owning a turn is unusable. */
export class HatchetWorkerLifetimeLostError extends Error {
    readonly code = 'HATCHET_WORKER_LIFETIME_LOST';

    constructor(
        message = 'Hatchet worker lifetime was lost',
        readonly details: HatchetWorkerLifetimeLostDetails = {},
        readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'HatchetWorkerLifetimeLostError';
        Object.setPrototypeOf(this, HatchetWorkerLifetimeLostError.prototype);
    }
}

export function isHatchetWorkerLifetimeLostError(error: unknown): error is HatchetWorkerLifetimeLostError {
    return error instanceof HatchetWorkerLifetimeLostError || (
        error !== null && typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'HATCHET_WORKER_LIFETIME_LOST'
    );
}

export function hasHatchetWorkerLifetimeLostCause(error: unknown): boolean {
    const seen = new Set<object>();
    let current: unknown = error;
    for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
        if (isHatchetWorkerLifetimeLostError(current)) return true;
        if (typeof current !== 'object' || seen.has(current)) return false;
        seen.add(current);
        current = (current as { cause?: unknown }).cause;
    }
    return false;
}

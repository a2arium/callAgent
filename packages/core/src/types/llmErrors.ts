export type LLMTerminalErrorCode = 'LLM_TIMEOUT' | 'LLM_CANCELLED';

type ErrorOptions = {
    cause?: unknown;
};

export class LLMTimeoutError extends Error {
    public readonly code = 'LLM_TIMEOUT' as const;
    public readonly timeoutMs: number;
    public readonly cause?: unknown;

    constructor(timeoutMs: number, options?: ErrorOptions) {
        super(`LLM operation timed out after ${timeoutMs}ms`);
        this.name = 'LLMTimeoutError';
        this.timeoutMs = timeoutMs;
        this.cause = options?.cause;
        Object.setPrototypeOf(this, LLMTimeoutError.prototype);
    }
}

export class LLMCancelledError extends Error {
    public readonly code = 'LLM_CANCELLED' as const;
    public readonly reason?: unknown;
    public readonly cause?: unknown;

    constructor(message = 'LLM operation was cancelled', options?: ErrorOptions & { reason?: unknown }) {
        super(message);
        this.name = 'LLMCancelledError';
        this.reason = options?.reason;
        this.cause = options?.cause;
        Object.setPrototypeOf(this, LLMCancelledError.prototype);
    }
}

export function isLLMTimeoutError(error: unknown): error is LLMTimeoutError {
    if (error instanceof LLMTimeoutError) return true;
    if (error === null || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; timeoutMs?: unknown };
    return candidate.code === 'LLM_TIMEOUT'
        && typeof candidate.timeoutMs === 'number'
        && Number.isFinite(candidate.timeoutMs);
}

export function isLLMCancelledError(error: unknown): error is LLMCancelledError {
    if (error instanceof LLMCancelledError) return true;
    if (error === null || typeof error !== 'object') return false;
    return (error as { code?: unknown }).code === 'LLM_CANCELLED';
}

export function mapLLMCallError(error: unknown, signal?: AbortSignal): unknown {
    if (error instanceof LLMTimeoutError || error instanceof LLMCancelledError) return error;
    if (isLLMTimeoutError(error)) {
        return new LLMTimeoutError(error.timeoutMs, { cause: error });
    }
    if (error !== null && typeof error === 'object') {
        const candidate = error as { code?: unknown; message?: unknown };
        if (candidate.code === 'LLM_ABORTED') {
            return new LLMCancelledError(
                typeof candidate.message === 'string' ? candidate.message : undefined,
                { cause: error, reason: signal?.reason },
            );
        }
    }
    if (signal?.aborted) {
        return new LLMCancelledError(undefined, { cause: error, reason: signal.reason });
    }
    return error;
}

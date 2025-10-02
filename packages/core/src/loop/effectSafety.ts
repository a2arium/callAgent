export type SafetyOptions = {
    timeoutMs?: number;
    maxRetries?: number;
    retryDelayMs?: number; // consider adding jitter
    retryableErrors?: string[];
};

export async function withSafety<T>(
    fn: () => Promise<T>,
    opts: SafetyOptions = {}
): Promise<T> {
    const {
        timeoutMs = 30000,
        maxRetries = 2,
        retryDelayMs = 1000,
        retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'RATE_LIMIT', '429', '503']
    } = opts;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await Promise.race([
                fn(),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
            ]);
        } catch (e) {
            lastError = e as Error;
            const msg = lastError?.message || '';
            const retryable = retryableErrors.some(p => msg.includes(p));
            if (!retryable || attempt === maxRetries) throw lastError;
            const jitter = Math.floor(Math.random() * 200);
            const delay = Math.pow(2, attempt) * retryDelayMs + jitter;
            await new Promise(r => setTimeout(r, delay));
        }
    }

    // Should be unreachable
    throw lastError ?? new Error('Unknown effectSafety error');
}



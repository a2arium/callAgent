export type SafetyOptions = {
    timeoutMs?: number;
    maxRetries?: number;
    retryDelayMs?: number;
    retryableErrors?: string[];
};
export declare function withSafety<T>(fn: () => Promise<T>, opts?: SafetyOptions): Promise<T>;

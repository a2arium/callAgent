export type IdempotencyResult = {
    jsonrpc: '2.0';
    id: string | number | null;
    result: unknown;
};
export declare function getIdempotent(tenantId: string, taskId: string, token: string, idempotencyKey?: string): IdempotencyResult | undefined;
export declare function setIdempotent(tenantId: string, taskId: string, token: string, idempotencyKey: string, result: IdempotencyResult): void;

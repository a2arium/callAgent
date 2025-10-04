export type PendingInputHandler = {
    schema?: unknown;
    expiresAt?: string;
};
export type SnapshotShape = {
    vars?: Record<string, unknown>;
    pending?: {
        inputs?: Record<string, PendingInputHandler>;
    };
};
export declare function getPendingInputs(snapshot: Record<string, unknown>): Record<string, PendingInputHandler>;
export declare function setPendingInputs(snapshot: Record<string, unknown>, inputs: Record<string, PendingInputHandler>): Record<string, unknown>;
export declare function applyInputProvided(snapshot: Record<string, unknown>, token: string, input: unknown): {
    next: Record<string, unknown>;
};

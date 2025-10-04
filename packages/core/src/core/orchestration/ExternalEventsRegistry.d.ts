export type PendingExternalEvents = Record<string, {
    type: string;
    data?: unknown;
    handlers?: {
        occurred?: string;
    };
}>;
export declare function getPendingExternalEvents(snapshot: Record<string, unknown>): PendingExternalEvents;
export declare function setPendingExternalEvents(snapshot: Record<string, unknown>, events: PendingExternalEvents): Record<string, unknown>;

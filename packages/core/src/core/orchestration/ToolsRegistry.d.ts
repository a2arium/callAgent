export type PendingTools = Record<string, {
    name: string;
    args: unknown;
    handlers?: {
        completed?: string;
        failed?: string;
    };
}>;
export declare function getPendingTools(snapshot: Record<string, unknown>): PendingTools;
export declare function setPendingTools(snapshot: Record<string, unknown>, tools: PendingTools): Record<string, unknown>;

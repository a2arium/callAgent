// Pending tools registry stored under snapshot.pending.tools
// Mirrors patterns used by inputs/tasks/groups.

export type PendingTool = {
    name: string;
    args: unknown;
    handlers?: { completed?: string; failed?: string };
    options?: { setToken?: boolean; setStage?: string };
    idempotencyKey?: string;
    ownerTaskId?: string;
    rootTaskId?: string;
    ancestorTaskIds?: string[];
};

export type PendingTools = Record<string, PendingTool>;

export type PendingToolTerminal = {
    kind: 'completed' | 'detached';
    claimedAt: string;
    toolName?: string;
    ownerTaskId?: string;
    rootTaskId?: string;
    deliveryKey?: string;
    reason?: string;
};

export type PendingToolTerminals = Record<string, PendingToolTerminal>;

const TOOL_TERMINAL_TOMBSTONE_CAP = 256;

export function boundPendingToolTerminals(
    terminals: PendingToolTerminals
): PendingToolTerminals {
    const entries = Object.entries(terminals);
    if (entries.length <= TOOL_TERMINAL_TOMBSTONE_CAP) return terminals;
    return Object.fromEntries(
        entries
            .sort(([, left], [, right]) => left.claimedAt.localeCompare(right.claimedAt))
            .slice(-TOOL_TERMINAL_TOMBSTONE_CAP)
    );
}

export function getPendingTools(snapshot: Record<string, unknown>): PendingTools {
    const pending = (snapshot as any).pending?.tools || {};
    return { ...pending } as PendingTools;
}

export function setPendingTools(snapshot: Record<string, unknown>, tools: PendingTools): Record<string, unknown> {
    const s: any = { ...snapshot };
    s.pending = { ...(s.pending || {}) };
    s.pending.tools = tools;
    return s as Record<string, unknown>;
}

export function getPendingToolTerminals(snapshot: Record<string, unknown>): PendingToolTerminals {
    const pending = (snapshot as any).pending?.toolTerminals || {};
    return { ...pending } as PendingToolTerminals;
}

export function setPendingToolTerminals(
    snapshot: Record<string, unknown>,
    terminals: PendingToolTerminals
): Record<string, unknown> {
    const s: any = { ...snapshot };
    s.pending = { ...(s.pending || {}) };
    s.pending.toolTerminals = boundPendingToolTerminals(terminals);
    return s as Record<string, unknown>;
}

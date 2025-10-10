// Pending tools registry stored under snapshot.pending.tools
// Mirrors patterns used by inputs/tasks/groups.

export type PendingTools = Record<string, {
    name: string;
    args: unknown;
    handlers?: { completed?: string; failed?: string };
    options?: { setToken?: boolean; setStage?: string };
}>;

export function getPendingTools(snapshot: Record<string, unknown>): PendingTools {
    const pending = (snapshot as any).pending?.tools || {};
    return { ...pending } as PendingTools;
}

export function setPendingTools(snapshot: Record<string, unknown>, tools: PendingTools): Record<string, unknown> {
    const s: any = { ...snapshot };
    s.pending = s.pending || {};
    s.pending.tools = tools;
    return s as Record<string, unknown>;
}



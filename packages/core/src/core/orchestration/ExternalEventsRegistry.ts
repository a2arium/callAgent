// Pending external events registry stored under snapshot.pending.events

export type PendingExternalEvents = Record<string, {
    type: string;
    data?: unknown;
    handlers?: { occurred?: string };
}>;

export function getPendingExternalEvents(snapshot: Record<string, unknown>): PendingExternalEvents {
    const pending = ((snapshot as any)?.pending?.events || {}) as Record<string, unknown>;
    return { ...pending } as PendingExternalEvents;
}

export function setPendingExternalEvents(snapshot: Record<string, unknown>, events: PendingExternalEvents): Record<string, unknown> {
    const base = { ...(snapshot as any) } as any;
    base.pending = base.pending || {};
    base.pending.events = events;
    return base as Record<string, unknown>;
}



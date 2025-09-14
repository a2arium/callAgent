export type PendingInputHandler = {
    handlerName: string;
    // optional metadata like schema, expiresAt, etc.
    schema?: unknown;
    expiresAt?: string;
};

export type SnapshotShape = {
    vars?: Record<string, unknown>;
    pending?: {
        inputs?: Record<string, PendingInputHandler>;
    };
};

export function getPendingInputs(snapshot: Record<string, unknown>): Record<string, PendingInputHandler> {
    const s = snapshot as SnapshotShape;
    return (s.pending?.inputs as Record<string, PendingInputHandler>) || {};
}

export function setPendingInputs(
    snapshot: Record<string, unknown>,
    inputs: Record<string, PendingInputHandler>
): Record<string, unknown> {
    const s = snapshot as SnapshotShape;
    const next: SnapshotShape = {
        ...snapshot,
        pending: {
            ...(s.pending || {}),
            inputs
        }
    };
    return next as Record<string, unknown>;
}

export function applyInputProvided(
    snapshot: Record<string, unknown>,
    token: string,
    input: unknown
): { next: Record<string, unknown>; handlerName?: string } {
    const pending = { ...getPendingInputs(snapshot) };
    const entry = pending[token];
    if (entry) {
        delete pending[token];
    }
    const s = snapshot as SnapshotShape;
    const vars = { ...(s.vars || {}) } as Record<string, unknown>;
    const inputs = (vars.__inputs as Record<string, unknown>) || {};
    inputs[token] = input as unknown;
    vars.__inputs = inputs;
    const next = setPendingInputs({ ...snapshot, vars }, pending);
    return { next, handlerName: entry?.handlerName };
}



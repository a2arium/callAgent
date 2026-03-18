import type { Observation } from '../loop/oneTurn.js';
import { normalizeObservationInbox, type ObservationInbox } from '../loop/types.js';

export type PendingInputHandler = {
    // optional metadata like schema, expiresAt, etc.
    schema?: unknown;
    expiresAt?: string;
};



export type SnapshotShape = {
    pending?: {
        inputs?: Record<string, PendingInputHandler>;
    };
    inbox?: ObservationInbox | Observation[];
    meta?: { turn?: number };
};

const normalizeInbox = (value: SnapshotShape['inbox']): ObservationInbox => {
    return normalizeObservationInbox(value);
};

const addObservationToInbox = (value: SnapshotShape['inbox'], observation: Observation): ObservationInbox => {
    const inbox = normalizeInbox(value);
    inbox.current = [observation]; // REPLACE instead of PUSH for resume context
    inbox.all.push(observation);
    return inbox;
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

/**
 * Apply a user-provided input for the given token. Delivered values are not persisted
 * in the snapshot; the observation in the inbox is the source of truth for this turn.
 */
export function applyInputProvided(
    snapshot: Record<string, unknown>,
    token: string,
    input: unknown
): { next: Record<string, unknown> } {
    const pending = { ...getPendingInputs(snapshot) };
    if (pending[token]) {
        delete pending[token];
    }
    const s = snapshot as SnapshotShape;
    const observation: Observation = {
        source: 'user',
        kind: 'input.provided',
        payload: { token, value: input },
        provenance: {
            ts: Date.now(),
            turn: Number(s.meta?.turn ?? 0) + 1,
            id: token,
            toolId: 'user',
            correlationId: token
        }
    };
    const nextSnapshot = setPendingInputs(snapshot, pending) as SnapshotShape;
    const nextInbox = addObservationToInbox(nextSnapshot.inbox, observation);
    const next = { ...nextSnapshot, inbox: nextInbox } as Record<string, unknown>;
    return { next };
}


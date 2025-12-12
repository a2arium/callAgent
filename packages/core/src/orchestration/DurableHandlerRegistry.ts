import type { Observation, ObservationConfig, SynthesizeObservation } from '../loop/oneTurn.js';
import { normalizeObservationInbox, type ObservationInbox } from '../loop/types.js';

export type PendingInputHandler = {
    // optional metadata like schema, expiresAt, etc.
    schema?: unknown;
    expiresAt?: string;
};

type DurableObservationConfig = ObservationConfig & {
    user: unknown;
    tool?: unknown;
    child?: unknown;
    internal?: unknown;
    env?: unknown;
};

type DurableObservation = SynthesizeObservation<DurableObservationConfig>;
type DurableObservationInbox = ObservationInbox<DurableObservationConfig>;

export type SnapshotShape = {
    vars?: Record<string, unknown>;
    pending?: {
        inputs?: Record<string, PendingInputHandler>;
    };
    inbox?: DurableObservationInbox | Observation[];
    meta?: { turn?: number };
};

const normalizeInbox = (value: SnapshotShape['inbox']): DurableObservationInbox => {
    return normalizeObservationInbox<DurableObservationConfig>(value);
};

const addObservationToInbox = (value: SnapshotShape['inbox'], observation: DurableObservation): DurableObservationInbox => {
    const inbox = normalizeInbox(value);
    inbox.current.push(observation);
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
    const vars = { ...(s.vars || {}) } as Record<string, unknown>;
    const inputs = (vars.__inputs as Record<string, unknown>) || {};
    inputs[token] = input as unknown;
    vars.__inputs = inputs;
    const snapshotWithVars = { ...snapshot, vars } as SnapshotShape;
    const observation: DurableObservation = {
        source: 'user',
        kind: 'input.provided',
        payload: { token, value: input },
        provenance: {
            ts: Date.now(),
            turn: Number(snapshotWithVars.meta?.turn ?? 0) + 1,
            id: token,
            toolId: 'user',
            correlationId: token
        }
    };
    const nextSnapshot = setPendingInputs(snapshotWithVars as Record<string, unknown>, pending) as SnapshotShape;
    const nextInbox = addObservationToInbox(nextSnapshot.inbox, observation);
    const next = { ...nextSnapshot, inbox: nextInbox } as Record<string, unknown>;
    return { next };
}


import type { Observation } from '../loop/oneTurn.js';
import { normalizeObservationInbox, type ObservationInbox } from '../loop/types.js';
import type { IntentConsentReceipt } from '../loop/types.js';
import { isConsentDecision } from '../loop/manifestConsent.js';

export type PendingInputHandler = {
    // optional metadata like schema, expiresAt, etc.
    schema?: unknown;
    expiresAt?: string;
};



export type SnapshotShape = {
    pending?: {
        inputs?: Record<string, PendingInputHandler>;
        manifestConsents?: Record<string, IntentConsentReceipt>;
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
    input: unknown,
    expected?: { tenantId?: string; taskId?: string; agentId?: string }
): { next: Record<string, unknown> } {
    const pending = { ...getPendingInputs(snapshot) };
    const s = snapshot as SnapshotShape;
    const consents = { ...(s.pending?.manifestConsents ?? {}) };
    const consent = consents[token];
    if (consent) {
        if (!isConsentDecision(input)) throw new Error('MANIFEST_CONSENT_DECISION_INVALID');
        if (expected?.tenantId && consent.tenantId !== expected.tenantId) throw new Error('MANIFEST_CONSENT_TENANT_MISMATCH');
        if (expected?.taskId && consent.taskId !== expected.taskId) throw new Error('MANIFEST_CONSENT_TASK_MISMATCH');
        if (expected?.agentId && consent.agentId !== expected.agentId) throw new Error('MANIFEST_CONSENT_AGENT_MISMATCH');
        if (consent.status !== 'pending') throw new Error('MANIFEST_CONSENT_ALREADY_DECIDED');
        const now = new Date();
        if (Date.parse(consent.expiresAt) <= now.getTime()) {
            consent.status = 'expired';
            consent.decidedAt = now.toISOString();
        } else {
            consent.status = input.decision === 'approve' ? 'approved' : 'rejected';
            consent.decidedAt = now.toISOString();
        }
        consents[token] = consent;
    }
    if (pending[token]) {
        delete pending[token];
    }
    const provenance = {
        ts: Date.now(),
        turn: Number(s.meta?.turn ?? 0) + 1,
        id: token,
        toolId: 'user',
        correlationId: token
    };
    const observation: Observation = consent
        ? {
              source: 'internal',
              kind: 'state.noted',
              payload: { reason: 'manifest_consent_decided', token, intentId: consent.intentId, status: consent.status },
              provenance,
          }
        : { source: 'user', kind: 'input.provided', payload: { token, value: input }, provenance };
    const nextSnapshot = setPendingInputs(snapshot, pending) as SnapshotShape;
    if (consent) {
        nextSnapshot.pending = { ...(nextSnapshot.pending ?? {}), manifestConsents: consents };
    }
    const nextInbox = addObservationToInbox(nextSnapshot.inbox, observation);
    const next = { ...nextSnapshot, inbox: nextInbox } as Record<string, unknown>;
    return { next };
}

import type { Observation } from '../loop/oneTurn.js';
import { normalizeObservationInbox, type ObservationInbox } from '../loop/types.js';
import type { IntentConsentReceipt } from '../loop/types.js';
import { isConsentDecision } from '../loop/manifestConsent.js';
import { pickPlanStepStamp } from '../plans/planStepCorrelation.js';

export type PendingInputHandler = {
    schema?: unknown;
    expiresAt?: string;
    handlerName?: string;
    expiredHandlerName?: string;
    planId?: string;
    stepId?: string;
    advanceCursor?: boolean;
};

export type PendingInputTerminal = {
    kind: 'provided' | 'expired' | 'cancelled';
    claimedAt: string;
    planId?: string;
    stepId?: string;
    advanceCursor?: boolean;
};

export type SnapshotShape = {
    pending?: {
        inputs?: Record<string, PendingInputHandler>;
        inputTerminals?: Record<string, PendingInputTerminal>;
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
    return { ...((s.pending?.inputs as Record<string, PendingInputHandler>) || {}) };
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

export function getPendingInputTerminals(snapshot: Record<string, unknown>): Record<string, PendingInputTerminal> {
    const s = snapshot as SnapshotShape;
    return { ...((s.pending?.inputTerminals as Record<string, PendingInputTerminal>) || {}) };
}

export function setPendingInputTerminals(
    snapshot: Record<string, unknown>,
    terminals: Record<string, PendingInputTerminal>
): Record<string, unknown> {
    const s = snapshot as SnapshotShape;
    const next: SnapshotShape = {
        ...snapshot,
        pending: {
            ...(s.pending || {}),
            inputTerminals: terminals,
        }
    };
    return next as Record<string, unknown>;
}

export function tombstonePendingInput(
    snapshot: Record<string, unknown>,
    token: string,
    kind: PendingInputTerminal['kind'],
    claimedAt?: string
): Record<string, unknown> {
    const pending = getPendingInputs(snapshot);
    const entry = pending[token];
    if (!entry) return snapshot;
    const terminals = getPendingInputTerminals(snapshot);
    terminals[token] = {
        kind,
        claimedAt: claimedAt ?? new Date().toISOString(),
        ...pickPlanStepStamp(entry),
    };
    delete pending[token];
    return setPendingInputTerminals(setPendingInputs(snapshot, pending), terminals);
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
    let nextSnapshot = tombstonePendingInput(snapshot, token, 'provided') as SnapshotShape;
    if (consent) {
        nextSnapshot.pending = { ...(nextSnapshot.pending ?? {}), manifestConsents: consents };
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
    const nextInbox = addObservationToInbox(nextSnapshot.inbox, observation);
    const next = { ...nextSnapshot, inbox: nextInbox } as Record<string, unknown>;
    return { next };
};

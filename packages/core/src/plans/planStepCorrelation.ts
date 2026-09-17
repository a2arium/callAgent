import type { Intent } from '../types/intent.js';
import type { EnvironmentState } from '../loop/types.js';
import type { ExecErrorPayload, ExecOutcome } from '../loop/oneTurn.js';

export type PlanStepStamp = {
    planId: string;
    stepId: string;
    advanceCursor: boolean;
};

export type PlanStepStampFields = {
    planId?: string;
    stepId?: string;
    advanceCursor?: boolean;
};

export type PlanStepPendingSlot = 'tools' | 'children' | 'inputs';

const TERMINAL_BAG: Record<PlanStepPendingSlot, 'toolTerminals' | 'childTerminals' | 'inputTerminals'> = {
    tools: 'toolTerminals',
    children: 'childTerminals',
    inputs: 'inputTerminals',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

export const pickPlanStepStamp = (source: PlanStepStampFields | undefined): PlanStepStampFields => {
    if (!source) return {};
    return {
        ...(typeof source.planId === 'string' && source.planId.length > 0 ? { planId: source.planId } : {}),
        ...(typeof source.stepId === 'string' && source.stepId.length > 0 ? { stepId: source.stepId } : {}),
        ...(typeof source.advanceCursor === 'boolean' ? { advanceCursor: source.advanceCursor } : {}),
    };
};

export type OwnerDetachedChildTerminal = {
    kind: 'failed';
    claimedAt: string;
    childTaskId?: string;
    agentId?: string;
    error: {
        code: 'CHILD_OWNER_TERMINAL';
        message: string;
    };
} & PlanStepStampFields;

export const synthesizeOwnerDetachedChildTerminal = (
    entry: PlanStepStampFields & { childTaskId?: string; agentId?: string; target?: string },
    params: { detachedAt: string; ownerTaskId: string }
): OwnerDetachedChildTerminal => ({
    kind: 'failed',
    claimedAt: params.detachedAt,
    ...(entry.childTaskId !== undefined ? { childTaskId: entry.childTaskId } : {}),
    ...(typeof entry.agentId === 'string'
        ? { agentId: entry.agentId }
        : typeof entry.target === 'string'
          ? { agentId: entry.target }
          : {}),
    error: {
        code: 'CHILD_OWNER_TERMINAL',
        message: `Child result delivery detached because owner task ${params.ownerTaskId} is terminal.`,
    },
    ...pickPlanStepStamp(entry),
});

export const asHandlerStampOpts = (stamp: PlanStepStamp | undefined): PlanStepStampFields => {
    if (!stamp) return {};
    return {
        planId: stamp.planId,
        stepId: stamp.stepId,
        advanceCursor: stamp.advanceCursor,
    };
};

export const mergePlanStepStamp = <T extends Record<string, unknown>>(
    record: T,
    stamp: PlanStepStampFields
): T & PlanStepStampFields => ({
    ...record,
    ...pickPlanStepStamp(stamp),
});

const isCorrelatedRecord = (
    value: unknown
): value is Record<string, unknown> & { planId: string; stepId: string } =>
    isRecord(value) && typeof value.planId === 'string' && typeof value.stepId === 'string';

export const stampPendingPlanStep = (
    env: EnvironmentState,
    slot: PlanStepPendingSlot,
    token: string,
    stamp: PlanStepStamp,
    extra?: Record<string, unknown>
): void => {
    if (!token) return;
    if (!env.pending[slot] || typeof env.pending[slot] !== 'object') {
        env.pending[slot] = {};
    }
    const bag = env.pending[slot] as Record<string, unknown>;
    const existing = isRecord(bag[token]) ? bag[token] : {};
    bag[token] = mergePlanStepStamp(
        {
            ...existing,
            ...(extra ?? {}),
        },
        stamp
    );
};

export const lookupPendingPlanStep = (
    env: EnvironmentState,
    slot: PlanStepPendingSlot,
    token: string
): (Record<string, unknown> & { planId: string; stepId: string }) | undefined => {
    const liveBag = env.pending[slot] as Record<string, unknown> | undefined;
    const live = liveBag?.[token];
    if (isCorrelatedRecord(live)) return live;
    const terminals = env.pending[TERMINAL_BAG[slot]] as Record<string, unknown> | undefined;
    const tombstone = terminals?.[token];
    if (isCorrelatedRecord(tombstone)) return tombstone;
    return undefined;
};

export const attachPlanStepCorrelation = <D, E extends ExecErrorPayload>(
    outcome: ExecOutcome<D, E>,
    env: EnvironmentState,
    stamp: PlanStepStamp,
    dispatchedIntent: Intent
): ExecOutcome<D, E> => {
    const action = outcome.action;
    if (action.kind === 'call_tool' && typeof action.token === 'string' && action.token.length > 0) {
        stampPendingPlanStep(env, 'tools', action.token, stamp, {
            name: dispatchedIntent.kind === 'call_tool' ? dispatchedIntent.toolName : undefined,
            args: dispatchedIntent.kind === 'call_tool' ? dispatchedIntent.args : undefined,
        });
        return outcome;
    }
    if (action.kind === 'prompt_user' && typeof action.token === 'string' && action.token.length > 0) {
        stampPendingPlanStep(env, 'inputs', action.token, stamp);
        return outcome;
    }
    if (action.kind === 'delegate_to_child' && typeof action.token === 'string' && action.token.length > 0) {
        stampPendingPlanStep(env, 'children', action.token, stamp, {
            agentId: dispatchedIntent.kind === 'delegate_to_child' ? dispatchedIntent.agentId : undefined,
        });
        return outcome;
    }

    const failed = outcome.result.status === 'error';
    const existingData = isRecord(outcome.result.data) ? outcome.result.data : {};
    return {
        ...outcome,
        result: {
            ...outcome.result,
            data: {
                ...existingData,
                planStepUpdated: {
                    planId: stamp.planId,
                    stepId: stamp.stepId,
                    patch: { status: failed ? 'failed' : 'completed' },
                    ...(stamp.advanceCursor ? { advanceCursor: true } : {}),
                },
            } as D,
        },
    };
};

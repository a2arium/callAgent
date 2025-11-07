import type { Observation } from '../loop/oneTurn.js';
import type {
    ChildCompletedObservation,
    ChildCompletedPayload,
    InteractiveTaskSnapshot,
    TaskStatusMetadataWithResult,
    TaskStatusWithResult
} from '../shared/types/observation.js';

const CHILD_COMPLETED_KIND = 'child.completed';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const getTaskStatus = <Result>(snapshot: InteractiveTaskSnapshot<Result, unknown> | undefined): TaskStatusWithResult<Result> | undefined =>
    (snapshot?.status as TaskStatusWithResult<Result> | undefined);

const getMetadata = <Result>(status: TaskStatusWithResult<Result> | undefined): TaskStatusMetadataWithResult<Result> | undefined =>
    (status?.metadata as TaskStatusMetadataWithResult<Result> | undefined);

const getResultFromSnapshot = <Result>(snapshot: InteractiveTaskSnapshot<Result, unknown> | undefined): Result | undefined => {
    if (!snapshot) return undefined;
    const status = getTaskStatus<Result>(snapshot);
    const metadata = getMetadata<Result>(status);
    if (metadata && 'result' in metadata) {
        return metadata.result as Result | undefined;
    }

    // Fallback: some legacy implementations may store the result directly on the snapshot
    if (isRecord(snapshot) && 'result' in snapshot) {
        return (snapshot as Record<string, unknown>).result as Result | undefined;
    }

    if (process.env.CALLAGENT_DEBUG_CHILD_RESULT) {
        // eslint-disable-next-line no-console
        console.warn('[childObservations] Unable to locate child result payload', {
            hasStatus: !!status,
            hasMetadata: !!metadata
        });
    }

    return undefined;
};

export const isChildCompletedObservation = <Result = unknown, Input = unknown>(
    observation: Observation<unknown>
): observation is ChildCompletedObservation<Result, Input> =>
    !!observation && observation.kind === CHILD_COMPLETED_KIND && observation.source === 'child' && isRecord(observation.payload);

export const extractChildResult = <Result = unknown, Input = unknown>(
    observation?: ChildCompletedObservation<Result, Input> | null
): Result | undefined => {
    if (!observation) return undefined;
    return getResultFromSnapshot<Result>(observation.payload?.result);
};

export type ChildCompletionDetails<Result = unknown, Input = unknown> = {
    observation: ChildCompletedObservation<Result, Input>;
    payload: ChildCompletedPayload<Result, Input>;
    snapshot: InteractiveTaskSnapshot<Result, Input>;
    status?: TaskStatusWithResult<Result>;
    result?: Result;
};

export const findChildCompletion = <Result = unknown, Input = unknown>(
    observations: Observation<unknown>[],
    token?: string
): ChildCompletionDetails<Result, Input> | undefined => {
    for (const observation of observations) {
        if (!isChildCompletedObservation<Result, Input>(observation)) continue;
        if (token && observation.payload.token !== token) continue;
        const snapshot = observation.payload.result;
        const status = getTaskStatus<Result>(snapshot);
        const result = getResultFromSnapshot<Result>(snapshot);
        return {
            observation,
            payload: observation.payload,
            snapshot,
            status,
            result
        };
    }
    return undefined;
};


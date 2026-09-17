import type { EnvironmentState, MemoryReader, Observation } from '@a2arium/callagent-core';
import { normalizeUserObservation } from './normalizers/user.js';
import type { ParentAttention, ParentObservation } from './types.js';

export function perception(
    env: EnvironmentState,
    _attention: ParentAttention,
    _memory: MemoryReader
): ParentObservation {
    const childObservation = env.inbox.current.find(
        (observation): observation is Extract<Observation, { source: 'child' }> =>
            observation.source === 'child' && observation.kind === 'child.completed'
    );
    if (childObservation !== undefined) {
        const payload = childObservation.payload;
        if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
            const record = payload as Record<string, unknown>;
            return {
                kind: 'child/completed',
                token: typeof record.token === 'string' ? record.token : 'unknown',
                childTaskId: typeof record.childTaskId === 'string' ? record.childTaskId : undefined,
                result: record.result,
            };
        }
    }

    const userObservation = env.inbox.current.find(
        (observation): observation is Extract<Observation, { source: 'user' }> =>
            observation.source === 'user'
    );
    return userObservation !== undefined
        ? normalizeUserObservation(userObservation)
        : { kind: 'runtime/no_input' };
}

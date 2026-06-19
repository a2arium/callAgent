import type { EnvironmentState, MemoryReader, Observation } from '@a2arium/callagent-core';
import { normalizeUserObservation } from './normalizers/user.js';
import type { Attention, Phase2Observation } from './types.js';

export function perception(
    env: EnvironmentState,
    _attention: Attention,
    _memory: MemoryReader
): Phase2Observation {
    const userObservation = env.inbox.current.find(
        (observation): observation is Extract<Observation, { source: 'user' }> =>
            observation.source === 'user'
    );

    return userObservation !== undefined
        ? normalizeUserObservation(userObservation)
        : { kind: 'runtime/no_input' };
}

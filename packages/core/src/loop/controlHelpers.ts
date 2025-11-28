import type { ControlState, EnvironmentState } from './types.js';
import type { ObservationConfig } from './oneTurn.js';

/**
 * Safely read a pending token (input/tool/child/group) from the control snapshot.
 */
export function getPendingToken<Payload extends ObservationConfig = ObservationConfig>(
    env: EnvironmentState<Payload> | { control?: ControlState },
    kind: 'inputs' | 'children' | 'tools' | 'groups',
    key?: string
): string | undefined {
    const pending = env.control?.pendingSnapshot;
    if (!pending) return undefined;
    const bucket = (pending as any)[kind] as Record<string, any> | undefined;
    if (!bucket) return undefined;
    if (key) return bucket[key]?.token ?? bucket[key];
    // If no key provided, return the first token if present
    const first = Object.values(bucket)[0] as any;
    return first?.token ?? undefined;
}

/**
 * Returns the control snapshot from env, or an empty object if unavailable.
 */
export function controlSnapshot<Payload extends ObservationConfig = ObservationConfig>(
    env: EnvironmentState<Payload> | { control?: ControlState }
): ControlState {
    return env.control || {};
}

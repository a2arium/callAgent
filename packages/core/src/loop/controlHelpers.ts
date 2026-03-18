import type { ControlState, ControlPendingState, EnvironmentState } from './types.js';

type TokenEntry = string | ({ token?: string } & Record<string, unknown>);

/**
 * Safely read a pending token (input/tool/child/group) from the control snapshot.
 */
export function getPendingToken(
    env: EnvironmentState | { control?: ControlState },
    kind: 'inputs' | 'children' | 'tools' | 'groups',
    key?: string
): string | undefined {
    const pending: ControlPendingState | undefined = env.control?.pendingSnapshot;
    if (!pending) return undefined;
    const bucket = pending[kind] as Record<string, TokenEntry> | undefined;
    if (!bucket) return undefined;
    if (key) {
        const entry = bucket[key];
        return typeof entry === 'string' ? entry : (entry as { token?: string })?.token;
    }
    const first = Object.values(bucket)[0] as TokenEntry | undefined;
    return typeof first === 'string' ? first : (first as { token?: string })?.token;
}

/**
 * Returns the control snapshot from env, or an empty object if unavailable.
 */
export function controlSnapshot(
    env: EnvironmentState | { control?: ControlState }
): ControlState {
    return env.control || {};
}

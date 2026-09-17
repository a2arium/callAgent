import type { ExecErrorPayload } from '@a2arium/callagent-core';

export const PHASE2_PARENT_AGENT_ID = 'phase2-parent-agent';

export type ParentSensory = {
    latestUserText?: string;
    childResult?: unknown;
};

export type ParentObservation =
    | { kind: 'user/input_provided'; text: string }
    | { kind: 'child/completed'; token: string; childTaskId?: string; result: unknown }
    | { kind: 'runtime/no_input' };

export type ParentAttention = {
    hasCurrentInput: boolean;
};

export type ParentExecPayload =
    | { kind: 'child_delegated'; token: string; childTaskId?: string; result: unknown }
    | { kind: 'parent_replied'; text: string }
    | { kind: 'idle_complete' };

export type ParentExecError = ExecErrorPayload;

import type { ExecErrorPayload, Intent } from '@a2arium/callagent-core';

export type Phase2Stage =
    | 'observe'
    | 'ask_for_missing_detail'
    | 'answer_with_summary'
    | 'complete_idle';

export type Sensory = {
    latestUserText?: string;
    askedForDetail: boolean;
};

export type Phase2Observation =
    | { kind: 'user/input_provided'; text: string }
    | { kind: 'runtime/no_input' };

export type Phase2Intent =
    | Extract<Intent, { kind: 'prompt_user' }>
    | Extract<Intent, { kind: 'internal' }>
    | Extract<Intent, { kind: 'complete' }>;

export type Attention = {
    hasCurrentInput: boolean;
};

export type ExecPayload =
    | { kind: 'detail_requested'; token: string }
    | { kind: 'summary_replied'; text: string }
    | { kind: 'idle_complete' };

export type ExecError = ExecErrorPayload;

export const PHASE2_LOOP_AGENT_ID = 'phase2-loop-agent';

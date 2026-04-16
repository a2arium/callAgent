import type { MentalState } from '@a2arium/callagent-core';

export type Sensory = {
    latestUserText?: string;
};

export type Obs =
    | { kind: 'user_message'; text: string }
    | { kind: 'idle' };

export type AgentIntent =
    | { kind: 'complete'; result?: unknown }
    | { kind: 'wait' };

export type Stage = 'idle' | 'running' | 'completed' | 'failed';

export type ExecPayload = {
    idle?: boolean;
    echoed?: unknown;
};

export type ExecError = {
    code: string;
    message: string;
};

export type M = MentalState<Sensory>;

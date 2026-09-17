import type { MentalState } from '@a2arium/callagent-core';

export type Sensory = {
    latestUserText?: string;
};

export type Obs =
    | { kind: 'user_message'; text: string }
    | { kind: 'idle' };

export type ExecPayload = {
    idle?: boolean;
    echoed?: unknown;
};

export type ExecError = {
    code: string;
    message: string;
};

export type M = MentalState<Sensory>;

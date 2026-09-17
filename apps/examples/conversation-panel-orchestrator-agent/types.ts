import type { MentalState } from '@a2arium/callagent-core';

export type Sensory = {
    userText?: string;
    demoStage?: 'idle' | 'want_run';
};

export type Obs = { kind: 'user_message'; text: string } | { kind: 'idle' };

export type ExecPayload = {
    panelDone?: boolean;
    topicId?: string;
    turnsCompleted?: number;
    summary?: string;
};

export type ExecError = {
    code: string;
    message: string;
};

export type M = MentalState<Sensory>;

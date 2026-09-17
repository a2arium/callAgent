import type { MentalState } from '@a2arium/callagent-core';
import type { PanelLens } from './constants.js';

export type Sensory = {
    activeTopicId?: string;
    wantVoice?: boolean;
    promptRound?: number;
    promptText?: string;
    inboundMessageId?: string;
    inboundSequence?: number;
    lens?: PanelLens;
    seatMemberId?: string;
};

export type Obs =
    | {
          kind: 'panel_prompt';
          topicId: string;
          seatMemberId: string;
          round: number;
          promptText: string;
          inboundMessageId: string;
          inboundSequence: number;
          lens: PanelLens;
      }
    | { kind: 'idle' };

export type ExecPayload = {
    voiced?: boolean;
    topicId?: string;
    outboundPreview?: string;
};

export type ExecError = {
    code: string;
    message: string;
};

export type M = MentalState<Sensory>;

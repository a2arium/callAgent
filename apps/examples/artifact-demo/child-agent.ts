import {
    createAgent,
    type MentalState,
    type ObservationConfig,
    type TaskContext,
    type ProposedAction,
    type ExecutableAction,
    type ExecResult,
    type TransitionOut
} from '@a2arium/callagent-core';

type ChildSensory = Record<string, never>;
type ChildObservation = ObservationConfig;

export default createAgent<ChildSensory, ChildObservation>({
    manifest: './child-agent.json',
    tenantId: 'default',

    attention: () => ({}),
    perception: () => ({}),
    learning: (prev) => prev,

    policy: (): ProposedAction => ({
        kind: 'internal',
        intent: 'complete'
    }),

    execution: async (): Promise<{ action: ExecutableAction; result: ExecResult }> => {
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'ok',
                ts: Date.now(),
                data: { message: 'child-completed' }
            }
        };
    },

    transition: (): TransitionOut<ObservationConfig> => ({
        kind: 'complete',
        result: { message: 'child complete' }
    })
}, import.meta.url);


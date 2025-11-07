import {
    createAgent,
    type EnvironmentState,
    type ExecErrorPayload,
    type ExecResult,
    type ExecutableAction,
    type MentalState,
    type Observation,
    type ProposedAction,
    type TaskContext,
    type TransitionOut
} from '@a2arium/callagent-core';

import { logger } from '@a2arium/callagent-utils';

type ParentExecData = {
    awaitingChild?: boolean;
    token?: string;
    html?: string;
};

type ParentObservationPayload = {
    html?: string;
    token?: string;
    status?: string;
};

type ParentObservation = Observation<ParentObservationPayload>;

type ParentPerception = {
    inbox: ParentObservation[];
    htmlFromChild?: string;
    tokenFromChild?: string;
    inputUrl?: string;
};

type ParentSensory = {
    html?: string;
    token?: string;
};

const parentLog = logger.createLogger({ prefix: 'ParentAgent' });

const childAgentName = 'loop-await-child-demo-child';

const readChildObservation = (observations: ParentObservation[]): { html?: string; token?: string; status?: string } => {
    for (const obs of observations) {
        if (!obs) continue;
        if (obs.source === 'child' || obs.kind === 'child.completed') {
            const payload = obs.payload ?? {};
            if (payload) {
                if (payload.html || (payload as any)?.result) {
                    const result = (payload as any)?.result;
                    const html = typeof payload.html === 'string' ? payload.html : result?.data?.html;
                    const token = typeof payload.token === 'string' ? payload.token : result?.token ?? result?.data?.token;
                    const status = typeof payload.status === 'string' ? payload.status : result?.status;
                    return { html, token, status };
                }
            }
        }
        if (obs.kind === 'fetch-webpage.result') {
            const html = typeof obs.payload?.html === 'string' ? obs.payload.html : undefined;
            const token = typeof obs.payload?.token === 'string' ? obs.payload.token : undefined;
            const status = typeof obs.payload?.status === 'string' ? obs.payload.status : undefined;
            if (html || token || status) {
                return { html, token, status };
            }
        }
    }
    return {};
};

export default createAgent<ParentSensory, ParentPerception, unknown, ParentExecData, ExecErrorPayload, ParentObservationPayload>({
    manifest: {
        name: 'loop-await-child-demo-parent',
        version: '0.1.0',
        runMode: 'loop',
        budgets: {
            maxTurns: 4
        },
        dependencies: {
            agents: [childAgentName]
        }
    },

    perception: (env: EnvironmentState<ParentObservationPayload>): ParentPerception => {
        const inbox = Array.isArray(env.inbox?.current) ? env.inbox.current : [];
        const childResult = readChildObservation(inbox);
        const inputUrl = typeof (env.input as Record<string, unknown> | undefined)?.url === 'string'
            ? String((env.input as Record<string, unknown>).url)
            : undefined;

        parentLog.info('[Perception] Turn resumed', {
            turn: env.turn,
            inboxCount: inbox.length,
            htmlPresent: Boolean(childResult.html),
            token: childResult.token,
            inputUrl
        });

        return {
            inbox,
            htmlFromChild: childResult.html,
            tokenFromChild: childResult.token,
            inputUrl
        };
    },

    learning: (prev: MentalState<ParentSensory>, _prevAction: ProposedAction | undefined, obs: ParentPerception) => {
        const nextSensory: ParentSensory = {
            html: obs.htmlFromChild ?? prev.memory?.sensory?.html,
            token: obs.tokenFromChild ?? prev.memory?.sensory?.token
        };
        const vars = prev.memory?.vars ?? {};
        if (obs.htmlFromChild) {
            vars.childHtml = obs.htmlFromChild;
        }
        if (obs.tokenFromChild) {
            vars.childToken = obs.tokenFromChild;
        }
        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: nextSensory,
                vars
            }
        };
    },

    policy: (m: MentalState<ParentSensory>): ProposedAction => {
        const vars = (m.memory?.vars ?? {}) as Record<string, unknown>;
        const html = typeof vars.childHtml === 'string' ? vars.childHtml : undefined;

        if (html && html.trim().length > 0) {
            parentLog.info('[Policy] HTML already present; completing');
            return { kind: 'internal', intent: 'complete_with_html' };
        }

        const stage = typeof vars.stage === 'string' ? vars.stage : 'idle';
        if (stage === 'awaiting_child') {
            parentLog.info('[Policy] Still waiting for child completion');
            return { kind: 'internal', intent: 'await_child' };
        }

        parentLog.info('[Policy] No HTML available; dispatching child');
        return { kind: 'internal', intent: 'fetch_child' };
    },

    shield: (_m, action) => ({ action: 'pass', intent: action }),

    execution: async (action: ProposedAction, ctx: TaskContext, m: MentalState<ParentSensory>) => {
        const vars = (m.memory?.vars ?? {}) as Record<string, unknown>;

        if (action.kind === 'internal' && action.intent === 'fetch_child') {
            const input = (ctx.task.input ?? {}) as { url?: string };
            const url = typeof input.url === 'string' && input.url.trim().length > 0
                ? input.url.trim()
                : 'https://example.com/demo';

            parentLog.info('[Execution] Dispatching child agent', { url });

            const handleOrResult = await ctx.sendTaskToAgent(childAgentName, { url }, {
                awaitCompletion: false,
                tokenPath: 'child.token',
                setStage: 'awaiting_child'
            } as any);

            const token = (handleOrResult as { token?: string } | undefined)?.token
                ?? (ctx.vars.get('child.token') as string | undefined);

            ctx.vars.set('stage', 'awaiting_child');

            return {
                action: { kind: 'internal', done: false } satisfies ExecutableAction,
                result: {
                    status: 'ok',
                    data: {
                        awaitingChild: true,
                        token
                    }
                } satisfies ExecResult<ParentExecData>
            };
        }

        if (action.kind === 'internal' && action.intent === 'complete_with_html') {
            const html = typeof vars.childHtml === 'string' ? vars.childHtml : undefined;
            parentLog.info('[Execution] Completing with HTML', { htmlLength: html?.length ?? 0 });
            return {
                action: { kind: 'internal', done: true } satisfies ExecutableAction,
                result: {
                    status: 'ok',
                    data: {
                        html,
                        awaitingChild: false
                    }
                } satisfies ExecResult<ParentExecData>
            };
        }

        parentLog.warn('[Execution] Received unexpected action', action);
        return {
            action: { kind: 'internal', done: true } satisfies ExecutableAction,
            result: {
                status: 'error',
                error: {
                    code: 'unexpected_action',
                    message: `Unhandled action ${action.kind}`
                }
            } satisfies ExecResult<ParentExecData>
        };
    },

    transition: (
        env: EnvironmentState<ParentObservationPayload>,
        exec: { action: ExecutableAction; result: ExecResult<ParentExecData> },
        m: MentalState<ParentSensory>
    ): TransitionOut<ParentObservationPayload> => {
        const data = exec.result.data ?? {};
        const html = typeof data.html === 'string'
            ? data.html
            : typeof (m.memory?.vars as Record<string, unknown> | undefined)?.childHtml === 'string'
                ? String((m.memory?.vars as Record<string, unknown>).childHtml)
                : undefined;

        if (data.awaitingChild) {
            parentLog.info('[Transition] Awaiting child completion', { token: data.token });
            return { kind: 'await_child', token: data.token ?? 'unknown-token' };
        }

        if (html && html.trim().length > 0) {
            parentLog.info('[Transition] Completing with HTML', { htmlLength: html.length });
            return { kind: 'complete', result: { html } };
        }

        parentLog.warn('[Transition] No HTML available; failing turn', {
            inboxCount: env.inbox.current.length
        });
        return { kind: 'fail', reason: 'no_html_available' };
    }
}, import.meta.url);


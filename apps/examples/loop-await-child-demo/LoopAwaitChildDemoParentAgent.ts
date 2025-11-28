import {
    createAgent,
    type EnvironmentState,
    type ExecErrorPayload,
    type ExecResult,
    type ExecutableAction,
    type MentalState,
    type MemoryReader,
    type ObservationConfig,
    type ProposedAction,
    type SynthesizeObservation,
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

type ParentObservationConfig = ObservationConfig & {
    user: { url?: string };
    child: Record<string, unknown>;
    internal: ParentObservationPayload;
    env: ParentObservationPayload;
};

type ParentObservation = SynthesizeObservation<ParentObservationConfig>;

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

const noopLLMAdapter = {
    async call() {
        return [] as unknown[];
    },
    getMessages() {
        return [] as unknown[];
    },
    importState(_state: unknown) {
        return;
    },
    exportState() {
        return [] as unknown[];
    }
};

const childAgentName = 'loop-await-child-demo-child';

const readChildObservation = (observations: ParentObservation[]): { html?: string; token?: string; status?: string } => {
    for (const obs of observations) {
        if (!obs) continue;
        if (obs.source === 'child' && obs.kind === 'child.completed') {
            const payload = obs.payload;
            const snapshot = payload.result as Record<string, unknown> | undefined;
            const nestedResult = (snapshot?.result as Record<string, unknown>) || snapshot;
            const html = typeof (nestedResult?.data as Record<string, unknown> | undefined)?.html === 'string'
                ? String((nestedResult!.data as Record<string, unknown>).html)
                : typeof nestedResult?.html === 'string'
                    ? String(nestedResult.html)
                    : undefined;
            const token =
                typeof payload.result?.id === 'string' ? payload.result.id :
                    typeof payload.childTaskId === 'string' ? payload.childTaskId :
                        typeof nestedResult?.token === 'string' ? nestedResult.token :
                            typeof (nestedResult?.data as Record<string, unknown> | undefined)?.token === 'string'
                                ? String((nestedResult!.data as Record<string, unknown>).token)
                                : payload.token;
            const status = typeof nestedResult?.status === 'string'
                ? nestedResult.status
                : typeof (nestedResult?.result as Record<string, unknown> | undefined)?.status === 'string'
                    ? String((nestedResult!.result as Record<string, unknown>).status)
                    : undefined;
            if (html || token || status) {
                return { html, token, status };
            }
        }
        if (obs.source === 'internal' && obs.kind === 'fetch-webpage.result') {
            const payload = obs.payload as ParentObservationPayload;
            const html = typeof payload?.html === 'string' ? payload.html : undefined;
            const token = typeof payload?.token === 'string' ? payload.token : undefined;
            const status = typeof payload?.status === 'string' ? payload.status : undefined;
            if (html || token || status) {
                return { html, token, status };
            }
        }
    }
    return {};
};

const parentAgent = createAgent({
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

    perception: (env: EnvironmentState<ParentObservationConfig>): ParentPerception => {
        const inbox = Array.isArray(env.inbox?.current) ? env.inbox.current : [];
        const childResult = readChildObservation(inbox);

        // Extract input from inbox
        const userInput = inbox.find(o => o.source === 'user' && o.kind === 'input.provided');
        const inputValue = userInput?.payload.value;
        const inputUrl = typeof inputValue?.url === 'string' ? String(inputValue.url) : undefined;

        parentLog.info('[Perception] Turn resumed', {
            turn: env.turn,
            inboxCount: inbox.length,
            htmlPresent: Boolean(childResult.html),
            token: childResult.token,
            inputUrl
} as any);

        console.log('[LoopAwaitChildDemo][Perception]', {
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

    policy: (m: MentalState<ParentSensory>, _mem: MemoryReader): ProposedAction => {
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

    shield: (_m, action, _mem: MemoryReader) => ({ action: 'pass', intent: action }),

    execution: async (action: ProposedAction, ctx: TaskContext, _mem: MemoryReader, m: MentalState<ParentSensory>) => {
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
            console.log('[LoopAwaitChildDemo][Execution] Completing with HTML', { htmlLength: html?.length ?? 0 });
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
        env: EnvironmentState<ParentObservationConfig>,
        exec: { action: ExecutableAction; result: ExecResult<ParentExecData> },
        m: MentalState<ParentSensory>
    ): TransitionOut<ParentObservationConfig> => {
        const data = exec.result.data ?? {};
        const html = typeof data.html === 'string'
            ? data.html
            : typeof (m.memory?.vars as Record<string, unknown> | undefined)?.childHtml === 'string'
                ? String((m.memory?.vars as Record<string, unknown>).childHtml)
                : undefined;

        if (data.awaitingChild) {
            parentLog.info('[Transition] Awaiting child completion', { token: data.token });
            console.log('[LoopAwaitChildDemo][Transition] Awaiting child completion', { token: data.token });
            return { kind: 'await_child', token: data.token ?? 'unknown-token' };
        }

        if (html && html.trim().length > 0) {
            parentLog.info('[Transition] Completing with HTML', { htmlLength: html.length });
            console.log('[LoopAwaitChildDemo][Transition] Completing with HTML', { htmlLength: html.length });
            return { kind: 'complete', result: { html } };
        }

        parentLog.warn('[Transition] No HTML available; failing turn', {
            inboxCount: env.inbox.current.length
        });
        console.warn('[LoopAwaitChildDemo][Transition] No HTML available', { inboxCount: env.inbox.current.length });
        return { kind: 'fail', reason: 'no_html_available' };
    }
}, import.meta.url);

(parentAgent as unknown as { llmAdapter?: unknown }).llmAdapter = noopLLMAdapter;

export default parentAgent;

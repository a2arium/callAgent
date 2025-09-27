import { createAgent } from '@a2arium/callagent-core';

// Loop-first example using top-level module sugar
export default createAgent({
    manifest: { name: 'loop-agent-mini', version: '0.1.0', runMode: 'loop', hitl: 'consent' },
    // Selects focus for this turn.
    // args: mentalState (agent state from previous turn), env (runtime input)
    // returns: attention signal consumed by perception
    attention: (mentalState: any, env: any) => {
        console.log('token in attention', mentalState.vars?.inputToken);
        return { focus: 'demo' };
    },
    // Converts environment into an observation for this turn.
    // args: env (runner-provided input), attention (from attention)
    // returns: observation consumed by learning and policy
    perception: (env: any, attention: any) => ({ input: env.input, time: env.time, attention }),
    // Updates long-term memory with the latest observation.
    // args: prevMentalState (previous agent state), prevAction (action chosen last turn), obs (from perception)
    // returns: updated agent state
    learning: (prevMentalState: any, prevAction: any, obs: any) => {
        const e = (prevMentalState.memory.longTerm.episodic || []) as any[];
        e.push({ t: Date.now(), obs });
        (prevMentalState.memory.longTerm as any).episodic = e;
        return prevMentalState;
    },
    // Chooses the next action based on observation and state.
    // args: mentalState (current state after learning), prevMentalState (prior state), obs (from perception)
    // returns: action (e.g., ask_user | language | internal)
    policy: (mentalState: any, prevMentalState?: any, obs?: any) => {
        console.log('policy obs', obs);
        const inputKind = (obs as any)?.input?.kind;
        const inputVal = (obs as any)?.input?.value;
        if (inputKind === 'input') {
            return { kind: 'language', content: `Approval received: ${String(inputVal ?? '')}` } as any;
        }
        return { kind: 'ask_user', prompt: 'Approve this action?' } as any;
    },
    // Optional policy-guard/safety layer to adjust or veto actions.
    // args: mentalState (current state), action (from policy)
    // returns: final action passed to execution
    shield: (mentalState: any, action: any) => action,
    // Performs side effects for the chosen action.
    // args: action (from shield), ctx (runner exec context with helpers)
    // returns: execution result consumed by transition
    execution: async (action: any, ctx: any) => {
        if (action?.kind === 'ask_user') {
            const handle = await ctx.requestInput(action.prompt);
            ctx.vars.set('inputToken', (handle as any)?.token || '');
            return { kind: 'ask_user', token: (handle as any)?.token || '' } as any;
        }
        if (action?.kind === 'language') {
            console.log('token in language', (ctx as any).vars.get('inputToken'));
            await ctx.reply(action.content);
            return { kind: 'language', echoed: true } as any;
        }
        return { kind: 'internal', done: true } as any;
    },
    // Decides the loop control state for the next step/turn.
    // args: env (runner-provided input), executionResult (from execution)
    // returns: loop state (await_input | complete | continue)
    transition: (env: any, executionResult: any) => {
        if (executionResult?.kind === 'ask_user') return { kind: 'await_input', token: executionResult.token } as any;
        if ((env?.input?.kind === 'input') && executionResult?.kind === 'language') return { kind: 'complete', result: 'ok' } as any;
        return { kind: 'continue' } as any;
    }
}, import.meta.url);




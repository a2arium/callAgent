/**
 * APLRET Bug Reproduction Agent
 * 
 * Minimal reproduction of two critical framework bugs:
 * - Bug #1: Agent memory vars not persisting between turns
 * - Bug #2: Multiple sequential A2A calls not supported
 * 
 * Architecture: Pure APLRET (Attention-Perception-Learning-Reasoning-Execution-Transition)
 */

import { createAgent } from '@a2arium/callagent-core';
import type {
    TaskContext,
    MentalState,
    ExecutableAction,
    EnvironmentState,
    AttentionSignal,
    ExecResult,
    ExecErrorPayload,
    TransitionOut,
    ProposedAction
} from '@a2arium/callagent-core';

// === Types ===

type Stage = 
    | 'idle' 
    | 'testing_vars' 
    | 'awaiting_first_child'
    | 'testing_second_a2a'
    | 'awaiting_second_child'
    | 'completed';

type Sensory = {
    testMode?: 'test-vars' | 'test-a2a' | 'test-both';
    varsTestResult?: 'pass' | 'fail';
    a2aTestResult?: 'pass' | 'fail';
    errorDetails?: string;
    lastChildCompleted?: number;
};

type Obs = {
    text?: string;
    eventType: 'init' | 'child_completed' | 'vars_tested' | 'idle';
    testResult?: { bug: string; status: 'pass' | 'fail'; details: string };
};

type InboxPayload = {
    value?: string | { text?: string };
    token?: string;
    result?: unknown;
};

// === Stage Management ===

const V = {
    stage: (ctx: TaskContext): Stage => 
        ((ctx.vars as any).stage as Stage) ?? 'idle',
    setStage: (ctx: TaskContext, s: Stage) => 
        (ctx.vars as any).stage = s,
    
    counter: (ctx: TaskContext) => 
        (ctx.vars as any).counter as number | undefined,
    setCounter: (ctx: TaskContext, n: number) => 
        (ctx.vars as any).counter = n,
    
    sessionId: (ctx: TaskContext) => 
        (ctx.vars as any).sessionId as string | undefined,
    setSessionId: (ctx: TaskContext, id: string) => 
        (ctx.vars as any).sessionId = id,
    
    firstA2ASuccess: (ctx: TaskContext) => 
        (ctx.vars as any).firstA2ASuccess as boolean | undefined,
    setFirstA2ASuccess: (ctx: TaskContext, v: boolean) => 
        (ctx.vars as any).firstA2ASuccess = v,
    
    token: (ctx: TaskContext) => 
        (ctx.vars as any).token as string | undefined,
    setToken: (ctx: TaskContext, t?: string) => 
        (ctx.vars as any).token = t,
};

// === Agent Implementation ===

export default createAgent<Sensory, Obs, AttentionSignal, unknown, ExecErrorPayload, InboxPayload>({
    manifest: {
        name: 'aplret-bug-reproduction',
        version: '1.0.0',
        runMode: 'loop',
        budgets: { maxTurns: 10 },
        dependencies: {
            agents: ['helper-agent'] // For Bug #2 testing
        }
    },

    llmConfig: {
        provider: 'openai',
        modelAliasOrName: 'fast',
        systemPrompt: 'You are a test agent for framework bug reproduction.'
    },

    // === A - Attention ===
    attention: (m, env): AttentionSignal => {
        return {
            wantPrompt: env.inbox.current.length === 0
        };
    },

    // === P - Perception ===
    perception: (env: EnvironmentState<InboxPayload>): Obs => {
        console.log('\n[Perception] Processing inbox:', {
            count: env.inbox.current.length,
            sources: env.inbox.current.map(o => o.source),
            envInputKind: (env.input as any)?.kind
        });

        // Priority 1: Check for child completion in inbox (resume after A2A)
        const childObs = env.inbox.current.find(o => 
            o.source === 'child' && o.kind === 'child.completed'
        );
        
        if (childObs) {
            console.log('[Perception] Child completion detected');
            return {
                eventType: 'child_completed',
                text: 'Child agent completed'
            };
        }

        // Priority 2: Check for user input in inbox
        const userObs = env.inbox.current.find(o => o.source === 'user');
        if (userObs) {
            const value = (userObs.payload as InboxPayload)?.value;
            const text = typeof value === 'string' ? value : value?.text;
            console.log('[Perception] User input detected:', { text });
            return {
                eventType: 'init',
                text
            };
        }

        // Priority 3: Check for initial input from env.input (only on first turn)
        if (env.input && (env.input as any).kind !== 'child') {
            const input = env.input as { value?: string | { text?: string } };
            const value = input.value;
            const text = typeof value === 'string' ? value : (value as any)?.text;
            
            console.log('[Perception] Initial input detected:', { text });
            
            return {
                eventType: 'init',
                text
            };
        }

        return { eventType: 'idle' };
    },

    // === L - Learning (ONLY writer of M) ===
    learning: (prev, _action, obs: Obs): MentalState<Sensory> => {
        console.log('[Learning] Updating mental state from observation:', {
            eventType: obs.eventType,
            hasTestResult: !!obs.testResult,
            prevTestMode: prev.memory.sensory?.testMode,
            prevVars: prev.memory.vars
        });

        // Parse test mode from initial input (only on first turn)
        const currentTestMode = (prev.memory.vars?.testMode as string) || prev.memory.sensory?.testMode;
        
        if (obs.eventType === 'init' && obs.text && !currentTestMode) {
            try {
                const input = JSON.parse(obs.text);
                
                // IMPORTANT: Write test state to M.memory.vars
                // BUG DISCOVERY: M.memory.sensory gets overwritten during A2A/resume!
                // Workaround: Store testMode in vars instead of sensory
                const newVars = {
                    ...(prev.memory.vars || {}),
                    testCounter: ((prev.memory.vars?.testCounter as number) ?? 0) + 1,
                    testMode: input.mode || 'test-both' // Store in vars for persistence!
                };
                
                console.log('[Learning] Initial setup - Writing to M.memory.vars (including testMode):', newVars);
                
                return {
                    ...prev,
                    memory: {
                        ...prev.memory,
                        vars: newVars,
                        sensory: {
                            testMode: input.mode || 'test-both'
                        }
                    }
                };
            } catch {
                // Default mode
                return {
                    ...prev,
                    memory: {
                        ...prev.memory,
                        sensory: { testMode: 'test-both' }
                    }
                };
            }
        }

        // Handle child completion - preserve test mode
        if (obs.eventType === 'child_completed') {
            const prevSensory = prev.memory.sensory || {};
            console.log('[Learning] Child completed - preserving state, prevSensory:', prevSensory);
            return {
                ...prev,
                memory: {
                    ...prev.memory,
                    sensory: {
                        ...prevSensory,
                        lastChildCompleted: Date.now()
                    } as Sensory
                }
            };
        }

        // Store test results
        if (obs.testResult) {
            const sensory = prev.memory.sensory || {};
            if (obs.testResult.bug === 'vars') {
                return {
                    ...prev,
                    memory: {
                        ...prev.memory,
                        sensory: {
                            ...sensory,
                            varsTestResult: obs.testResult.status,
                            errorDetails: obs.testResult.details
                        }
                    }
                };
            }
            if (obs.testResult.bug === 'a2a') {
                return {
                    ...prev,
                    memory: {
                        ...prev.memory,
                        sensory: {
                            ...sensory,
                            a2aTestResult: obs.testResult.status,
                            errorDetails: obs.testResult.details
                        }
                    }
                };
            }
        }

        return prev;
    },

    // === R - Policy (pure function of M) ===
    policy: (m: MentalState<Sensory>): ProposedAction => {
        const turn = (m.memory.vars?.turn as number) ?? 0;
        const testCounter = (m.memory.vars?.testCounter as number) ?? 0;
        // Read testMode from vars (fallback to sensory for backwards compat)
        const testMode = (m.memory.vars?.testMode as string) || m.memory.sensory?.testMode;
        const varsResult = m.memory.sensory?.varsTestResult;
        const a2aResult = m.memory.sensory?.a2aTestResult;

        console.log(`\n[Policy] Turn ${turn}, TestCounter ${testCounter}, Mode: ${testMode}`, {
            'M.memory.vars': m.memory.vars,
            'M.memory.sensory (keys)': Object.keys(m.memory.sensory || {}),
            varsResult,
            a2aResult
        });
        
        // If testCounter is still 0 after 2 turns, vars aren't persisting from Learning
        if (testCounter === 0 && turn >= 2) {
            console.log('❌ BUG DETECTED: testCounter should be > 0 by now!');
        }

        // Turn 0: Start tests
        if (turn === 0) {
            if (testMode === 'test-vars' || testMode === 'test-both') {
                return { kind: 'internal', intent: 'test_vars_persistence' };
            }
            if (testMode === 'test-a2a') {
                return { kind: 'internal', intent: 'test_first_a2a' };
            }
        }

        // Turn 1: Check vars test result
        if (turn === 1 && varsResult) {
            if (testMode === 'test-both') {
                return { kind: 'internal', intent: 'test_first_a2a' };
            }
            return { kind: 'internal', intent: 'report_results' };
        }

        // Turn 2: After first A2A completes
        if (turn === 2 && a2aResult === undefined) {
            return { kind: 'internal', intent: 'test_second_a2a' };
        }

        // Turn 3: Report final results
        if (varsResult || a2aResult) {
            return { kind: 'internal', intent: 'report_results' };
        }

        return { kind: 'internal', intent: 'wait' };
    },

    // === S - Shield ===
    shield: (_m, intent) => {
        return { action: 'pass', intent };
    },

    // === E - Execution ===
    execution: async (action: ProposedAction, ctx: TaskContext, m: MentalState<Sensory>): Promise<{
        action: ExecutableAction;
        result: ExecResult<unknown>;
    }> => {
        const stage = V.stage(ctx);
        const intent = (action as any).intent as string;
        console.log(`\n[Execution] Stage: ${stage}, Intent: ${intent}`);

        // === BUG #1 TEST: Vars Persistence ===
        if (intent === 'test_vars_persistence') {
            await ctx.reply('🧪 Testing Bug #1: Memory vars persistence\n');
            
            const turn = (m.memory.vars?.turn as number) ?? 0;
            
            if (turn === 0) {
                // TURN 0: Write test vars to M.memory.vars via Learning
                console.log('[Bug #1] Turn 0: Writing test vars to M.memory.vars');
                console.log('[Bug #1] Turn 0: Current M.memory.vars:', m.memory.vars);
                
                // These should persist via Learning module
                const testVars = {
                    counter: 1,
                    sessionId: 'test-session-abc123',
                    timestamp: Date.now()
                };
                
                await ctx.reply(`📝 Writing to M.memory.vars:\n${JSON.stringify(testVars, null, 2)}\n`);
                
                V.setStage(ctx, 'testing_vars');
                ctx.vars.set('turn', 1); // Increment turn counter
                
                console.log('[Bug #1] Turn 0: Set turn=1 in ctx.vars for next turn');
                
                // Return observation that Learning will process
                return {
                    action: { kind: 'internal', done: false },
                    result: {
                        status: 'ok',
                        ts: Date.now(),
                        data: testVars
                    }
                };
            }
            
            if (turn === 1) {
                // TURN 1: Read vars from M - they should be there!
                console.log('[Bug #1] Turn 1: Reading vars from M.memory.vars');
                
                const prevCounter = m.memory.vars?.counter;
                const prevSessionId = m.memory.vars?.sessionId;
                const prevTimestamp = m.memory.vars?.timestamp;
                
                console.log('[Bug #1] Vars from M.memory.vars:', {
                    counter: prevCounter,
                    sessionId: prevSessionId,
                    timestamp: prevTimestamp
                });
                
                const passed = prevCounter === 1 && 
                              prevSessionId === 'test-session-abc123' &&
                              typeof prevTimestamp === 'number';
                
                if (passed) {
                    await ctx.reply('✅ Bug #1 Test: PASS - Vars persisted correctly!\n');
                } else {
                    await ctx.reply(`❌ Bug #1 Test: FAIL - Vars were lost!\n
Expected: { counter: 1, sessionId: 'test-session-abc123', timestamp: <number> }
Actual: { counter: ${prevCounter}, sessionId: ${prevSessionId}, timestamp: ${prevTimestamp} }

🐛 BUG REPRODUCED: Agent-defined vars in M.memory.vars do not persist between turns.
\n`);
                }
                
                V.setStage(ctx, 'completed');
                
                return {
                    action: { kind: 'internal', done: false },
                    result: {
                        status: passed ? 'ok' : 'error',
                        ts: Date.now(),
                        data: {
                            testResult: {
                                bug: 'vars',
                                status: passed ? 'pass' : 'fail',
                                details: passed ? 'Vars persisted' : `Expected counter=1, got ${prevCounter}`
                            }
                        }
                    }
                };
            }
        }

        // === BUG #2 TEST: Multiple A2A Calls ===
        if (intent === 'test_first_a2a') {
            await ctx.reply('🧪 Testing Bug #2: First A2A call\n');
            
            try {
                // Note: This requires a helper-agent to exist
                // For testing, we'll catch the error if agent not found
                const handle = await ctx.sendTaskToAgent('helper-agent', {
                    task: 'first-call'
                }, {
                    awaitCompletion: false,
                    setStage: 'awaiting_first_child'
                });
                
                console.log('[Bug #2] First A2A call SUCCESS:', handle);
                await ctx.reply('✅ First A2A call succeeded\n');
                
                V.setFirstA2ASuccess(ctx, true);
                
                return {
                    action: { kind: 'subagent', token: (handle as any).token },
                    result: {
                        status: 'ok',
                        ts: Date.now()
                    }
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await ctx.reply(`⚠️ First A2A call failed (agent not found?): ${message}\n`);
                
                V.setStage(ctx, 'completed');
                
                return {
                    action: { kind: 'internal', done: false },
                    result: {
                        status: 'error',
                        ts: Date.now(),
                        error: { code: 'agent_not_found', message }
                    }
                };
            }
        }

        if (intent === 'test_second_a2a') {
            await ctx.reply('🧪 Testing Bug #2: Second A2A call\n');
            
            const firstSuccess = V.firstA2ASuccess(ctx);
            if (!firstSuccess) {
                await ctx.reply('⏭️ Skipping second A2A test (first call failed)\n');
                V.setStage(ctx, 'completed');
                return {
                    action: { kind: 'internal', done: true },
                    result: { status: 'ok', ts: Date.now() }
                };
            }
            
            try {
                const handle = await ctx.sendTaskToAgent('helper-agent', {
                    task: 'second-call'
                }, {
                    awaitCompletion: false,
                    setStage: 'awaiting_second_child'
                });
                
                console.log('[Bug #2] Second A2A call SUCCESS:', handle);
                await ctx.reply('✅ Bug #2 Test: PASS - Second A2A call succeeded!\n');
                
                V.setStage(ctx, 'completed');
                
                return {
                    action: { kind: 'subagent', token: (handle as any).token },
                    result: {
                        status: 'ok',
                        ts: Date.now(),
                        data: {
                            testResult: {
                                bug: 'a2a',
                                status: 'pass',
                                details: 'Second A2A call succeeded'
                            }
                        }
                    }
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error('[Bug #2] Second A2A call FAILED:', message);
                
                await ctx.reply(`❌ Bug #2 Test: FAIL - Second A2A call failed!

Error: ${message}

🐛 BUG REPRODUCED: Framework only supports single A2A call per task.
Expected: Multiple sequential A2A calls should work within turn budget.
Actual: Second call throws "Session manager not configured" error.
\n`);
                
                V.setStage(ctx, 'completed');
                
                return {
                    action: { kind: 'internal', done: false },
                    result: {
                        status: 'error',
                        ts: Date.now(),
                        data: {
                            testResult: {
                                bug: 'a2a',
                                status: 'fail',
                                details: message
                            }
                        }
                    }
                };
            }
        }

        if (intent === 'report_results') {
            const varsResult = m.memory.sensory?.varsTestResult;
            const a2aResult = m.memory.sensory?.a2aTestResult;
            
            await ctx.reply('\n📊 Bug Reproduction Test Results:\n');
            
            if (varsResult) {
                await ctx.reply(`Bug #1 (Vars Persistence): ${varsResult === 'pass' ? '✅ PASS' : '❌ FAIL'}\n`);
            }
            
            if (a2aResult) {
                await ctx.reply(`Bug #2 (Multiple A2A): ${a2aResult === 'pass' ? '✅ PASS' : '❌ FAIL'}\n`);
            }
            
            V.setStage(ctx, 'completed');
            ctx.complete(100, 'completed');
            
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'ok',
                    ts: Date.now(),
                    data: { varsResult, a2aResult }
                }
            };
        }

        // Wait
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', ts: Date.now() }
        };
    },

    // === T - Transition ===
    transition: (
        env: EnvironmentState<InboxPayload>,
        exec: { action: ExecutableAction; result: ExecResult<unknown> },
        m: MentalState<Sensory>
    ): TransitionOut<InboxPayload> => {
        const stage = (m.memory.vars?.stage as Stage) ?? 'idle';
        
        console.log('[Transition] Stage:', stage, 'Action:', exec.action.kind);
        
        if (exec.action.kind === 'subagent' && exec.action.token) {
            return { kind: 'await_child', token: exec.action.token };
        }
        
        if (stage === 'completed' || (exec.action as any).done) {
            return { 
                kind: 'complete', 
                result: exec.result.data ?? { ok: true } 
            };
        }
        
        // Package exec result as observation for next turn
        const observations = exec.result.status !== 'ok' || exec.result.data ? [{
            source: 'internal' as const,
            kind: `internal.${exec.result.status}` as const,
            payload: exec.result.data ?? {},
            provenance: {
                ts: exec.result.ts ?? Date.now(),
                turn: env.turn
            }
        }] : [];
        
        return { 
            kind: 'continue', 
            observations 
        };
    }
}, import.meta.url);


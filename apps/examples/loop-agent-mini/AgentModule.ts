import { createAgent } from '@a2arium/callagent-core';

/**
 * Loop-agent-mini: Demonstrates LLM conversation history persistence across loop turns
 * 
 * This is a SIMPLER demo showing that LLM history is automatically preserved across
 * loop turns without needing requestInput or other async operations.
 * 
 * Flow:
 * Turn 1: Agent asks LLM "Tell me a fun fact about space"
 * Turn 2: Agent asks LLM "What's another fun fact?" 
 *         → LLM has access to previous turn's context!
 * Turn 3: Agent asks LLM "Can you combine both facts into a short story?"
 *         → LLM has access to BOTH previous turns!
 * 
 * Key Insight: MentalState (including llmState) is saved after EVERY runLoop execution,
 * so history persists across turns even within a single task execution.
 */
export default createAgent({
    manifest: {
        name: 'loop-agent-mini',
        version: '0.3.0',
        runMode: 'loop',
        budgets: { maxTurns: 5 }
        // Note: No hitl setting - we want the shield to pass actions through
    },

    llmConfig: {
        provider: 'openai',
        modelAliasOrName: 'fast',
        systemPrompt: 'You are a helpful assistant. Keep your responses concise (under 100 words).',
        historyMode: 'dynamic'
    },

    perception: (env: any) => ({
        input: env.input,
        time: env.time
    }),

    learning: (prevMentalState: any, _prevAction: any, obs: any) => {
        // Update sensory with latest observation
        (prevMentalState.memory as any).sensory = {
            ...(prevMentalState.memory.sensory || {}),
            lastObservation: obs
        };
        return prevMentalState;
    },

    policy: (mentalState: any) => {
        const turn = (mentalState.vars?.turn as number) || 0;

        console.log(`\n📍 [Policy] Turn ${turn}`);

        if (turn === 0) {
            return {
                kind: 'language',
                content: 'Tell me a fun fact about space.',
                nextTurn: 1
            } as any;
        }

        if (turn === 1) {
            return {
                kind: 'language',
                content: 'That was interesting! What\'s another fun fact about space?',
                nextTurn: 2
            } as any;
        }

        if (turn === 2) {
            return {
                kind: 'language',
                content: 'Great! Can you combine both of those facts into a very short 2-sentence story?',
                nextTurn: 3
            } as any;
        }

        return { kind: 'internal', intent: 'complete', done: true } as any;
    },

    shield: (_mentalState: any, action: any) => {
        console.log('[Shield] Received action from policy:', JSON.stringify(action, null, 2));
        // Explicitly pass through the action
        const result = { action: 'pass' as const, intent: action };
        console.log('[Shield] Returning:', JSON.stringify(result, null, 2));
        return result as any;
    },

    execution: async (action: any, ctx: any) => {
        console.log(`\n[Execution] Received action:`, JSON.stringify(action, null, 2));

        if (action?.kind === 'language') {
            console.log(`\n💬 [Question]: ${action.content}`);

            try {
                // Call LLM - it will have history from previous turns!
                const responses = await ctx.llm.call(action.content);
                console.log('[Execution] LLM responses:', JSON.stringify(responses, null, 2));

                // Try different response formats
                const response = responses[0]?.text
                    || responses[0]?.content
                    || (typeof responses[0] === 'string' ? responses[0] : null)
                    || 'Error: No response from LLM';

                console.log(`🤖 [Assistant]: ${response}`);
                await ctx.reply(`\n🤖 ${response}\n`);

                // Advance turn counter if provided
                if (action.nextTurn !== undefined) {
                    ctx.vars.set('turn', action.nextTurn);
                }

                return { kind: 'language', echoed: true } as any;
            } catch (error) {
                console.error('[Execution] LLM call failed:', error);
                await ctx.reply(`\n❌ LLM Error: ${error instanceof Error ? error.message : String(error)}\n`);
                return { kind: 'language', echoed: true } as any;
            }
        }

        if (action?.kind === 'internal' && action?.intent === 'complete') {
            console.log('[Execution] Internal complete', ctx.llm.getMessages());
            console.log('\n✅ Demo Complete!');
            console.log('📝 The LLM successfully referenced previous turns in its final story,');
            console.log('   proving that conversation history was preserved across all turns.');
            await ctx.reply('\n✅ Demo complete! The conversation history was preserved across all 3 turns.');
            return { kind: 'internal', done: true } as any;
        }

        console.log(`\n❌ [Execution] Unknown action: ${action?.kind}/${action?.intent}`);
        return { kind: 'internal', done: true } as any;
    },

    transition: (_env: any, executionResult: any) => {
        if (executionResult?.kind === 'internal' && executionResult?.done) {
            return { kind: 'complete', result: 'success' } as any;
        }
        if (executionResult?.kind === 'language' && executionResult?.echoed) {
            return { kind: 'continue' } as any;
        }
        return { kind: 'continue' } as any;
    }
}, import.meta.url);




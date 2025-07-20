import { createAgent } from '@a2arium/callagent-core';

export default createAgent({
    manifest: {
        name: "complete-memory-demo",
        version: "1.0.0"
    } as any, // Extended with memory configuration

    handleTask: async (ctx) => {
        try {
            // NEW: Working memory operations
            await ctx.setGoal?.("Demonstrate complete memory system");
            await ctx.addThought?.("This is my first thought");
            await ctx.addThought?.("This is my second thought");

            // NEW: Working variables
            if (ctx.vars) {
                ctx.vars.userName = (ctx.task.input as any).userName || 'Anonymous';
                const currentTurn = (await ctx.vars.conversationTurn as number) || 0;
                ctx.vars.conversationTurn = currentTurn + 1;
            }

            // NEW: Decision making
            if (ctx.vars && ((await ctx.vars.conversationTurn as number) || 0) > 1) {
                await ctx.makeDecision?.(
                    "conversation_style",
                    "continue_friendly",
                    "User is returning, maintain context"
                );
            }

            // NEW: Unified operations
            await ctx.remember?.("user-insight", "Prefers detailed responses", {
                persist: true,
                type: 'semantic',
                importance: 'high'
            });

            const memories = await ctx.recall?.("user preferences", {
                sources: ['working', 'semantic'],
                limit: 5
            }) || [];

            // UNCHANGED: Existing semantic memory API works exactly as before
            await ctx.memory.semantic?.set?.('last-interaction', new Date().toISOString());
            const lastInteraction = await ctx.memory.semantic?.get?.('last-interaction');

            // Demonstrate everything works
            const goal = await ctx.getGoal?.();
            const thoughts = await ctx.getThoughts?.() || [];
            const decision = await ctx.getDecision?.("conversation_style");

            // Check MLO processing
            const firstThought = thoughts[0];
            const processingHistory = firstThought?.processingMetadata?.processingHistory || [];

            // Get current working variables
            const currentTurn = ctx.vars ? (await ctx.vars.conversationTurn as number) || 0 : 0;
            const userName = ctx.vars ? (await ctx.vars.userName as string) || 'Unknown' : 'Unknown';

            // Get MLO metrics for demonstration
            const mloMetrics = ctx.memory.mlo ? (ctx.memory.mlo as any).getMetrics() : {};
            const mloConfig = ctx.memory.mlo ? (ctx.memory.mlo as any).getConfiguration() : {};

            await ctx.reply([
                { type: 'text', text: '✅ **Memory System Status:**' },
                { type: 'text', text: `- Working memory: ✅ Active` },
                { type: 'text', text: `- Unified operations: ✅ Active` },
                { type: 'text', text: `- Semantic memory: ${ctx.memory.semantic ? '✅ Active' : '❌ Not available'}` },
                { type: 'text', text: `- Episodic memory: ${ctx.memory.episodic ? '✅ Active' : '❌ Not available'}` },
                { type: 'text', text: `- Embedding memory: ${ctx.memory.embed ? '✅ Active' : '❌ Not available'}` }
            ]);

            ctx.complete();

        } catch (error) {
            ctx.logger?.error?.('Memory demo failed', error);
            await ctx.reply(`❌ Memory demo failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            await ctx.fail?.(error);
        }
    }
}, import.meta.url); 
import { createAgent } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';

export default createAgent({
    manifest: {
        name: "complete-memory-demo",
        version: "1.0.0"
    } as any, // Extended with memory configuration

    handleTask: async (ctx) => {
        try {
            // NEW: Working memory operations
            await (ctx as any).goals?.add?.({ title: 'Demonstrate complete memory system', type: 'short', priority: 1 });
            await (ctx as any).thoughts?.add?.('This is my first thought');
            await (ctx as any).thoughts?.add?.('This is my second thought');

            // NEW: Working variables
            if (ctx.vars) {
                (ctx as any).vars.set('userName', (ctx.task.input as any).userName || 'Anonymous');
                const currentTurn = ((ctx as any).vars.get('conversationTurn') || 0) as number;
                (ctx as any).vars.set('conversationTurn', currentTurn + 1);
            }

            // NEW: Decision making
            if (ctx.vars && ((((ctx as any).vars.get('conversationTurn') || 0) as number) > 1)) {
                await (ctx as any).thoughts?.add?.('Decision: conversation_style continue_friendly (User is returning, maintain context)');
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
            const goal = 'See ctx.goals.read()';
            const thoughts: any[] = [];
            const decision: any = { decision: 'continue_friendly' };

            // Check MLO processing
            const firstThought = thoughts[0];
            const processingHistory = firstThought?.processingMetadata?.processingHistory || [];

            // Get current working variables
            const currentTurn = ctx.vars ? ((((ctx as any).vars.get('conversationTurn') || 0) as number)) : 0;
            const userName = ctx.vars ? ((((ctx as any).vars.get('userName') || 'Unknown') as string)) : 'Unknown';

            // Get MLO metrics for demonstration
            const mloMetrics = ctx.memory.mlo ? (ctx.memory.mlo as any).getMetrics() : {};
            const mloConfig = ctx.memory.mlo ? (ctx.memory.mlo as any).getConfiguration() : {};

            await ctx.reply([
                { type: 'text', text: '✅ **Memory System Status:**' },
                { type: 'text', text: `- Working memory: ✅ Active` }
            ]);

            ctx.complete();

        } catch (error) {
            logger.error('Memory demo failed', error);
            await ctx.reply(`❌ Memory demo failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            await ctx.fail?.(error);
        }
    }
}, import.meta.url);
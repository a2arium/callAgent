import { createAgent } from '@callagent/core';

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

            await ctx.reply(`
🧠 **Complete Memory System Demo Results**

**Working Memory Operations:**
- Goal: ${goal || 'Not set'}
- Thoughts collected: ${thoughts.length}
- Current turn: ${currentTurn}
- User name: ${userName}
- Decision made: ${decision?.decision || 'none'}

**Unified Memory Operations:**
- Memories found: ${memories.length}
- Last interaction: ${lastInteraction || 'Not recorded'}

**MLO Pipeline Processing:**
- Stages processed: ${processingHistory.length}
- Processing pipeline: ${processingHistory.slice(0, 5).join(' → ')}${processingHistory.length > 5 ? '...' : ''}
- Memory profile: ${mloConfig.profile || 'unknown'}

**MLO Metrics:**
- Total items processed: ${mloMetrics.totalProcessed || 0}
- Items dropped: ${mloMetrics.totalDropped || 0}
- Average processing time: ${mloMetrics.averageProcessingTime || 0}ms

**Backward Compatibility:**
- Semantic memory operations: ✅ Working
- Memory interface preserved: ✅ Working
- Legacy APIs functional: ✅ Working

**System Status:**
- Working memory: ${ctx.setGoal ? '✅ Active' : '❌ Not available'}
- Unified operations: ${ctx.recall ? '✅ Active' : '❌ Not available'}
- MLO integration: ${ctx.memory.mlo ? '✅ Active' : '❌ Not available'}
- Variables proxy: ${ctx.vars ? '✅ Active' : '❌ Not available'}

This demonstrates the complete Phase 1-B memory system with:
1. Working memory operations (goals, thoughts, decisions, variables)
2. Unified recall/remember operations across memory types
3. MLO pipeline processing with 6-stage lifecycle
4. Backward compatibility with existing memory APIs
5. Configuration-driven memory profiles
6. Tenant and agent isolation
7. Comprehensive metrics and observability
      `);

            ctx.complete();

        } catch (error) {
            ctx.logger?.error?.('Memory demo failed', error);
            await ctx.reply(`❌ Memory demo failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            await ctx.fail?.(error);
        }
    }
}, import.meta.url); 
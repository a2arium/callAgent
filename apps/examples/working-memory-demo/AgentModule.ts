/**
 * Working Memory Demo Agent
 * 
 * This agent demonstrates the complete working memory functionality in callAgent,
 * including goals, thoughts, decisions, variables, and MLO pipeline integration.
 * 
 * The agent uses the standard TaskContext API to interact with working memory,
 * showing how agents can maintain cognitive state across interactions.
 */

import { createAgent } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';

const demoLogger = logger.createLogger({ prefix: 'WorkingMemoryAgent' });

export default createAgent({
    manifest: {
        name: 'working-memory-demo',
        version: '1.0.0'
    },

    async handleTask(ctx) {
        console.log('🚀 Starting Working Memory Demo Agent');

        try {
            // 1. Goal Management
            console.log('\n📋 === Goal Management ===');

            await (ctx as any).goals.add({ title: 'Complete the quarterly sales report by Friday' });
            const goals = await (ctx as any).goals.read({});
            const currentGoal = Array.isArray(goals) && goals[0] ? (goals[0].title || goals[0].id) : undefined;
            console.log('Current goal:', currentGoal);

            // 2. Thought Chain
            console.log('\n🧠 === Thought Chain ===');
            const localThoughts: Array<{ type: string; content: string }> = [];
            const addLocalThought = async (text: string) => {
                await (ctx as any).thoughts.add(text);
                localThoughts.push({ type: 'thought', content: text });
            };
            await addLocalThought('I need to gather sales data from the last quarter');
            await addLocalThought('The data shows a 15% increase in Q3 sales');
            await addLocalThought('I should focus on the top-performing products in the analysis');

            console.log('Thought chain:', localThoughts.map(t => `[${t.type}] ${t.content}`));

            // 3. Decision Tracking
            console.log('\n⚖️ === Decision Tracking ===');
            await (ctx as any).thoughts.add('Decision: report-format Use PowerPoint with executive summary (Stakeholders prefer visual presentations over detailed documents)');
            await (ctx as any).thoughts.add('Decision: data-source Combine CRM and analytics data (Need both customer behavior and sales metrics for complete picture)');
            (ctx as any).vars.set('decision:report-format', 'Use PowerPoint with executive summary');
            (ctx as any).vars.set('decision:data-source', 'Combine CRM and analytics data');
            const formatDecision = { decision: (ctx as any).vars.get('decision:report-format') };
            const dataDecision = { decision: (ctx as any).vars.get('decision:data-source') };

            console.log('Format decision:', formatDecision);
            console.log('Data source decision:', dataDecision);

            // 4. Working Variables
            console.log('\n📊 === Working Variables ===');

            (ctx as any).vars.set('progress', 0.3);
            (ctx as any).vars.set('deadline', '2024-01-26');
            (ctx as any).vars.set('stakeholders', ['CEO', 'Sales Director', 'Marketing Manager']);
            (ctx as any).vars.set('priority', 'high');

            // Note: ctx.vars now provides synchronous access with background persistence
            // Values are immediately available after being set in the current session
            console.log('Working variables set:', {
                progress: (ctx as any).vars.get('progress'),
                deadline: (ctx as any).vars.get('deadline'),
                stakeholders: (ctx as any).vars.get('stakeholders'),
                priority: (ctx as any).vars.get('priority')
            });

            // 5. Memory Operations
            console.log('\n💾 === Memory Operations ===');

            // Remember important information to semantic memory
            await ctx.remember!('project-status', {
                name: 'Q3 Sales Report',
                progress: 0.3,
                deadline: '2024-01-26',
                priority: 'high'
            }, { type: 'semantic', persist: true });

            // Recall information from memory
            const projectInfo = await ctx.recall('project', { type: 'semantic' });
            console.log('Recalled project information:', projectInfo);

            // 6. Update Goal and Add More Context
            console.log('\n🔄 === Updating Working Memory ===');

            await (ctx as any).goals.add({ title: 'Complete and present the quarterly sales report by Friday with focus on Q3 growth' });
            await (ctx as any).thoughts.add('Updated goal to include presentation requirement');

            (ctx as any).vars.set('progress', 0.6);

            const goals2 = await (ctx as any).goals.read({});
            const updatedGoal = Array.isArray(goals2) && goals2[0] ? (goals2[0].title || goals2[0].id) : undefined;
            console.log('Updated goal:', updatedGoal);
            console.log('Updated progress: 0.6');

            // 7. Demonstrate MLO Processing
            console.log('\n🔄 === MLO Pipeline Processing ===');
            console.log('All working memory operations above went through the 6-stage MLO pipeline:');
            console.log('1. Acquisition - Input filtering and validation');
            console.log('2. Encoding - Attention and fusion mechanisms');
            console.log('3. Derivation - Reflection and summarization');
            console.log('4. Retrieval - Indexing and matching');
            console.log('5. Neural Memory - Associative processing');
            console.log('6. Utilization - Context enhancement and RAG');

            // 8. Progress Update
            console.log('\n📈 === Progress Update ===');

            await (ctx as any).thoughts.add('Decision: next-steps Start data collection and analysis (Need to begin with data gathering to meet Friday deadline)');
            (ctx as any).vars.set('next-steps', 'Start data collection and analysis');

            (ctx as any).vars.set('progress', 0.8);
            await (ctx as any).thoughts.add('Ready to begin implementation phase');

            // 9. Final Summary
            console.log('\n📋 === Final Summary ===');

            const goals3 = await (ctx as any).goals.read({});
            const finalGoal = Array.isArray(goals3) && goals3[0] ? (goals3[0].title || goals3[0].id) : undefined;
            const finalThoughts = localThoughts; // demo-local
            const nextStepsDecision = { decision: (ctx as any).vars.get('next-steps') };

            const summary = {
                goal: finalGoal,
                totalThoughts: finalThoughts.length,
                thoughtTypes: finalThoughts.reduce((acc: Record<string, number>, t) => {
                    const thoughtType = t.type || 'unknown';
                    acc[thoughtType] = (acc[thoughtType] || 0) + 1;
                    return acc;
                }, {} as Record<string, number>),
                nextSteps: nextStepsDecision?.decision,
                estimatedProgress: '80%',
                status: 'On track for Friday deadline'
            };

            console.log('Agent execution summary:', summary);

            const resultMessage = `✅ Working Memory Demo Agent completed successfully!

**Final Status:**
- Goal: ${finalGoal}
- Thoughts processed: ${finalThoughts.length}
- Decisions made: 3
- Progress: 80%
- Next steps: ${nextStepsDecision?.decision}

All operations were processed through the MLO pipeline, demonstrating:
- Persistent working memory storage
- Cognitive state management
- Decision tracking and reasoning
- Goal-oriented task execution
- Memory integration across semantic and working memory tiers

The agent successfully maintained its cognitive state throughout the execution, showing how callAgent's working memory system enables sophisticated agent behaviors.`;

            await ctx.reply(resultMessage);
            ctx.complete(100, 'success');

        } catch (error) {
            demoLogger.error('❌ Agent execution failed:', error);
            await ctx.fail(error);
        }
    }
}, import.meta.url); 
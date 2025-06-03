import { createAgent } from '@callagent/core';

/**
 * Debug Coordinator Agent - Test version with detailed logging
 */
export default createAgent({
    manifest: {
        name: 'debug-coordinator-agent',
        version: '1.0.0',
        description: 'Debug version of coordinator agent to test ctx.remember',
        memory: {
            profile: 'conversational'
        }
    },

    async handleTask(ctx) {
        await ctx.reply('🎯 Debug Coordinator Agent Starting\n');

        try {
            console.log('✅ Step 1: Setting goal...');
            await ctx.setGoal('Complete quarterly business analysis with detailed reporting');
            console.log('✅ Step 2: Adding thoughts...');
            await ctx.addThought('Starting comprehensive business analysis workflow');
            await ctx.addThought('Will delegate data analysis to specialist agent');

            console.log('✅ Step 3: Setting working variables...');
            ctx.vars.workflowId = `workflow_${Date.now()}`;
            ctx.vars.priority = 'high';
            ctx.vars.requestedBy = (ctx.task.input as any).requestedBy || 'management';

            console.log('🔍 Step 4: About to call ctx.remember...');
            console.log('Remember payload:', {
                key: 'workflow-context',
                value: {
                    type: 'quarterly-analysis',
                    quarter: 'Q4 2024',
                    deadline: '2024-01-31',
                    stakeholders: ['CEO', 'CFO', 'Board']
                },
                options: { type: 'semantic', persist: true }
            });

            await ctx.remember('workflow-context', {
                type: 'quarterly-analysis',
                quarter: 'Q4 2024',
                deadline: '2024-01-31',
                stakeholders: ['CEO', 'CFO', 'Board']
            }, { type: 'semantic', persist: true });

            console.log('✅ Step 5: ctx.remember completed successfully!');
            await ctx.reply('📊 Step 1: ctx.remember worked!');

            ctx.complete(100, 'Debug test completed successfully');
            return { status: 'success', message: 'ctx.remember works' };

        } catch (error) {
            console.error('❌ Error in debug coordinator:', error);
            await ctx.addThought(`Debug workflow failed with error: ${error}`);
            await ctx.fail(error);
        }
    }
}, import.meta.url); 
import { createAgent } from '@callagent/core';

/**
 * Coordinator Agent - Orchestrates the workflow
 * Demonstrates working memory inheritance and agent delegation
 */
export default createAgent({
    manifest: {
        name: 'coordinator-agent',
        version: '1.0.0',
        description: 'Orchestrates multi-agent workflows with context sharing',
        memory: {
            profile: 'conversational'
        }
    },

    async handleTask(ctx) {
        await ctx.reply('🎯 Coordinator Agent Starting Multi-Agent Workflow\n');

        try {
            // Set up the main goal and context
            await ctx.setGoal('Complete quarterly business analysis with detailed reporting');
            await ctx.addThought('Starting comprehensive business analysis workflow');
            await ctx.addThought('Will delegate data analysis to specialist agent');

            // Store workflow metadata in working variables
            ctx.vars.workflowId = `workflow_${Date.now()}`;
            ctx.vars.priority = 'high';
            ctx.vars.requestedBy = (ctx.task.input as any).requestedBy || 'management';

            // Remember important context for the workflow in working memory
            ctx.vars.workflowContext = {
                type: 'quarterly-analysis',
                quarter: 'Q4 2024',
                deadline: '2024-01-31',
                stakeholders: ['CEO', 'CFO', 'Board']
            };

            await ctx.reply('📊 Step 1: Delegating data analysis...');

            // Call Data Analysis Agent with full context inheritance
            const analysisResult = await ctx.sendTaskToAgent('data-analysis-agent', {
                dataSource: 'quarterly-reports',
                metrics: ['revenue', 'costs', 'profit', 'growth'],
                timeframe: 'Q4-2024'
            }, {
                inheritWorkingMemory: true,    // Share goals, thoughts, decisions
                inheritMemory: true,           // Share semantic/episodic memory
                timeout: 30000                 // 30 second timeout
            });

            await ctx.addThought('Data analysis completed successfully');
            await ctx.makeDecision(
                'analysis-quality',
                'approved',
                'Data analysis meets quality standards for reporting'
            );

            // Store analysis results in working memory
            ctx.vars.analysisComplete = true;
            ctx.vars.analysisResults = analysisResult;

            await ctx.reply('📝 Step 2: Delegating report generation...');

            // Call Reporting Agent with analysis results
            const reportResult = await ctx.sendTaskToAgent('reporting-agent', {
                analysisData: analysisResult,
                reportType: 'executive-summary',
                audience: 'senior-leadership'
            }, {
                inheritWorkingMemory: true,    // Inherit the full workflow context
                inheritMemory: true,           // Include all gathered data
                timeout: 45000                 // Longer timeout for report generation
            });

            await ctx.addThought('Report generation completed successfully');
            await ctx.makeDecision(
                'workflow-completion',
                'success',
                'All workflow steps completed successfully with quality outputs'
            );

            // Final workflow summary
            const finalGoal = await ctx.getGoal();
            const allThoughts = await ctx.getThoughts();
            const workflowDecision = await ctx.getDecision('workflow-completion');

            const summary = {
                workflowId: ctx.vars.workflowId,
                goal: finalGoal,
                thoughtCount: allThoughts.length,
                analysisResult,
                reportResult,
                finalDecision: workflowDecision?.decision,
                priority: ctx.vars.priority,
                completedAt: new Date().toISOString()
            };

            await ctx.reply([
                { type: 'text', text: '✅ **Multi-Agent Workflow Completed Successfully!**\n' },
                { type: 'text', text: `**Workflow Summary:**` },
                { type: 'text', text: `- Workflow ID: ${summary.workflowId}` },
                { type: 'text', text: `- Goal: ${summary.goal}` },
                { type: 'text', text: `- Thoughts Processed: ${summary.thoughtCount}` },
                { type: 'text', text: `- Priority: ${summary.priority}` },
                { type: 'text', text: `- Status: ${summary.finalDecision}` },
                { type: 'text', text: '\n**Demonstrates:**' },
                { type: 'text', text: '- Multi-agent coordination' },
                { type: 'text', text: '- Working memory context transfer' },
                { type: 'text', text: '- Semantic memory sharing' },
                { type: 'text', text: '- Goal and decision tracking across agents' },
                { type: 'text', text: '- MLO pipeline integration' }
            ]);

            ctx.complete(100, 'Multi-agent workflow completed successfully');
            return summary;

        } catch (error) {
            console.error('❌ Full A2A error details:', error);
            console.error('Error message:', error instanceof Error ? error.message : String(error));
            console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');

            await ctx.addThought(`Workflow failed with error: ${error}`);
            await ctx.fail(error);
        }
    }
}, import.meta.url); 
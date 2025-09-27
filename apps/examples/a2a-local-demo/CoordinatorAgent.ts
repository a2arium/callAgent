import { createAgent } from '@a2arium/callagent-core';
type ChildTaskHandle = { run: (opts?: { awaitCompletion?: boolean; streaming?: boolean }) => Promise<unknown> };

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
            await (ctx as any).goals.add({ title: 'Complete quarterly business analysis with detailed reporting', type: 'short', priority: 1 });
            await (ctx as any).thoughts.add('Starting comprehensive business analysis workflow');
            await (ctx as any).thoughts.add('Will delegate data analysis to specialist agent');

            // Store workflow metadata in working variables
            (ctx as any).vars.set('workflowId', `workflow_${Date.now()}`);
            (ctx as any).vars.set('priority', 'high');
            (ctx as any).vars.set('requestedBy', (ctx.task.input as any).requestedBy || 'management');

            // Remember important context for the workflow in working memory
            (ctx as any).vars.set('workflowContext', {
                type: 'quarterly-analysis',
                quarter: 'Q4 2024',
                deadline: '2024-01-31',
                stakeholders: ['CEO', 'CFO', 'Board']
            });

            await ctx.reply('📊 Step 1: Delegating data analysis...');

            // Call Data Analysis Agent with full context inheritance
            const analysisTask = await ctx.sendTaskToAgent('data-analysis-agent', {
                dataSource: 'quarterly-reports',
                metrics: ['revenue', 'costs', 'profit', 'growth'],
                timeframe: 'Q4-2024'
            }, {
                inheritWorkingMemory: true,
                inheritMemory: true,
                timeout: 30000
            }) as unknown as ChildTaskHandle;
            const analysisResult = await (analysisTask as any)?.run?.() ?? analysisTask;

            await (ctx as any).thoughts.add('Data analysis completed successfully');
            await (ctx as any).thoughts.add('Decision: analysis-quality approved');

            // Store analysis results in working memory
            (ctx as any).vars.set('analysisComplete', true);
            (ctx as any).vars.set('analysisResults', analysisResult);

            await ctx.reply('📝 Step 2: Delegating report generation...');

            // Call Reporting Agent with analysis results
            const reportTask = await ctx.sendTaskToAgent('reporting-agent', {
                analysisData: analysisResult,
                reportType: 'executive-summary',
                audience: 'senior-leadership'
            }, {
                inheritWorkingMemory: true,
                inheritMemory: true,
                timeout: 45000
            }) as unknown as ChildTaskHandle;
            const reportResult = await (reportTask as any)?.run?.() ?? reportTask;

            await (ctx as any).thoughts.add('Report generation completed successfully');
            await (ctx as any).thoughts.add('Decision: workflow-completion success');

            // Final workflow summary
            const finalGoals = await (ctx as any).goals.read?.({});
            const finalGoal = Array.isArray(finalGoals) && finalGoals[0] ? finalGoals[0].title || finalGoals[0].id : undefined;
            const allThoughts: any[] = [];
            const workflowDecision: any = { decision: 'success' };

            const summary = {
                workflowId: (ctx as any).vars.get('workflowId'),
                goal: finalGoal,
                thoughtCount: allThoughts.length,
                analysisResult,
                reportResult,
                finalDecision: workflowDecision?.decision,
                priority: (ctx as any).vars.get('priority'),
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

            await (ctx as any).thoughts.add(`Workflow failed with error: ${error}`);
            await ctx.fail(error);
        }
    }
}, import.meta.url); 
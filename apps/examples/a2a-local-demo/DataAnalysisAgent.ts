import { createAgent } from '@a2arium/callagent-core';

/**
 * Data Analysis Agent - Specialized data processing
 * Demonstrates context inheritance and statistical analysis
 */
export default createAgent({
    manifest: {
        name: 'data-analysis-agent',
        version: '1.0.0',
        description: 'Specialized agent for data analysis with context inheritance',
        memory: {
            profile: 'conversational'
        }
    },

    async handleTask(ctx) {
        await ctx.reply('📊 Data Analysis Agent Starting Analysis\n');

        try {
            // Inherit context from the calling agent
            const inheritedGoals = await (ctx as any).goals.read?.({});
            const inheritedGoal = Array.isArray(inheritedGoals) && inheritedGoals[0] ? (inheritedGoals[0].title || inheritedGoals[0].id) : undefined;
            const inheritedThoughts: any[] = [];
            const workflowId = (ctx as any).vars.get('workflowId');
            const priority = (ctx as any).vars.get('priority');

            await ctx.reply([
                { type: 'text', text: '🔄 **Context Inheritance Successful**' },
                { type: 'text', text: `- Inherited Goal: ${inheritedGoal}` },
                { type: 'text', text: `- Previous Thoughts: ${inheritedThoughts.length}` },
                { type: 'text', text: `- Workflow ID: ${workflowId}` },
                { type: 'text', text: `- Priority: ${priority}` }
            ]);

            // Set specialized goal for this agent
            await (ctx as any).goals.add({ title: `${inheritedGoal} - Data Analysis Phase`, type: 'short', priority: 1 });
            await (ctx as any).thoughts.add('Starting specialized data analysis');
            await (ctx as any).thoughts.add('Processing quarterly metrics and trends');

            // Extract task parameters
            const { dataSource, metrics, timeframe } = ctx.task.input as any;

            await (ctx as any).thoughts.add(`Analyzing ${dataSource} for ${timeframe}`);

            // Set analysis tracking variables
            (ctx as any).vars.set('analysisStartTime', Date.now());
            (ctx as any).vars.set('currentMetric', 'revenue');

            // Recall relevant historical context from working memory
            const workflowContext = (ctx as any).vars.get('workflowContext');
            const historicalRecords = workflowContext ? 1 : 0;

            await (ctx as any).thoughts.add(`Found ${historicalRecords} relevant historical records`);

            // Simulate data analysis for each metric
            const analysisResults = [];

            for (const metric of metrics) {
                (ctx as any).vars.set('currentMetric', metric);
                await (ctx as any).thoughts.add(`Processing ${metric} analysis`);

                // Simulate analysis computation
                const result = {
                    metric,
                    value: Math.round(Math.random() * 1000000),
                    trend: Math.random() > 0.5 ? 'increasing' : 'decreasing',
                    confidence: Math.round(Math.random() * 100),
                    period: timeframe,
                    timestamp: new Date().toISOString()
                };

                analysisResults.push(result);
                await (ctx as any).thoughts.add(`${metric} analysis complete - ${result.trend} trend detected`);

                // Simulate processing time
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Make quality decision
            await (ctx as any).thoughts.add('Decision: data-quality high-confidence');

            // Store current analysis in working memory
            (ctx as any).vars.set('currentAnalysis', analysisResults);

            (ctx as any).vars.set('analysisEndTime', Date.now());
            const analysisTime = (((ctx as any).vars.get('analysisEndTime') as number)) - (((ctx as any).vars.get('analysisStartTime') as number));

            // Get final state for summary
            const finalThoughts: any[] = [];
            const qualityDecision: any = { decision: 'high-confidence' };

            const summary = {
                analysisResults,
                metrics: metrics.length,
                processingTime: analysisTime,
                thoughtCount: finalThoughts.length,
                qualityAssessment: qualityDecision?.decision,
                workflowId,
                completedAt: new Date().toISOString()
            };

            await ctx.reply([
                { type: 'text', text: '✅ **Data Analysis Completed Successfully!**\n' },
                { type: 'text', text: `**Analysis Summary:**` },
                { type: 'text', text: `- Metrics Analyzed: ${summary.metrics}` },
                { type: 'text', text: `- Processing Time: ${summary.processingTime}ms` },
                { type: 'text', text: `- Thoughts Generated: ${summary.thoughtCount}` },
                { type: 'text', text: `- Quality: ${summary.qualityAssessment}` },
                { type: 'text', text: `- Workflow: ${summary.workflowId}` }
            ]);

            ctx.complete(100, 'Data analysis completed successfully');
            return summary;

        } catch (error) {
            await (ctx as any).thoughts.add(`Data analysis failed: ${error}`);
            await ctx.fail(error);
        }
    }
}, import.meta.url); 
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
            const inheritedGoal = await ctx.getGoal();
            const inheritedThoughts = await ctx.getThoughts();
            const workflowId = ctx.vars.workflowId;
            const priority = ctx.vars.priority;

            await ctx.reply([
                { type: 'text', text: '🔄 **Context Inheritance Successful**' },
                { type: 'text', text: `- Inherited Goal: ${inheritedGoal}` },
                { type: 'text', text: `- Previous Thoughts: ${inheritedThoughts.length}` },
                { type: 'text', text: `- Workflow ID: ${workflowId}` },
                { type: 'text', text: `- Priority: ${priority}` }
            ]);

            // Set specialized goal for this agent
            await ctx.setGoal(`${inheritedGoal} - Data Analysis Phase`);
            await ctx.addThought('Starting specialized data analysis');
            await ctx.addThought('Processing quarterly metrics and trends');

            // Extract task parameters
            const { dataSource, metrics, timeframe } = ctx.task.input as any;

            await ctx.addThought(`Analyzing ${dataSource} for ${timeframe}`);

            // Set analysis tracking variables
            ctx.vars.analysisStartTime = Date.now();
            ctx.vars.currentMetric = 'revenue';

            // Recall relevant historical context from working memory
            const workflowContext = ctx.vars.workflowContext;
            const historicalRecords = workflowContext ? 1 : 0;

            await ctx.addThought(`Found ${historicalRecords} relevant historical records`);

            // Simulate data analysis for each metric
            const analysisResults = [];

            for (const metric of metrics) {
                ctx.vars.currentMetric = metric;
                await ctx.addThought(`Processing ${metric} analysis`);

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
                await ctx.addThought(`${metric} analysis complete - ${result.trend} trend detected`);

                // Simulate processing time
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Make quality decision
            await ctx.makeDecision(
                'data-quality',
                'high-confidence',
                'All metrics analyzed with high confidence levels'
            );

            // Store current analysis in working memory
            ctx.vars.currentAnalysis = analysisResults;

            ctx.vars.analysisEndTime = Date.now();
            const analysisTime = (ctx.vars.analysisEndTime as number) - (ctx.vars.analysisStartTime as number);

            // Get final state for summary
            const finalThoughts = await ctx.getThoughts();
            const qualityDecision = await ctx.getDecision('data-quality');

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
            await ctx.addThought(`Data analysis failed: ${error}`);
            await ctx.fail(error);
        }
    }
}, import.meta.url); 
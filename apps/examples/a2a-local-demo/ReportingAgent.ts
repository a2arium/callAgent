import { createAgent } from '@callagent/core';

/**
 * Reporting Agent - Generates comprehensive reports
 * Demonstrates context inheritance and report generation
 */
export default createAgent({
    manifest: {
        name: 'reporting-agent',
        version: '1.0.0',
        description: 'Specialized agent for report generation with context inheritance',
        memory: {
            profile: 'conversational'
        }
    },

    async handleTask(ctx) {
        await ctx.reply('📝 Reporting Agent Starting Report Generation\n');

        try {
            // Inherit context from the calling agent
            const inheritedGoal = await ctx.getGoal();
            const inheritedThoughts = await ctx.getThoughts();
            const workflowId = ctx.vars.workflowId;
            const priority = ctx.vars.priority;

            await ctx.reply([
                { type: 'text', text: '🔄 **Context Inheritance Successful**' },
                { type: 'text', text: `- Inherited Goal: ${inheritedGoal}` },
                { type: 'text', text: `- Previous Thoughts: ${Array.isArray(inheritedThoughts) ? inheritedThoughts.length : 0}` },
                { type: 'text', text: `- Workflow ID: ${workflowId}` },
                { type: 'text', text: `- Priority: ${priority}` }
            ]);

            // Set specialized goal for this agent
            await ctx.setGoal(`${inheritedGoal} - Report Generation Phase`);
            await ctx.addThought('Starting comprehensive report generation');
            await ctx.addThought('Processing analysis data for executive summary');

            // Recall analysis data from working memory
            const analysisData = ctx.vars.analysisResults || ctx.vars.currentAnalysis;
            const workflowContext = ctx.vars.workflowContext;

            await ctx.addThought(`Found analysis data: ${analysisData ? 'yes' : 'no'}`);
            await ctx.addThought(`Found workflow context: ${workflowContext ? 'yes' : 'no'}`);

            // Recall additional historical reports from working memory  
            const existingReports = (ctx.vars.previousReports as any[]) || [];

            await ctx.addThought(`Found ${existingReports.length} previous reports for context`);

            // Extract report parameters
            const { reportType, audience } = ctx.task.input as any;

            await ctx.addThought(`Generating ${reportType} for ${audience}`);

            // Set reporting tracking variables
            ctx.vars.reportStartTime = Date.now();
            ctx.vars.currentSection = 'executive-summary';

            // Generate executive summary
            const executiveSummary = {
                title: 'Q4 2024 Business Analysis Report',
                generatedAt: new Date().toISOString(),
                audience: audience,
                keyFindings: [
                    'Revenue trends show mixed performance',
                    'Cost management requires attention',
                    'Growth opportunities identified'
                ],
                recommendations: [
                    'Implement cost reduction strategies',
                    'Focus on high-performing revenue streams',
                    'Accelerate growth initiatives'
                ]
            };

            await ctx.addThought('Executive summary completed');
            ctx.vars.currentSection = 'detailed-analysis';

            // Generate detailed analysis sections
            const detailedSections = [
                {
                    section: 'Financial Performance',
                    content: 'Analysis of revenue, costs, and profitability metrics',
                    charts: ['revenue-trend', 'cost-breakdown', 'profit-margins']
                },
                {
                    section: 'Growth Analysis',
                    content: 'Assessment of growth trends and market opportunities',
                    charts: ['growth-trajectory', 'market-share', 'competitive-position']
                },
                {
                    section: 'Risk Assessment',
                    content: 'Evaluation of financial and operational risks',
                    charts: ['risk-matrix', 'compliance-status', 'mitigation-strategies']
                }
            ];

            await ctx.addThought('Detailed analysis sections completed');
            ctx.vars.currentSection = 'appendix';

            // Make reporting decision
            await ctx.makeDecision(
                'report-quality',
                'publication-ready',
                'Report meets all quality standards for executive presentation'
            );

            // Store final report in working memory
            ctx.vars.finalReport = {
                executiveSummary,
                detailedSections,
                metadata: {
                    generatedBy: 'reporting-agent',
                    analysisSource: analysisData,
                    reportType,
                    audience,
                    confidence: 95
                }
            };

            ctx.vars.reportEndTime = Date.now();
            const reportTime = (ctx.vars.reportEndTime as number) - (ctx.vars.reportStartTime as number);

            // Get final state for summary
            const finalThoughts = await ctx.getThoughts();
            const qualityDecision = await ctx.getDecision('report-quality');

            const reportSections = [executiveSummary, ...detailedSections];

            const summary = {
                reportSections,
                sectionCount: reportSections.length,
                processingTime: reportTime,
                thoughtCount: Array.isArray(finalThoughts) ? finalThoughts.length : 0,
                qualityAssessment: qualityDecision?.decision,
                workflowId,
                reportType,
                audience,
                completedAt: new Date().toISOString()
            };

            await ctx.reply([
                { type: 'text', text: '✅ **Report Generation Completed Successfully!**\n' },
                { type: 'text', text: `**Report Summary:**` },
                { type: 'text', text: `- Report Type: ${summary.reportType}` },
                { type: 'text', text: `- Sections Generated: ${summary.sectionCount}` },
                { type: 'text', text: `- Processing Time: ${summary.processingTime}ms` },
                { type: 'text', text: `- Thoughts Generated: ${summary.thoughtCount}` },
                { type: 'text', text: `- Quality: ${summary.qualityAssessment}` },
                { type: 'text', text: `- Target Audience: ${summary.audience}` },
                { type: 'text', text: `- Workflow: ${summary.workflowId}` }
            ]);

            ctx.complete(100, 'Report generation completed successfully');
            return summary;

        } catch (error) {
            await ctx.addThought(`Report generation failed: ${error}`);
            await ctx.fail(error);
        }
    }
}, import.meta.url); 
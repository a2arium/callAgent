import { createAgent } from '@a2arium/callagent-core';

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
            const inheritedGoals = await (ctx as any).goals.read?.({});
            const inheritedGoal = Array.isArray(inheritedGoals) && inheritedGoals[0] ? (inheritedGoals[0].title || inheritedGoals[0].id) : undefined;
            const inheritedThoughts: any[] = [];
            const workflowId = (ctx as any).vars.get('workflowId');
            const priority = (ctx as any).vars.get('priority');

            await ctx.reply([
                { type: 'text', text: '🔄 **Context Inheritance Successful**' },
                { type: 'text', text: `- Inherited Goal: ${inheritedGoal}` },
                { type: 'text', text: `- Previous Thoughts: ${Array.isArray(inheritedThoughts) ? inheritedThoughts.length : 0}` },
                { type: 'text', text: `- Workflow ID: ${workflowId}` },
                { type: 'text', text: `- Priority: ${priority}` }
            ]);

            // Set specialized goal for this agent
            await (ctx as any).goals.add({ title: `${inheritedGoal} - Report Generation Phase`, type: 'short', priority: 1 });
            await (ctx as any).thoughts.add('Starting comprehensive report generation');
            await (ctx as any).thoughts.add('Processing analysis data for executive summary');

            // Recall analysis data from working memory
            const analysisData = (ctx as any).vars.get('analysisResults') || (ctx as any).vars.get('currentAnalysis');
            const workflowContext = (ctx as any).vars.get('workflowContext');

            await (ctx as any).thoughts.add(`Found analysis data: ${analysisData ? 'yes' : 'no'}`);
            await (ctx as any).thoughts.add(`Found workflow context: ${workflowContext ? 'yes' : 'no'}`);

            // Recall additional historical reports from working memory  
            const existingReports = (((ctx as any).vars.get('previousReports') as any[]) || []);

            await (ctx as any).thoughts.add(`Found ${existingReports.length} previous reports for context`);

            // Extract report parameters
            const { reportType, audience } = ctx.task.input as any;

            await (ctx as any).thoughts.add(`Generating ${reportType} for ${audience}`);

            // Set reporting tracking variables
            (ctx as any).vars.set('reportStartTime', Date.now());
            (ctx as any).vars.set('currentSection', 'executive-summary');

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

            await (ctx as any).thoughts.add('Executive summary completed');
            (ctx as any).vars.set('currentSection', 'detailed-analysis');

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

            await (ctx as any).thoughts.add('Detailed analysis sections completed');
            await (ctx as any).thoughts.add('Decision: report-quality approved');
            /* formerly makeDecision(
                'report-quality',
                'approved',
                'Report meets quality standards for executive review'
            ); */

            // Store final report in working memory
            (ctx as any).vars.set('finalReport', {
                executiveSummary,
                detailedSections,
                metadata: {
                    generatedBy: 'reporting-agent',
                    analysisSource: analysisData,
                    reportType,
                    audience,
                    confidence: 95
                }
            } as any);

            (ctx as any).vars.set('reportEndTime', Date.now());
            const reportTime = (((ctx as any).vars.get('reportEndTime') as number)) - (((ctx as any).vars.get('reportStartTime') as number));

            // Get final state for summary
            const finalThoughts: any[] = [];
            const qualityDecision: any = { decision: 'approved' };

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
            await (ctx as any).thoughts.add(`Report generation failed: ${error}`);
            await ctx.fail(error);
        }
    }
}, import.meta.url); 
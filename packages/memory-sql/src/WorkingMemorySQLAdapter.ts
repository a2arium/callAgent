import { PrismaClient } from '@prisma/client';
import { logger } from '@a2arium/callagent-utils';
import { WorkingMemoryBackend, ThoughtEntry, DecisionEntry, WorkingMemoryState } from '@a2arium/callagent-types';

/**
 * Configuration options for WorkingMemorySQLAdapter
 */
export interface WorkingMemorySQLConfig {
  /** Pre-configured Prisma client instance */
  prismaClient?: PrismaClient;
  /** Database connection URL (used if prismaClient not provided) */
  databaseUrl?: string;
  /** Default tenant ID for operations */
  defaultTenantId?: string;
}

/**
 * SQL-based Working Memory Adapter using PostgreSQL and Prisma
 * 
 * Provides persistent storage for agent working memory including:
 * - Goals and objectives
 * - Thought chains and observations
 * - Decisions and reasoning
 * - Working variables
 * 
 * Features:
 * - Full tenant isolation
 * - Agent-scoped sessions
 * - Efficient querying with proper indexes
 * - Transaction support for data consistency
 */
export class WorkingMemorySQLAdapter implements WorkingMemoryBackend {
    private logger = logger.createLogger({ prefix: 'WorkingMemorySQL' });
    private prisma: PrismaClient;
    private ownsPrisma: boolean = false;
    private defaultTenantId: string;

    // Support both old and new constructor signatures for backward compatibility
    constructor(
        configOrPrisma?: WorkingMemorySQLConfig | PrismaClient,
        options: { defaultTenantId?: string } = {}
    ) {
        let config: WorkingMemorySQLConfig;

        // Detect old vs new constructor signature
        if (configOrPrisma && typeof (configOrPrisma as any).$connect === 'function') {
            // Old signature: constructor(prisma, options?)
            config = {
                prismaClient: configOrPrisma as PrismaClient,
                defaultTenantId: options.defaultTenantId
            };
        } else {
            // New signature: constructor(config?)
            config = configOrPrisma as WorkingMemorySQLConfig || {};
        }

        // Initialize Prisma client
        if (config.prismaClient) {
            this.prisma = config.prismaClient;
            this.ownsPrisma = false;
        } else if (config.databaseUrl) {
            this.prisma = new PrismaClient({
                datasources: { db: { url: config.databaseUrl } }
            });
            this.ownsPrisma = true;
        } else if (process.env.MEMORY_DATABASE_URL || process.env.DATABASE_URL) {
            const dbUrl = process.env.MEMORY_DATABASE_URL || process.env.DATABASE_URL;
            this.prisma = new PrismaClient({
                datasources: { db: { url: dbUrl } }
            });
            this.ownsPrisma = true;
        } else {
            throw new Error(`
WorkingMemorySQLAdapter requires database configuration. Provide either:
1. config.prismaClient: Pre-configured PrismaClient
2. config.databaseUrl: Database connection string  
3. Environment variable: MEMORY_DATABASE_URL or DATABASE_URL

Example:
new WorkingMemorySQLAdapter({ 
  databaseUrl: "postgresql://user:pass@localhost:5432/mydb" 
})
            `.trim());
        }

        this.defaultTenantId = config.defaultTenantId || 'default';
    }

    /**
     * Disconnect from the database (only if we created the Prisma client)
     */
    async disconnect(): Promise<void> {
        if (this.ownsPrisma && this.prisma) {
            await this.prisma.$disconnect();
        }
    }

    // ========================================
    // Goal Management
    // ========================================

    async setGoal(goal: string, agentId: string, tenantId: string): Promise<void> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        try {
            await this.prisma.workingMemorySession.upsert({
                where: {
                    tenantId_agentId: {
                        tenantId: resolvedTenantId,
                        agentId
                    }
                },
                update: {
                    currentGoal: goal,
                    goalTimestamp: new Date(),
                    updatedAt: new Date()
                },
                create: {
                    tenantId: resolvedTenantId,
                    agentId,
                    currentGoal: goal,
                    goalTimestamp: new Date()
                }
            });

            this.logger.debug('Goal set successfully', {
                tenantId: resolvedTenantId,
                agentId,
                goal: goal.substring(0, 100)
            });
        } catch (error) {
            this.logger.error('Failed to set goal', {
                tenantId: resolvedTenantId,
                agentId,
                error
            });
            throw new Error(`Failed to set goal: ${error}`);
        }
    }

    async getGoal(agentId: string, tenantId: string): Promise<string | null> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        try {
            const session = await this.prisma.workingMemorySession.findUnique({
                where: {
                    tenantId_agentId: {
                        tenantId: resolvedTenantId,
                        agentId
                    }
                }
            });

            return session?.currentGoal || null;
        } catch (error) {
            this.logger.error('Failed to get goal', {
                tenantId: resolvedTenantId,
                agentId,
                error
            });
            throw new Error(`Failed to get goal: ${error}`);
        }
    }

    // ========================================
    // Thought Chain Management
    // ========================================

    async addThought(thought: ThoughtEntry, agentId: string, tenantId: string): Promise<void> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        try {
            // Convert processing metadata to JSON-compatible value
            const jsonMetadata = thought.processingMetadata
                ? JSON.parse(JSON.stringify(thought.processingMetadata))
                : null;

            await this.prisma.workingMemoryThought.create({
                data: {
                    tenantId: resolvedTenantId,
                    agentId,
                    content: thought.content,
                    type: thought.type,
                    timestamp: new Date(thought.timestamp),
                    processingMetadata: jsonMetadata
                }
            });

            this.logger.debug('Thought added successfully', {
                tenantId: resolvedTenantId,
                agentId,
                type: thought.type,
                content: thought.content.substring(0, 100)
            });
        } catch (error) {
            this.logger.error('Failed to add thought', {
                tenantId: resolvedTenantId,
                agentId,
                error
            });
            throw new Error(`Failed to add thought: ${error}`);
        }
    }

    async getThoughts(agentId: string, tenantId: string): Promise<ThoughtEntry[]> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        try {
            const thoughts = await this.prisma.workingMemoryThought.findMany({
                where: {
                    tenantId: resolvedTenantId,
                    agentId
                },
                orderBy: {
                    timestamp: 'asc' // Chronological order
                }
            });

            return thoughts.map(thought => ({
                timestamp: thought.timestamp.toISOString(),
                content: thought.content,
                type: thought.type as ThoughtEntry['type'],
                processingMetadata: thought.processingMetadata as ThoughtEntry['processingMetadata']
            }));
        } catch (error) {
            this.logger.error('Failed to get thoughts', {
                tenantId: resolvedTenantId,
                agentId,
                error
            });
            throw new Error(`Failed to get thoughts: ${error}`);
        }
    }

    // ========================================
    // Decision Tracking
    // ========================================

    async makeDecision(key: string, decision: DecisionEntry, agentId: string, tenantId: string): Promise<void> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        try {
            await this.prisma.workingMemoryDecision.upsert({
                where: {
                    tenantId_agentId_decisionKey: {
                        tenantId: resolvedTenantId,
                        agentId,
                        decisionKey: key
                    }
                },
                update: {
                    decision: decision.decision,
                    reasoning: decision.reasoning,
                    timestamp: new Date(decision.timestamp)
                },
                create: {
                    tenantId: resolvedTenantId,
                    agentId,
                    decisionKey: key,
                    decision: decision.decision,
                    reasoning: decision.reasoning,
                    timestamp: new Date(decision.timestamp)
                }
            });

            this.logger.debug('Decision made successfully', {
                tenantId: resolvedTenantId,
                agentId,
                key,
                decision: decision.decision
            });
        } catch (error) {
            this.logger.error('Failed to make decision', {
                tenantId: resolvedTenantId,
                agentId,
                key,
                error
            });
            throw new Error(`Failed to make decision: ${error}`);
        }
    }

    async getDecision(key: string, agentId: string, tenantId: string): Promise<DecisionEntry | null> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        try {
            const decision = await this.prisma.workingMemoryDecision.findUnique({
                where: {
                    tenantId_agentId_decisionKey: {
                        tenantId: resolvedTenantId,
                        agentId,
                        decisionKey: key
                    }
                }
            });

            if (!decision) return null;

            return {
                decision: decision.decision,
                reasoning: decision.reasoning || undefined,
                timestamp: decision.timestamp.toISOString()
            };
        } catch (error) {
            this.logger.error('Failed to get decision', {
                tenantId: resolvedTenantId,
                agentId,
                key,
                error
            });
            throw new Error(`Failed to get decision: ${error}`);
        }
    }

    async getAllDecisions(agentId: string, tenantId: string): Promise<Record<string, DecisionEntry>> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        try {
            const decisions = await this.prisma.workingMemoryDecision.findMany({
                where: {
                    tenantId: resolvedTenantId,
                    agentId
                },
                orderBy: {
                    timestamp: 'asc' // Chronological order
                }
            });

            const decisionsMap: Record<string, DecisionEntry> = {};
            decisions.forEach(d => {
                decisionsMap[d.decisionKey] = {
                    decision: d.decision,
                    reasoning: d.reasoning || undefined,
                    timestamp: d.timestamp.toISOString()
                };
            });

            this.logger.debug('Retrieved all decisions successfully', {
                tenantId: resolvedTenantId,
                agentId,
                count: decisions.length
            });

            return decisionsMap;
        } catch (error) {
            this.logger.error('Failed to get all decisions', {
                tenantId: resolvedTenantId,
                agentId,
                error
            });
            throw new Error(`Failed to get all decisions: ${error}`);
        }
    }

    // ========================================
    // Variable Storage
    // ========================================

    async setVariable(key: string, value: unknown, agentId: string, tenantId: string): Promise<void> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        try {
            // Convert unknown to JSON-compatible value
            const jsonValue = value === undefined ? null : JSON.parse(JSON.stringify(value));

            await this.prisma.workingMemoryVariable.upsert({
                where: {
                    tenantId_agentId_variableKey: {
                        tenantId: resolvedTenantId,
                        agentId,
                        variableKey: key
                    }
                },
                update: {
                    variableValue: jsonValue,
                    updatedAt: new Date()
                },
                create: {
                    tenantId: resolvedTenantId,
                    agentId,
                    variableKey: key,
                    variableValue: jsonValue
                }
            });

            this.logger.debug('Variable set successfully', {
                tenantId: resolvedTenantId,
                agentId,
                key,
                valueType: typeof value
            });
        } catch (error) {
            this.logger.error('Failed to set variable', {
                tenantId: resolvedTenantId,
                agentId,
                key,
                error
            });
            throw new Error(`Failed to set variable: ${error}`);
        }
    }

    async getVariable(key: string, agentId: string, tenantId: string): Promise<unknown> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        try {
            const variable = await this.prisma.workingMemoryVariable.findUnique({
                where: {
                    tenantId_agentId_variableKey: {
                        tenantId: resolvedTenantId,
                        agentId,
                        variableKey: key
                    }
                }
            });

            return variable?.variableValue || undefined;
        } catch (error) {
            this.logger.error('Failed to get variable', {
                tenantId: resolvedTenantId,
                agentId,
                key,
                error
            });
            throw new Error(`Failed to get variable: ${error}`);
        }
    }

    // ========================================
    // Session Management
    // ========================================

    async clearSession(agentId: string, tenantId: string): Promise<void> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        try {
            await this.prisma.$transaction(async (tx) => {
                // Delete all working memory data for this agent
                await tx.workingMemoryVariable.deleteMany({
                    where: { tenantId: resolvedTenantId, agentId }
                });

                await tx.workingMemoryDecision.deleteMany({
                    where: { tenantId: resolvedTenantId, agentId }
                });

                await tx.workingMemoryThought.deleteMany({
                    where: { tenantId: resolvedTenantId, agentId }
                });

                await tx.workingMemorySession.delete({
                    where: {
                        tenantId_agentId: {
                            tenantId: resolvedTenantId,
                            agentId
                        }
                    }
                });
            });

            this.logger.info('Session cleared successfully', {
                tenantId: resolvedTenantId,
                agentId
            });
        } catch (error) {
            this.logger.error('Failed to clear session', {
                tenantId: resolvedTenantId,
                agentId,
                error
            });
            throw new Error(`Failed to clear session: ${error}`);
        }
    }

    async getSessionState(agentId: string, tenantId: string): Promise<WorkingMemoryState> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        try {
            // Get all working memory data in parallel
            const [session, thoughts, decisions, variables] = await Promise.all([
                this.prisma.workingMemorySession.findUnique({
                    where: {
                        tenantId_agentId: {
                            tenantId: resolvedTenantId,
                            agentId
                        }
                    }
                }),
                this.getThoughts(agentId, resolvedTenantId),
                this.prisma.workingMemoryDecision.findMany({
                    where: { tenantId: resolvedTenantId, agentId }
                }),
                this.prisma.workingMemoryVariable.findMany({
                    where: { tenantId: resolvedTenantId, agentId }
                })
            ]);

            // Build decisions map
            const decisionsMap: Record<string, DecisionEntry> = {};
            decisions.forEach(d => {
                decisionsMap[d.decisionKey] = {
                    decision: d.decision,
                    reasoning: d.reasoning || undefined,
                    timestamp: d.timestamp.toISOString()
                };
            });

            // Build variables map
            const variablesMap: Record<string, unknown> = {};
            variables.forEach(v => {
                variablesMap[v.variableKey] = v.variableValue;
            });

            return {
                currentGoal: session?.currentGoal ? {
                    content: session.currentGoal,
                    timestamp: session.goalTimestamp?.toISOString() || session.updatedAt.toISOString()
                } : null,
                thoughtChain: thoughts,
                decisions: decisionsMap,
                variables: variablesMap,
                loadedLongTermMemories: [], // Not implemented yet
                meta: {
                    lastUpdatedAt: session?.updatedAt.toISOString() || new Date().toISOString(),
                    version: '1.0.0',
                    agentId
                }
            };
        } catch (error) {
            this.logger.error('Failed to get session state', {
                tenantId: resolvedTenantId,
                agentId,
                error
            });
            throw new Error(`Failed to get session state: ${error}`);
        }
    }

    // ========================================
    // Lifecycle Management
    // ========================================

    async initialize(): Promise<void> {
        this.logger.info('WorkingMemorySQLAdapter initialized', {
            defaultTenantId: this.defaultTenantId
        });
    }

    async shutdown(): Promise<void> {
        this.logger.info('WorkingMemorySQLAdapter shutting down');
        // Prisma client cleanup is handled by the caller
    }
} 
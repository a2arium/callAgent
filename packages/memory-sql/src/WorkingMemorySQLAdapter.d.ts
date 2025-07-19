import { PrismaClient } from '@prisma/client';
import { WorkingMemoryBackend, ThoughtEntry, DecisionEntry, WorkingMemoryState } from '@callagent/types';
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
export declare class WorkingMemorySQLAdapter implements WorkingMemoryBackend {
    private prisma;
    private options;
    private logger;
    private defaultTenantId;
    constructor(prisma: PrismaClient, options?: {
        defaultTenantId?: string;
    });
    setGoal(goal: string, agentId: string, tenantId: string): Promise<void>;
    getGoal(agentId: string, tenantId: string): Promise<string | null>;
    addThought(thought: ThoughtEntry, agentId: string, tenantId: string): Promise<void>;
    getThoughts(agentId: string, tenantId: string): Promise<ThoughtEntry[]>;
    makeDecision(key: string, decision: DecisionEntry, agentId: string, tenantId: string): Promise<void>;
    getDecision(key: string, agentId: string, tenantId: string): Promise<DecisionEntry | null>;
    getAllDecisions(agentId: string, tenantId: string): Promise<Record<string, DecisionEntry>>;
    setVariable(key: string, value: unknown, agentId: string, tenantId: string): Promise<void>;
    getVariable(key: string, agentId: string, tenantId: string): Promise<unknown>;
    clearSession(agentId: string, tenantId: string): Promise<void>;
    getSessionState(agentId: string, tenantId: string): Promise<WorkingMemoryState>;
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
}

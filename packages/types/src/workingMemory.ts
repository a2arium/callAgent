/**
 * Working Memory Types and Backend Interface
 * These types define the structure of agent's active cognitive state and the backend interface
 */

export type WorkingMemoryState = {
    currentGoal: { content: string; timestamp: string } | null;
    thoughtChain: Array<{
        timestamp: string;
        content: string;
        type: 'thought' | 'observation' | 'decision' | 'internal';
        processingMetadata?: {
            processingHistory?: string[];
            compressed?: boolean;
            summarized?: boolean;
        };
    }>;
    decisions: Record<string, {
        decision: string;
        reasoning?: string;
        timestamp: string
    }>;
    variables: Record<string, unknown>;
    loadedLongTermMemories: Array<{
        source: string;
        key: string;
        content: unknown;
        relevance?: number;
        loadedAt: string;
        type: 'semantic' | 'episodic' | 'vector';
    }>;
    meta: {
        lastUpdatedAt: string;
        version: string;
        taskId?: string;
        agentId?: string;
    };
};

export type ThoughtEntry = {
    timestamp: string;
    content: string;
    type: 'thought' | 'observation' | 'decision' | 'internal';
    processingMetadata?: {
        processingHistory?: string[];
        compressed?: boolean;
        summarized?: boolean;
    };
};

export type DecisionEntry = {
    decision: string;
    reasoning?: string;
    timestamp: string;
};

export type SerializedWorkingMemoryState = WorkingMemoryState;
export type WorkingVariables = Record<string, unknown>;

/**
 * Working Memory Backend Interface
 * 
 * Defines the contract for working memory storage adapters.
 * All operations are tenant and agent scoped for proper isolation.
 */
export type WorkingMemoryBackend = {
    // Goal management
    setGoal(goal: string, agentId: string, tenantId: string): Promise<void>;
    getGoal(agentId: string, tenantId: string): Promise<string | null>;

    // Thought chain management
    addThought(thought: ThoughtEntry, agentId: string, tenantId: string): Promise<void>;
    getThoughts(agentId: string, tenantId: string): Promise<ThoughtEntry[]>;

    // Decision tracking
    makeDecision(key: string, decision: DecisionEntry, agentId: string, tenantId: string): Promise<void>;
    getDecision(key: string, agentId: string, tenantId: string): Promise<DecisionEntry | null>;
    getAllDecisions(agentId: string, tenantId: string): Promise<Record<string, DecisionEntry>>;

    // Variable storage
    setVariable(key: string, value: unknown, agentId: string, tenantId: string): Promise<void>;
    getVariable(key: string, agentId: string, tenantId: string): Promise<unknown>;

    // Session management
    clearSession(agentId: string, tenantId: string): Promise<void>;
    getSessionState(agentId: string, tenantId: string): Promise<WorkingMemoryState>;

    // Lifecycle
    initialize?(): Promise<void>;
    shutdown?(): Promise<void>;
}; 
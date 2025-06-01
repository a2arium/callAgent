/**
 * Working Memory Types
 * These types define the structure of agent's active cognitive state
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
    type?: 'thought' | 'observation';
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
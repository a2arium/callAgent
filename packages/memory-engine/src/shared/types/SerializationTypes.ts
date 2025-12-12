import type { ThoughtEntry, DecisionEntry } from './workingMemory.js';

/**
 * Serialized working memory state for transfer between agents
 */
export type SerializedWorkingMemory = {
    goal?: string;
    thoughts: ThoughtEntry[];
    decisions: Record<string, DecisionEntry>;
    variables: Record<string, unknown>;
};

/**
 * Represents a single recalled memory item for transfer.
 */
export type RecalledMemoryItem = {
    id: string; // Or a unique key for the memory item
    type: 'semantic' | 'episodic' | string; // Type of memory
    data: unknown; // The actual memory content
    metadata?: Record<string, unknown>; // Any associated metadata
};

/**
 * Memory context keys and snapshot for transfer
 */
export type SerializedMemoryContext = {
    /** 
     * Optional high-level semantic keys or topics representing the context.
     * Further clarification needed during implementation on its exact role 
     * if memorySnapshot is comprehensive.
     */
    semanticKeys?: string[];
    episodicEventCount?: number; // Or a more direct representation of episodic context
    /** 
     * A snapshot of recalled memory items, preserving their structure and type.
     */
    memorySnapshot: RecalledMemoryItem[];
};

/**
 * Complete context package for agent transfer
 */
export type SerializedAgentContext = {
    tenantId: string;
    sourceTaskId: string;
    sourceAgentId: string; // Ensure this is correctly populated
    timestamp: string;
    workingMemory?: SerializedWorkingMemory;
    memoryContext?: SerializedMemoryContext;
}; 
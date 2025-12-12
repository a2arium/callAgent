import { v4 as uuidv4 } from 'uuid';

export type MemoryIntent =
    | 'workingMemory'     // For working memory operations
    | 'semanticLTM'       // For semantic long-term memory
    | 'episodicLTM'       // For episodic long-term memory
    | 'retrieval'         // For recall operations
    | 'proceduralLTM';    // Future: learned behaviors

export type MemoryItem<T = unknown> = {
    id: string;
    data: T;
    dataType: 'text' | 'json' | 'vector' | 'image' | 'audio';
    intent: MemoryIntent;
    metadata: {
        tenantId: string;
        agentId?: string;
        taskId?: string;
        timestamp: string;
        processingHistory: string[];
        sourceOperation: string;
        // Additional metadata added by processors
        compressed?: boolean;
        summarized?: boolean;
        attentionScore?: number;
        relevanceScore?: number;
        [key: string]: unknown;
    };
    processingDirectives?: Record<string, unknown>;
    /*
     * ENHANCEMENT: Schema for processingDirectives
     * Define a standardized schema (e.g., JSON Schema) to ensure consistency when passing hints
     * (e.g., "compressLevel": "high", "priorityScore": 0.9). Integrate a lightweight validator
     * (e.g., ajv for TypeScript) to prevent runtime errors.
     */
};

export type MemoryOperationResult = {
    success: boolean;
    processedItems: MemoryItem[];
    targetStore?: string;
    metadata?: Record<string, unknown>;
};

export type RecallOptions = {
    type?: 'semantic' | 'episodic' | 'vector';
    namespace?: string;
    limit?: number;
    tenantId?: string;
    sources?: string[];
};

export type RememberOptions = {
    persist?: boolean | 'explicit';
    importance?: 'high' | 'medium' | 'low';
    type?: 'semantic' | 'episodic';
    namespace?: string;
    ttl?: number;
};

// Helper to create MemoryItem
export function createMemoryItem<T>(
    data: T,
    intent: MemoryIntent,
    sourceOperation: string,
    tenantId: string,
    agentId?: string
): MemoryItem<T> {
    return {
        id: uuidv4(),
        data,
        dataType: typeof data === 'string' ? 'text' : 'json',
        intent,
        metadata: {
            tenantId,
            agentId,
            timestamp: new Date().toISOString(),
            processingHistory: [],
            sourceOperation,
        }
    };
} 
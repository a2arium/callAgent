export type MemoryIntent = 'workingMemory' | 'semanticLTM' | 'episodicLTM' | 'retrieval' | 'proceduralLTM';
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
        compressed?: boolean;
        summarized?: boolean;
        attentionScore?: number;
        relevanceScore?: number;
        [key: string]: unknown;
    };
    processingDirectives?: Record<string, unknown>;
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
export declare function createMemoryItem<T>(data: T, intent: MemoryIntent, sourceOperation: string, tenantId: string, agentId?: string): MemoryItem<T>;

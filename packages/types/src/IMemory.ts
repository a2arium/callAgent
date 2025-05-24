/**
 * Supported filter operators for querying memory entries.
 */
export type FilterOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'CONTAINS' | 'STARTS_WITH' | 'ENDS_WITH';

/**
 * A filter condition for querying memory entries by JSON path and operator.
 */
export type MemoryFilter = {
    path: string;          // JSON path like 'status' or 'customer.profile.name'
    operator: FilterOperator;
    value: any;
};

/**
 * Options for querying memory, including tag, similarity, limit, filters, and ordering.
 */
export type MemoryQueryOptions = {
    /** Filter entries by a specific tag */
    tag?: string;
    /** Find entries similar to this vector (only supported by certain adapters) */
    similarityVector?: number[];
    /** Maximum number of entries to return */
    limit?: number;
    /** Filter by JSON field values with various operators */
    filters?: MemoryFilter[];
    /** Order results by a JSON field path */
    orderBy?: {
        path: string;
        direction: 'asc' | 'desc';
    };
};

/**
 * A single result from a memory query, containing the key and value.
 */
export type MemoryQueryResult<T> = {
    key: string;
    value: T;
};

/**
 * Interface for a semantic memory backend, supporting key-value storage and advanced queries.
 *
 * Semantic memory is used for storing structured, queryable knowledge (e.g., facts, user profiles).
 * Backends may support tags, filtering, and similarity search.
 */
export type SemanticMemoryBackend = {
    get<T>(key: string, opts?: { backend?: string }): Promise<T | null>;
    set<T>(key: string, value: T, opts?: { backend?: string, tags?: string[] }): Promise<void>;
    query<T>(opts: MemoryQueryOptions & { backend?: string }): Promise<Array<MemoryQueryResult<T>>>;
    delete(key: string, opts?: { backend?: string }): Promise<void>;
};

/**
 * Interface for an episodic memory backend, supporting event log storage and retrieval.
 *
 * Episodic memory is used for storing time-ordered events or experiences (e.g., conversation history).
 */
export type EpisodicMemoryBackend = {
    append<T>(event: T, opts?: { backend?: string, tags?: string[] }): Promise<void>;
    getEvents<T>(filter?: MemoryQueryOptions & { backend?: string }): Promise<Array<MemoryQueryResult<T>>>;
    deleteEvent(id: string, opts?: { backend?: string }): Promise<void>;
};

/**
 * Interface for an embed memory backend, supporting vector storage and similarity search.
 *
 * Embed memory is used for storing and querying high-dimensional vector representations (e.g., embeddings).
 */
export type EmbedMemoryBackend = {
    upsert<T>(key: string, embedding: number[], value: T, opts?: { backend?: string }): Promise<void>;
    queryByVector<T>(vector: number[], opts?: { backend?: string, limit?: number }): Promise<Array<MemoryQueryResult<T>>>;
    delete(key: string, opts?: { backend?: string }): Promise<void>;
};

/**
 * Registry/facade for a memory tier, supporting multiple backends and default selection.
 *
 * @template T The backend interface for this memory tier.
 */
export type MemoryRegistry<T> = {
    getDefaultBackend(): string;
    setDefaultBackend(name: string): void;
    backends: Record<string, T>;
} & T;

/**
 * The main memory interface injected into agent context, providing access to all memory tiers.
 *
 * - `semantic`: Structured, queryable knowledge (facts, profiles, etc.)
 * - `episodic`: Time-ordered event log (conversations, actions, etc.)
 * - `embed`: Vector/embedding storage and similarity search
 *
 * Each tier is a registry supporting multiple backends and default selection.
 */
export type IMemory = {
    semantic: MemoryRegistry<SemanticMemoryBackend>;
    episodic: MemoryRegistry<EpisodicMemoryBackend>;
    embed: MemoryRegistry<EmbedMemoryBackend>;
}; 
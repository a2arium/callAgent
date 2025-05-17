/**
 * Query options for memory retrieval
 */
export type FilterOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'CONTAINS' | 'STARTS_WITH' | 'ENDS_WITH';

export type MemoryFilter = {
    path: string;          // JSON path like 'status' or 'customer.profile.name'
    operator: FilterOperator;
    value: any;
};

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
 * A single result from a memory query
 */
export type MemoryQueryResult<T> = {
    key: string;
    value: T;
};

/**
 * Interface for Agent's long-term memory storage
 */
export type IMemory = {
    /**
     * Retrieves a value by its key
     * @param key The unique identifier for the memory entry
     * @returns The stored value or null if not found
     */
    get<T>(key: string): Promise<T | null>;

    /**
     * Stores a value with an associated key
     * @param key The unique identifier for the memory entry
     * @param value The data to store
     * @param options Optional settings like tags
     */
    set<T>(key: string, value: T, options?: { tags?: string[] }): Promise<void>;

    /**
     * Queries memory entries based on tag, vector similarity, or JSON field filters
     * @param opts Query options including tag, similarity vector, filters, and/or limit
     * @returns Array of matching key/value entries
     */
    query<T>(opts: MemoryQueryOptions): Promise<Array<MemoryQueryResult<T>>>;

    /**
     * Deletes a memory entry by key
     * @param key The unique identifier of the entry to delete
     */
    delete(key: string): Promise<void>;
}; 
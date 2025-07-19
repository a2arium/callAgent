import { SemanticMemoryBackend, MemoryRegistry, GetManyInput, GetManyOptions, MemoryQueryResult, MemorySetOptions, RecognitionOptions, RecognitionResult, EnrichmentOptions, EnrichmentResult } from '@callagent/types';
/**
 * Registry/facade for semantic memory backends.
 * Routes calls to the default or named backend as specified.
 */
export declare class SemanticMemoryRegistry implements MemoryRegistry<SemanticMemoryBackend> {
    /** Map of backend names to backend implementations */
    backends: Record<string, SemanticMemoryBackend>;
    /** Name of the default backend */
    private defaultBackend;
    /**
     * Create a new SemanticMemoryRegistry
     * @param backends Map of backend names to implementations
     * @param defaultBackend Name of the default backend
     */
    constructor(backends: Record<string, SemanticMemoryBackend>, defaultBackend: string);
    /**
     * Get the name of the default backend
     */
    getDefaultBackend(): string;
    /**
     * Set the default backend by name
     * @param name Name of the backend to set as default
     * @throws If the backend does not exist
     */
    setDefaultBackend(name: string): void;
    /**
     * Retrieve a value by key from the selected backend
     * @param key The unique identifier for the memory entry
     * @param opts Optional backend override
     */
    get<T>(key: string, opts?: {
        backend?: string;
    }): Promise<T | null>;
    /**
     * Store a value with an associated key in the selected backend
     * @param key The unique identifier for the memory entry
     * @param value The data to store
     * @param opts Optional backend override and tags
     */
    set<T>(key: string, value: T, opts?: MemorySetOptions): Promise<void>;
    /**
     * Get many memory entries from the selected backend
     * @param input Pattern string or query object
     * @param options Optional query options including backend override
     */
    getMany<T>(input: GetManyInput, options?: GetManyOptions): Promise<Array<MemoryQueryResult<T>>>;
    /**
     * Delete a memory entry by key in the selected backend
     * @param key The unique identifier of the entry to delete
     * @param opts Optional backend override
     */
    delete(key: string, opts?: {
        backend?: string;
    }): Promise<void>;
    /**
     * Delete multiple memory entries from the selected backend
     * @param input Pattern string or query object
     * @param options Optional query options including backend override
     * @returns Number of entries deleted
     */
    deleteMany(input: GetManyInput, options?: GetManyOptions): Promise<number>;
    /**
     * Get entity management interface from the default backend
     */
    get entities(): {
        unlink(memoryKey: string, fieldPath: string): Promise<void>;
        realign(memoryKey: string, fieldPath: string, newEntityId: string): Promise<void>;
        stats(entityType?: string): Promise<{
            totalEntities: number;
            totalAlignments: number;
            entitiesByType: Record<string, number>;
        }>;
    } | undefined;
    /**
     * Recognize if candidate data matches existing memory entries
     * @param candidateData The data to check for recognition
     * @param options Recognition options
     */
    recognize<T>(candidateData: T, options?: RecognitionOptions): Promise<RecognitionResult<T>>;
    /**
     * Enrich memory data by consolidating multiple sources
     * @param key The memory key to enrich
     * @param additionalData Array of additional data to consolidate
     * @param options Enrichment options
     */
    enrich<T>(key: string, additionalData: T[], options?: EnrichmentOptions): Promise<EnrichmentResult<T>>;
}

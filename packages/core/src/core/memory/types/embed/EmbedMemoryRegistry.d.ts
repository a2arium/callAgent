import { EmbedMemoryBackend, MemoryRegistry } from '@callagent/types';
/**
 * Registry/facade for embed memory backends.
 * Routes calls to the default or named backend as specified.
 */
export declare class EmbedMemoryRegistry implements MemoryRegistry<EmbedMemoryBackend> {
    /** Map of backend names to backend implementations */
    backends: Record<string, EmbedMemoryBackend>;
    /** Name of the default backend */
    private defaultBackend;
    /**
     * Create a new EmbedMemoryRegistry
     * @param backends Map of backend names to implementations
     * @param defaultBackend Name of the default backend
     */
    constructor(backends: Record<string, EmbedMemoryBackend>, defaultBackend: string);
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
     * Upsert an embedding and value in the selected backend
     * @param key The unique identifier for the embedding
     * @param embedding The embedding vector
     * @param value The data to store
     * @param opts Optional backend override
     */
    upsert<T>(key: string, embedding: number[], value: T, opts?: {
        backend?: string;
    }): Promise<void>;
    /**
     * Query by vector similarity in the selected backend
     * @param vector The query embedding vector
     * @param opts Optional backend override and limit
     */
    queryByVector<T>(vector: number[], opts?: {
        backend?: string;
        limit?: number;
    }): Promise<Array<{
        key: string;
        value: T;
    }>>;
    /**
     * Delete an embedding by key in the selected backend
     * @param key The unique identifier of the embedding to delete
     * @param opts Optional backend override
     */
    delete(key: string, opts?: {
        backend?: string;
    }): Promise<void>;
}

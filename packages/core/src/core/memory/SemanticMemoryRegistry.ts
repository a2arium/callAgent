import { SemanticMemoryBackend, MemoryRegistry } from '@callagent/types';

/**
 * Registry/facade for semantic memory backends.
 * Routes calls to the default or named backend as specified.
 */
export class SemanticMemoryRegistry implements MemoryRegistry<SemanticMemoryBackend> {
    /** Map of backend names to backend implementations */
    public backends: Record<string, SemanticMemoryBackend>;
    /** Name of the default backend */
    private defaultBackend: string;

    /**
     * Create a new SemanticMemoryRegistry
     * @param backends Map of backend names to implementations
     * @param defaultBackend Name of the default backend
     */
    constructor(backends: Record<string, SemanticMemoryBackend>, defaultBackend: string) {
        this.backends = backends;
        this.defaultBackend = defaultBackend;
    }

    /**
     * Get the name of the default backend
     */
    getDefaultBackend(): string {
        return this.defaultBackend;
    }

    /**
     * Set the default backend by name
     * @param name Name of the backend to set as default
     * @throws If the backend does not exist
     */
    setDefaultBackend(name: string): void {
        if (!this.backends[name]) throw new Error(`No such backend: ${name}`);
        this.defaultBackend = name;
    }

    /**
     * Retrieve a value by key from the selected backend
     * @param key The unique identifier for the memory entry
     * @param opts Optional backend override
     */
    async get<T>(key: string, opts?: { backend?: string }): Promise<T | null> {
        const backend = this.backends[opts?.backend ?? this.defaultBackend];
        return backend.get<T>(key, opts);
    }

    /**
     * Store a value with an associated key in the selected backend
     * @param key The unique identifier for the memory entry
     * @param value The data to store
     * @param opts Optional backend override and tags
     */
    async set<T>(key: string, value: T, opts?: { backend?: string, tags?: string[] }): Promise<void> {
        const backend = this.backends[opts?.backend ?? this.defaultBackend];
        return backend.set<T>(key, value, opts);
    }

    /**
     * Query memory entries in the selected backend
     * @param opts Query options, may include backend override
     */
    async query<T>(opts: any): Promise<Array<{ key: string; value: T }>> {
        const backendName = opts?.backend ?? this.defaultBackend;
        const backend = this.backends[backendName];
        return backend.query<T>(opts);
    }

    /**
     * Delete a memory entry by key in the selected backend
     * @param key The unique identifier of the entry to delete
     * @param opts Optional backend override
     */
    async delete(key: string, opts?: { backend?: string }): Promise<void> {
        const backend = this.backends[opts?.backend ?? this.defaultBackend];
        return backend.delete(key, opts);
    }
} 
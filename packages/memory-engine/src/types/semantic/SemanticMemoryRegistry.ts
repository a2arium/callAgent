import {
    SemanticMemoryBackend,
    MemoryRegistry,
    GetManyInput,
    GetManyOptions,
    MemoryQueryResult,
    MemorySetOptions,
    RecognitionOptions,
    RecognitionResult,
    EnrichmentOptions,
    EnrichmentResult
} from '@a2arium/callagent-types';

export type SemanticMemoryEvent = {
    op: 'read' | 'write' | 'delete';
    keys: string[];
    backend?: string;
    source: 'context.memory';
};

type FacadeSemanticMemoryBackend = SemanticMemoryBackend & {
    read?: <T>(input: GetManyInput, options?: GetManyOptions) => Promise<Array<MemoryQueryResult<T>>>;
    remove?: (input: GetManyInput, options?: GetManyOptions) => Promise<number>;
    enrich?: <T>(key: string, additionalData: T[], options?: EnrichmentOptions) => Promise<EnrichmentResult<T>>;
};

function keysFromInput(input: GetManyInput): string[] {
    if (typeof input === 'string') {
        return [input];
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return [];
    }
    const record = input as Record<string, unknown>;
    const id = record.id;
    if (typeof id === 'string') {
        return [id];
    }
    if (Array.isArray(id)) {
        return id.filter((item): item is string => typeof item === 'string');
    }
    return [];
}

/**
 * Registry/facade for semantic memory backends.
 * Routes calls to the default or named backend as specified.
 */
export class SemanticMemoryRegistry implements Omit<MemoryRegistry<SemanticMemoryBackend>, 'getMany' | 'deleteMany'> {
    /** Map of backend names to backend implementations */
    public backends: Record<string, SemanticMemoryBackend>;
    /** Name of the default backend */
    private defaultBackend: string;

    /**
     * Create a new SemanticMemoryRegistry
     * @param backends Map of backend names to implementations
     * @param defaultBackend Name of the default backend
     */
    constructor(
        backends: Record<string, SemanticMemoryBackend>,
        defaultBackend: string,
        private eventSink?: (event: SemanticMemoryEvent) => Promise<void> | void
    ) {
        this.backends = backends;
        this.defaultBackend = defaultBackend;
    }

    private async emit(event: SemanticMemoryEvent): Promise<void> {
        try {
            await this.eventSink?.(event);
        } catch {
            // Operator capture is best-effort and must not affect memory semantics.
        }
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
        const backendName = opts?.backend ?? this.defaultBackend;
        const backend = this.backends[backendName];
        const result = await backend.get<T>(key, opts);
        await this.emit({ op: 'read', keys: [key], backend: backendName, source: 'context.memory' });
        return result;
    }

    /**
     * Store a value with an associated key in the selected backend
     * @param key The unique identifier for the memory entry
     * @param value The data to store
     * @param opts Optional backend override and tags
     */
    async set<T>(key: string, value: T, opts?: MemorySetOptions): Promise<void> {
        const backendName = opts?.backend ?? this.defaultBackend;
        const backend = this.backends[backendName];
        await backend.set<T>(key, value, opts);
        await this.emit({ op: 'write', keys: [key], backend: backendName, source: 'context.memory' });
    }

    /**
     * Get many memory entries from the selected backend
     * @param input Pattern string or query object
     * @param options Optional query options including backend override
     */
    // Legacy getMany removed in favor of read

    /**
     * Read many memory entries from the selected backend using facade semantics
     * @param input Tag/filters/limit-style query object or pattern string (temporary support)
     * @param options Optional query options including backend override
     */
    async read<T>(input: GetManyInput, options?: GetManyOptions): Promise<Array<MemoryQueryResult<T>>> {
        const backendName = options?.backend ?? this.defaultBackend;
        const backend = this.backends[backendName] as FacadeSemanticMemoryBackend;
        const result = await (backend.read?.<T>(input, options) ?? Promise.resolve([] as Array<MemoryQueryResult<T>>));
        await this.emit({ op: 'read', keys: keysFromInput(input), backend: backendName, source: 'context.memory' });
        return result;
    }


    /**
     * Delete a memory entry by key in the selected backend
     * @param key The unique identifier of the entry to delete
     * @param opts Optional backend override
     */
    async delete(key: string, opts?: { backend?: string }): Promise<void> {
        const backendName = opts?.backend ?? this.defaultBackend;
        const backend = this.backends[backendName];
        await backend.delete(key, opts);
        await this.emit({ op: 'delete', keys: [key], backend: backendName, source: 'context.memory' });
    }

    /**
     * Delete multiple memory entries from the selected backend
     * @param input Pattern string or query object
     * @param options Optional query options including backend override
     * @returns Number of entries deleted
     */
    // Legacy deleteMany removed in favor of remove

    /**
     * Remove multiple memory entries from the selected backend using facade semantics
     * @param input Tag/filters/limit-style query object or pattern string (temporary support)
     * @param options Optional query options including backend override
     * @returns Number of entries removed
     */
    async remove(input: GetManyInput, options?: GetManyOptions): Promise<number> {
        const backendName = options?.backend ?? this.defaultBackend;
        const backend = this.backends[backendName] as FacadeSemanticMemoryBackend;
        const removed = await (backend.remove?.(input, options) ?? Promise.resolve(0));
        await this.emit({ op: 'delete', keys: keysFromInput(input), backend: backendName, source: 'context.memory' });
        return removed;
    }


    /**
     * Get entity management interface from the default backend
     */
    get entities() {
        const backend = this.backends[this.defaultBackend];
        return backend.entities;
    }

    /**
     * Recognize if candidate data matches existing memory entries
     * @param candidateData The data to check for recognition
     * @param options Recognition options
     */
    async recognize<T>(candidateData: T, options?: RecognitionOptions): Promise<RecognitionResult<T>> {
        const backendName = options?.entities?.backend ?? this.defaultBackend;
        const backend = this.backends[backendName];
        return backend.recognize<T>(candidateData, options);
    }

    /**
     * Enrich memory data by consolidating multiple sources
     * @param key The memory key to enrich
     * @param additionalData Array of additional data to consolidate
     * @param options Enrichment options
     */
    async enrich<T>(key: string, additionalData: T[], options?: EnrichmentOptions): Promise<EnrichmentResult<T>> {
        const optionsWithBackend = options as EnrichmentOptions & { backend?: string };
        const backendName = optionsWithBackend.backend ?? this.defaultBackend;
        const backend = this.backends[backendName] as FacadeSemanticMemoryBackend;
        if (!backend.enrich) {
            throw new Error('Enrichment not available on selected semantic memory backend');
        }
        return backend.enrich<T>(key, additionalData, options);
    }
} 
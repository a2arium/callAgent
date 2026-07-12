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
    EnrichmentResult,
    SemanticAtomicCapability,
    SemanticCompareAndSetInput,
    SemanticCompareAndSetOptions,
    SemanticAddInput as PublicSemanticAddInput,
    SemanticItem,
    SemanticReadFilter,
    SemanticRemoveFilter,
    SemanticPredicateFilter
} from '@a2arium/callagent-types';

export type SemanticMemoryEvent = {
    op: 'read' | 'write' | 'delete';
    keys: string[];
    backend?: string;
    source: 'context.memory';
};

export type FacadeSemanticAddInput = {
    id: string;
    value?: unknown;
    data?: unknown;
    tags?: string[];
    entities?: MemorySetOptions['entities'];
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
        private eventSink?: (event: SemanticMemoryEvent) => Promise<void> | void,
        private taskContext?: unknown
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

    /** Return the real atomic capability bound to the selected backend, if supported. */
    getAtomic(opts?: { backend?: string }): SemanticAtomicCapability | undefined {
        const backendName = opts?.backend ?? this.defaultBackend;
        const backend = this.backends[backendName];
        if (!backend) throw new Error(`No such backend: ${backendName}`);
        if (!backend.atomic) return undefined;

        const atomic = backend.atomic;
        return {
            getVersioned: async <T>(key: string) => {
                const result = await atomic.getVersioned<T>(key);
                await this.emit({ op: 'read', keys: [key], backend: backendName, source: 'context.memory' });
                return result;
            },
            compareAndSet: async <T>(input: SemanticCompareAndSetInput<T>, options?: SemanticCompareAndSetOptions) => {
                const result = await atomic.compareAndSet<T>(input, options);
                if (result.status === 'updated') {
                    await this.emit({ op: 'write', keys: [input.key], backend: backendName, source: 'context.memory' });
                }
                return result;
            },
        };
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
     * High-level agent API for semantic writes.
     * Kept in parity with createMemoryRegistry so ctx.memory.semantic.add()
     * persists and is visible to operator memory telemetry.
     */
    async add(item: FacadeSemanticAddInput | PublicSemanticAddInput, opts?: MemorySetOptions): Promise<void> {
        const value = item.value !== undefined
            ? item.value
            : ('data' in item ? item.data : undefined);
        await this.set(item.id, value, {
            ...opts,
            tags: opts?.tags ?? item.tags,
            entities: opts?.entities ?? item.entities,
            backend: opts?.backend ?? ('backend' in item ? item.backend : undefined),
        });
    }

    async readItems(filter?: SemanticReadFilter): Promise<SemanticItem[]> {
        if (filter?.id) {
            const ids = Array.isArray(filter.id) ? filter.id : [filter.id];
            const results: SemanticItem[] = [];
            for (const id of ids) {
                const value = await this.get<unknown>(id, { backend: filter.backend });
                if (value !== null && value !== undefined) results.push({ id, value });
            }
            return typeof filter.limit === 'number' ? results.slice(0, filter.limit) : results;
        }

        const query: Record<string, unknown> = {};
        if (filter?.tag) query.tag = filter.tag;
        if (filter?.filters) query.filters = filter.filters;
        if (filter?.limit !== undefined) query.limit = filter.limit;
        if (filter?.orderBy) query.orderBy = filter.orderBy;
        if (filter?.random !== undefined) query.random = filter.random;

        const rawResults = await this.read<unknown>(Object.keys(query).length > 0 ? query as GetManyInput : '*', {
            backend: filter?.backend,
            limit: filter?.limit,
            orderBy: filter?.orderBy,
            random: filter?.random,
        });
        const mapped = rawResults.map((item: MemoryQueryResult<unknown> & Partial<SemanticItem>) => ({
            id: item.key ?? item.id!,
            value: item.value,
            tags: item.tags,
            entities: item.entities,
        }));
        if (filter?.tags?.length && !filter.tag) {
            return mapped.filter((item) => filter.tags!.every((tag) => item.tags?.includes(tag)));
        }
        return mapped;
    }

    async removeItem(idOrFilter: string | SemanticRemoveFilter | SemanticPredicateFilter): Promise<void> {
        try {
            await this.removeItemUnchecked(idOrFilter);
        } catch {
            // Preserve the existing high-level facade's best-effort remove behavior.
        }
    }

    private async removeItemUnchecked(idOrFilter: string | SemanticRemoveFilter | SemanticPredicateFilter): Promise<void> {
        if (typeof idOrFilter === 'string') {
            await this.delete(idOrFilter);
            return;
        }
        if (typeof idOrFilter === 'function') {
            const all = await this.read<unknown>('*');
            for (const rawItem of all) {
                const item: SemanticItem = {
                    id: rawItem.key,
                    value: rawItem.value,
                    tags: (rawItem as MemoryQueryResult<unknown> & Partial<SemanticItem>).tags,
                    entities: (rawItem as MemoryQueryResult<unknown> & Partial<SemanticItem>).entities,
                };
                if (idOrFilter(item)) await this.delete(item.id);
            }
            return;
        }
        const query: Record<string, unknown> = {};
        if (idOrFilter.tag) query.tag = idOrFilter.tag;
        if (idOrFilter.filters) query.filters = idOrFilter.filters;
        if (idOrFilter.limit !== undefined) query.limit = idOrFilter.limit;
        if (Object.keys(query).length > 0) await this.remove(query as GetManyInput);
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
        return backend.recognize<T>(candidateData, {
            ...options,
            taskContext: options?.taskContext ?? this.taskContext,
        });
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
        return backend.enrich<T>(key, additionalData, {
            ...options,
            taskContext: options?.taskContext ?? this.taskContext,
        });
    }
} 

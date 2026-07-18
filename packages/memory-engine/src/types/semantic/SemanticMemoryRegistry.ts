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
    SemanticPredicateFilter,
    SemanticRemoveResult,
    SemanticQueryError,
    SemanticQueryTelemetry,
    SEMANTIC_QUERY_EXECUTION_OBSERVER,
    SemanticQueryExecutionStats,
} from '@a2arium/callagent-types';
import {
    normalizeRequiredTags,
    normalizeStoredTags,
    SEMANTIC_TAG_LIMITS,
} from '@a2arium/callagent-utils';

export type SemanticMemoryEvent = {
    op: 'read' | 'write' | 'delete';
    keys: string[];
    query?: SemanticQueryTelemetry;
    resultKeys?: string[];
    resultCount?: number;
    status?: 'success' | 'failure';
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

const ENTITY_OPERATORS = new Set(['ENTITY_FUZZY', 'ENTITY_EXACT', 'ENTITY_ALIAS']);

function backendKind(name: string, backend?: SemanticMemoryBackend): SemanticQueryTelemetry['backendKind'] {
    if (backend?.capabilities?.backendKind) return backend.capabilities.backendKind;
    if (name === 'sql') return 'sql';
    if (name === 'mlo') return 'mlo';
    return 'custom';
}

function validateLimit(limit: unknown): number {
    const resolved = limit === undefined ? SEMANTIC_TAG_LIMITS.defaultQueryLimit : limit;
    if (!Number.isFinite(resolved) || !Number.isInteger(resolved) || (resolved as number) < 0 || (resolved as number) > SEMANTIC_TAG_LIMITS.maxQueryLimit) {
        throw new SemanticQueryError('SEMANTIC_QUERY_LIMIT_INVALID', 'Semantic-memory query limit is invalid', {
            details: { maxQueryLimit: SEMANTIC_TAG_LIMITS.maxQueryLimit },
        });
    }
    return resolved as number;
}

function hasEntityFilters(filters: readonly unknown[]): boolean {
    return filters.some((filter) => {
        if (typeof filter === 'string') return /\bENTITY_(FUZZY|EXACT|ALIAS)\b/.test(filter);
        if (!filter || typeof filter !== 'object') return false;
        return ENTITY_OPERATORS.has(String((filter as { operator?: unknown }).operator));
    });
}

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
    private static compatibilityWarnings = new Set<string>();
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

    private warnCompatibility(
        path: 'legacy-object-remove' | 'predicate-remove',
        backendName: string,
        backend?: SemanticMemoryBackend
    ): void {
        const kind = backendKind(backendName, backend);
        const warningKey = `${path}:${kind}`;
        if (SemanticMemoryRegistry.compatibilityWarnings.has(warningKey)) return;
        SemanticMemoryRegistry.compatibilityWarnings.add(warningKey);
        console.warn(`Deprecated semantic-memory ${path} compatibility path used for a ${kind} backend; use removeItems() for atomic removal.`);
    }

    private async emitCompatibility(
        path: 'legacy-object-remove' | 'predicate-remove',
        backendName: string,
        backend: SemanticMemoryBackend,
        outcome: 'ok' | 'error',
        errorCode?: string
    ): Promise<void> {
        await this.emit({
            op: 'delete',
            keys: [],
            resultCount: 0,
            status: outcome === 'ok' ? 'success' : 'failure',
            backend: backendName,
            source: 'context.memory',
            query: {
                operation: 'remove',
                backendKind: backendKind(backendName, backend),
                queryMode: 'structured',
                requiredTagCount: 0,
                hasFilters: false,
                hasEntityFilters: false,
                random: false,
                requestedLimit: 0,
                resultCount: 0,
                durationMs: 0,
                outcome,
                compatibilityPath: path,
                ...(errorCode ? { errorCode } : {}),
            },
        });
    }

    private resolveBackend(requestedName?: string): { backendName: string; backend: SemanticMemoryBackend } {
        const backendName = requestedName ?? this.defaultBackend;
        const backend = this.backends[backendName];
        if (!backend) {
            throw new SemanticQueryError('SEMANTIC_BACKEND_NOT_FOUND', `No such backend: ${backendName}`, {
                details: { backendKind: backendKind(backendName) },
            });
        }
        return { backendName, backend };
    }

    private requireMethod<K extends 'get' | 'read' | 'set' | 'delete' | 'remove' | 'recognize' | 'enrich'>(
        backendName: string,
        backend: SemanticMemoryBackend,
        method: K
    ): NonNullable<SemanticMemoryBackend[K]> {
        const candidate = backend[method];
        if (typeof candidate !== 'function') {
            throw new SemanticQueryError('SEMANTIC_BACKEND_METHOD_UNAVAILABLE', `Semantic memory backend does not support ${method}`, {
                details: { backendKind: backendKind(backendName, backend), operation: method },
            });
        }
        return candidate.bind(backend) as NonNullable<SemanticMemoryBackend[K]>;
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
        this.resolveBackend(name);
        this.defaultBackend = name;
    }

    /** Return the real atomic capability bound to the selected backend, if supported. */
    getAtomic(opts?: { backend?: string }): SemanticAtomicCapability | undefined {
        const { backendName, backend } = this.resolveBackend(opts?.backend);
        if (!backend.atomic) return undefined;

        const atomic = backend.atomic;
        return {
            getVersioned: async <T>(key: string) => {
                const result = await atomic.getVersioned<T>(key);
                await this.emit({ op: 'read', keys: [key], backend: backendName, source: 'context.memory' });
                return result;
            },
            compareAndSet: async <T>(input: SemanticCompareAndSetInput<T>, options?: SemanticCompareAndSetOptions) => {
                const normalizedOptions = options?.tags === undefined
                    ? options
                    : { ...options, tags: normalizeStoredTags(options.tags) };
                const result = await atomic.compareAndSet<T>(input, normalizedOptions);
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
        const { backendName, backend } = this.resolveBackend(opts?.backend);
        const get = this.requireMethod(backendName, backend, 'get');
        const result = await get<T>(key, opts);
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
        const { backendName, backend } = this.resolveBackend(opts?.backend);
        const normalizedOptions = opts?.tags === undefined
            ? opts
            : { ...opts, tags: normalizeStoredTags(opts.tags) };
        const set = this.requireMethod(backendName, backend, 'set');
        await set<T>(key, value, normalizedOptions);
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

    async readItems<T = unknown>(filter?: SemanticReadFilter): Promise<SemanticItem<T>[]> {
        if (filter?.id) {
            if (filter.tag !== undefined || filter.tags !== undefined || filter.filters !== undefined || filter.orderBy !== undefined || filter.random !== undefined) {
                throw new SemanticQueryError('SEMANTIC_QUERY_INVALID_COMBINATION', 'Exact semantic-memory reads cannot include collection predicates');
            }
            const limit = validateLimit(filter.limit);
            const ids = Array.isArray(filter.id) ? filter.id : [filter.id];
            const { backendName, backend } = this.resolveBackend(filter.backend);
            const startedAt = Date.now();
            const telemetryBase = {
                operation: 'read' as const,
                backendKind: backendKind(backendName, backend),
                queryMode: 'id' as const,
                requiredTagCount: 0,
                hasFilters: false,
                hasEntityFilters: false,
                random: false,
                requestedLimit: limit,
            };
            if (limit === 0) {
                await this.emit({
                    op: 'read', keys: ids, resultKeys: [], resultCount: 0, status: 'success', backend: backendName, source: 'context.memory',
                    query: { ...telemetryBase, resultCount: 0, durationMs: 0, outcome: 'ok' },
                });
                return [];
            }
            const results: SemanticItem<T>[] = [];
            try {
                const get = this.requireMethod(backendName, backend, 'get');
                for (const id of ids) {
                    const value = await get<T>(id, { backend: filter.backend });
                    if (value !== null && value !== undefined) results.push({ id, value });
                    if (results.length >= limit) break;
                }
                await this.emit({
                    op: 'read', keys: ids, resultKeys: results.map((item) => item.id), resultCount: results.length,
                    status: 'success', backend: backendName, source: 'context.memory',
                    query: { ...telemetryBase, resultCount: results.length, durationMs: Date.now() - startedAt, outcome: 'ok' },
                });
                return results;
            } catch (error) {
                await this.emit({
                    op: 'read', keys: ids, resultCount: 0, status: 'failure', backend: backendName, source: 'context.memory',
                    query: {
                        ...telemetryBase, resultCount: 0, durationMs: Date.now() - startedAt, outcome: 'error',
                        ...(error instanceof SemanticQueryError ? { errorCode: error.code } : {}),
                    },
                });
                throw error;
            }
        }

        if (filter?.orderBy && filter.random) {
            throw new SemanticQueryError('SEMANTIC_QUERY_INVALID_COMBINATION', 'Semantic-memory orderBy and random cannot be combined');
        }
        if (filter?.orderBy && !['createdAt', 'updatedAt'].includes(filter.orderBy.path)) {
            throw new SemanticQueryError('SEMANTIC_QUERY_INVALID_COMBINATION', 'Semantic-memory order path is unsupported');
        }

        const limit = validateLimit(filter?.limit);
        const { requiredTags } = normalizeRequiredTags(filter ?? {});
        const { backendName, backend } = this.resolveBackend(filter?.backend);
        const startedAt = Date.now();
        const telemetryBase = {
            operation: 'read' as const,
            backendKind: backendKind(backendName, backend),
            queryMode: 'structured' as const,
            requiredTagCount: requiredTags.length,
            hasFilters: Boolean(filter?.filters?.length),
            hasEntityFilters: hasEntityFilters(filter?.filters ?? []),
            random: filter?.random === true,
            requestedLimit: limit,
        };
        if (requiredTags.length > 1 && backend.capabilities?.tagQuery?.allOf !== true) {
            const error = new SemanticQueryError('SEMANTIC_TAG_QUERY_UNSUPPORTED', 'Selected semantic-memory backend does not support all-of tag queries', {
                details: { backendKind: backendKind(backendName, backend), requiredTagCount: requiredTags.length },
            });
            await this.emit({
                op: 'read', keys: [], resultCount: 0, status: 'failure', backend: backendName, source: 'context.memory',
                query: { ...telemetryBase, resultCount: 0, durationMs: Date.now() - startedAt, outcome: 'error', errorCode: error.code },
            });
            throw error;
        }

        const query: Record<string, unknown> = { limit };
        if (requiredTags.length > 0) {
            if (backend.capabilities?.tagQuery?.allOf === true) query.tags = [...requiredTags];
            else query.tag = requiredTags[0];
        }
        if (filter?.filters) query.filters = [...filter.filters];
        if (filter?.orderBy) query.orderBy = { ...filter.orderBy };
        if (filter?.random !== undefined) query.random = filter.random;

        let executionStats: SemanticQueryExecutionStats = {};
        if (limit === 0) {
            await this.emit({
                op: 'read', keys: [], resultKeys: [], resultCount: 0, status: 'success', backend: backendName, source: 'context.memory',
                query: { ...telemetryBase, resultCount: 0, durationMs: 0, outcome: 'ok' },
            });
            return [];
        }

        try {
            const read = this.requireMethod(backendName, backend, 'read');
            const rawResults = await read<T>(query as GetManyInput, {
                backend: backendName,
                limit,
                orderBy: filter?.orderBy,
                random: filter?.random,
                [SEMANTIC_QUERY_EXECUTION_OBSERVER]: (stats) => { executionStats = { ...executionStats, ...stats }; },
            });
            const mapped = rawResults.map((item) => ({
                id: item.key,
                value: item.value,
                tags: item.tags,
                entities: item.entities,
            }));
            await this.emit({
                op: 'read', keys: [], resultKeys: mapped.map((item) => item.id), resultCount: mapped.length,
                status: 'success', backend: backendName, source: 'context.memory',
                query: { ...telemetryBase, ...executionStats, resultCount: mapped.length, durationMs: Date.now() - startedAt, outcome: 'ok' },
            });
            return mapped;
        } catch (error) {
            await this.emit({
                op: 'read', keys: [], resultCount: 0, status: 'failure', backend: backendName, source: 'context.memory',
                query: {
                    ...telemetryBase, ...executionStats, resultCount: 0, durationMs: Date.now() - startedAt, outcome: 'error',
                    ...(error instanceof SemanticQueryError ? { errorCode: error.code } : {}),
                },
            });
            throw error;
        }
    }

    async removeItems(filter: SemanticRemoveFilter): Promise<SemanticRemoveResult> {
        if (filter.orderBy && !['createdAt', 'updatedAt'].includes(filter.orderBy.path)) {
            throw new SemanticQueryError('SEMANTIC_QUERY_INVALID_COMBINATION', 'Semantic-memory removal order path is unsupported');
        }
        const limit = validateLimit(filter.limit);
        const { requiredTags } = normalizeRequiredTags(filter);
        if (requiredTags.length === 0 && !filter.filters?.length) {
            throw new SemanticQueryError('SEMANTIC_QUERY_INVALID_COMBINATION', 'Semantic-memory removeItems requires a tag or structured filter');
        }
        const { backendName, backend } = this.resolveBackend(filter.backend);
        const startedAt = Date.now();
        const telemetryBase = {
            operation: 'remove' as const,
            backendKind: backendKind(backendName, backend),
            queryMode: 'structured' as const,
            requiredTagCount: requiredTags.length,
            hasFilters: Boolean(filter.filters?.length),
            hasEntityFilters: hasEntityFilters(filter.filters ?? []),
            random: false,
            requestedLimit: limit,
        };
        const capability = backend.capabilities?.predicateRemoval;
        if (
            !capability?.predicateRechecked
            || !capability.returnsCount
            || (requiredTags.length > 0 && !capability.allOfTags)
            || (hasEntityFilters(filter.filters ?? []) && capability.entityFilters !== true)
        ) {
            const error = new SemanticQueryError('SEMANTIC_PREDICATE_REMOVE_UNSUPPORTED', 'Selected semantic-memory backend does not support strict predicate removal', {
                details: { backendKind: backendKind(backendName, backend), requiredTagCount: requiredTags.length },
            });
            await this.emit({
                op: 'delete', keys: [], resultCount: 0, status: 'failure', backend: backendName, source: 'context.memory',
                query: { ...telemetryBase, resultCount: 0, durationMs: Date.now() - startedAt, outcome: 'error', errorCode: error.code },
            });
            throw error;
        }
        if (limit === 0) {
            await this.emit({
                op: 'delete', keys: [], resultCount: 0, status: 'success', backend: backendName, source: 'context.memory',
                query: { ...telemetryBase, resultCount: 0, durationMs: 0, outcome: 'ok' },
            });
            return { removedCount: 0 };
        }

        const query: Record<string, unknown> = { limit };
        if (requiredTags.length > 0) query.tags = [...requiredTags];
        if (filter.filters) query.filters = [...filter.filters];
        if (filter.orderBy) query.orderBy = { ...filter.orderBy };
        try {
            const remove = this.requireMethod(backendName, backend, 'remove');
            const removedCount = await remove(query as GetManyInput, {
                backend: backendName,
                limit,
                orderBy: filter.orderBy,
            });
            await this.emit({
                op: 'delete', keys: [], resultCount: removedCount, status: 'success', backend: backendName, source: 'context.memory',
                query: { ...telemetryBase, resultCount: removedCount, durationMs: Date.now() - startedAt, outcome: 'ok' },
            });
            return { removedCount };
        } catch (error) {
            await this.emit({
                op: 'delete', keys: [], resultCount: 0, status: 'failure', backend: backendName, source: 'context.memory',
                query: {
                    ...telemetryBase, resultCount: 0, durationMs: Date.now() - startedAt, outcome: 'error',
                    ...(error instanceof SemanticQueryError ? { errorCode: error.code } : {}),
                },
            });
            throw error;
        }
    }

    async removeItem(id: string, options?: { backend?: string }): Promise<void>;
    async removeItem(filter: SemanticRemoveFilter): Promise<void>;
    async removeItem(predicate: SemanticPredicateFilter): Promise<void>;
    async removeItem(
        idOrFilter: string | SemanticRemoveFilter | SemanticPredicateFilter,
        options?: { backend?: string }
    ): Promise<void> {
        if (typeof idOrFilter === 'string') {
            await this.delete(idOrFilter, options);
            return;
        }
        if (typeof idOrFilter === 'function') {
            const { backendName, backend } = this.resolveBackend(this.defaultBackend);
            this.warnCompatibility('predicate-remove', backendName, backend);
            await this.emitCompatibility('predicate-remove', backendName, backend, 'ok');
            try {
                const all = await this.read<unknown>('*');
                for (const rawItem of all) {
                    const item: SemanticItem = { id: rawItem.key, value: rawItem.value, tags: rawItem.tags, entities: rawItem.entities };
                    if (idOrFilter(item)) await this.delete(item.id);
                }
            } catch (error) {
                await this.emitCompatibility(
                    'predicate-remove', backendName, backend, 'error',
                    error instanceof SemanticQueryError ? error.code : 'SEMANTIC_COMPATIBILITY_REMOVE_FAILED'
                );
                // Deprecated predicate removal intentionally preserves best-effort compatibility for one cycle.
            }
            return;
        }
        const { backendName, backend } = this.resolveBackend(idOrFilter.backend);
        if (backend.capabilities?.predicateRemoval) {
            await this.removeItems(idOrFilter);
            return;
        }
        this.warnCompatibility('legacy-object-remove', backendName, backend);
        await this.emitCompatibility('legacy-object-remove', backendName, backend, 'ok');
        try {
            const query: Record<string, unknown> = {};
            if (idOrFilter.tag) query.tag = idOrFilter.tag;
            if (idOrFilter.tags) query.tags = idOrFilter.tags;
            if (idOrFilter.filters) query.filters = idOrFilter.filters;
            if (idOrFilter.limit !== undefined) query.limit = idOrFilter.limit;
            if (Object.keys(query).length > 0) await this.remove(query as GetManyInput, { backend: idOrFilter.backend });
        } catch (error) {
            await this.emitCompatibility(
                'legacy-object-remove', backendName, backend, 'error',
                error instanceof SemanticQueryError ? error.code : 'SEMANTIC_COMPATIBILITY_REMOVE_FAILED'
            );
            // Deprecated object removal intentionally preserves legacy best-effort behavior on incapable backends.
        }
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
        const { backendName, backend } = this.resolveBackend(options?.backend);
        const read = this.requireMethod(backendName, backend, 'read');
        const result = await read<T>(input, options);
        await this.emit({ op: 'read', keys: keysFromInput(input), backend: backendName, source: 'context.memory' });
        return result;
    }


    /**
     * Delete a memory entry by key in the selected backend
     * @param key The unique identifier of the entry to delete
     * @param opts Optional backend override
     */
    async delete(key: string, opts?: { backend?: string }): Promise<void> {
        const { backendName, backend } = this.resolveBackend(opts?.backend);
        const deleteItem = this.requireMethod(backendName, backend, 'delete');
        await deleteItem(key, opts);
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
        const { backendName, backend } = this.resolveBackend(options?.backend);
        const remove = this.requireMethod(backendName, backend, 'remove');
        const removed = await remove(input, options);
        await this.emit({ op: 'delete', keys: keysFromInput(input), backend: backendName, source: 'context.memory' });
        return removed;
    }


    /**
     * Get entity management interface from the default backend
     */
    get entities() {
        const { backend } = this.resolveBackend();
        return backend.entities;
    }

    /**
     * Recognize if candidate data matches existing memory entries
     * @param candidateData The data to check for recognition
     * @param options Recognition options
     */
    async recognize<T>(candidateData: T, options?: RecognitionOptions): Promise<RecognitionResult<T>> {
        const backendName = options?.entities?.backend ?? this.defaultBackend;
        const { backend } = this.resolveBackend(backendName);
        const recognize = this.requireMethod(backendName, backend, 'recognize');
        return recognize<T>(candidateData, {
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
        const { backend: resolvedBackend } = this.resolveBackend(backendName);
        const backend = resolvedBackend as FacadeSemanticMemoryBackend;
        const enrich = this.requireMethod(backendName, backend, 'enrich');
        return enrich<T>(key, additionalData, {
            ...options,
            taskContext: options?.taskContext ?? this.taskContext,
        });
    }
} 

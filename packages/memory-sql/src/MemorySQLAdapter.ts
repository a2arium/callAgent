import { PrismaClient } from '@prisma/client';
import { SemanticMemoryBackend, MemoryQueryOptions, MemoryQueryResult, MemoryFilter, FilterOperator, MemoryError } from '@callagent/types';
import { MemorySetOptions, EntityAlignment, VectorEmbedding, GetManyInput, GetManyOptions, GetManyQuery } from './types.js';
import { EntityFieldParser } from './EntityFieldParser.js';
import { EntityAlignmentService } from './EntityAlignmentService.js';
import { addAlignedProxies } from './AlignedValueProxy.js';
import { FilterParser } from './FilterParser.js';
import { RecognitionService, EnrichmentService } from './recognition/index.js';
import { processDataForStorage, detectDataType, BinaryProcessorConfig } from './BinaryDataProcessor.js';

// Define system tenant constants locally for this adapter
const SYSTEM_TENANT = '__system__';
const DEFAULT_ENTITY_ALIGNMENT_THRESHOLD = 0.7;
const isSystemTenant = (tenantId: string): boolean => tenantId === SYSTEM_TENANT;

export class MemorySQLAdapter implements SemanticMemoryBackend {
    private entityService?: EntityAlignmentService;
    private recognitionService?: RecognitionService;
    private enrichmentService?: EnrichmentService;
    private defaultTenantId: string;
    private readonly DEFAULT_QUERY_LIMIT = 1000;

    constructor(
        private prisma: PrismaClient,
        private embedFunction?: (text: string) => Promise<number[]>,
        private options: { defaultTenantId?: string; defaultQueryLimit?: number } = {}
    ) {
        this.defaultTenantId = options.defaultTenantId || 'default';
        if (options.defaultQueryLimit) {
            (this as any).DEFAULT_QUERY_LIMIT = options.defaultQueryLimit;
        }

        if (embedFunction) {
            this.entityService = new EntityAlignmentService(prisma, embedFunction, {
                defaultThreshold: DEFAULT_ENTITY_ALIGNMENT_THRESHOLD
            });

            // Initialize recognition and enrichment services
            this.recognitionService = new RecognitionService(prisma, this.entityService);
            this.enrichmentService = new EnrichmentService();
        }
    }

    /**
     * Processes value to detect and handle binary data automatically
     * Returns processed binary data or null if no binary data detected
     */
    private async processBinaryDataIfNeeded(value: any, options: MemorySetOptions = {}): Promise<any> {
        // Check if the value contains a 'data' field that might be binary
        if (value && typeof value === 'object' && value.data) {
            const dataType = detectDataType(value.data);

            if (dataType !== 'unknown') {
                // Process the binary data
                const processed = await processDataForStorage(value.data, {
                    filename: value.filename,
                    mimeType: value.mimeType,
                    description: value.description,
                    ...value.metadata
                });

                if (processed) {
                    return {
                        originalValue: value,
                        processedData: processed,
                        shouldUseBlob: processed.buffer.length > 1024 // Use BLOB for files >1KB
                    };
                }
            }
        }

        return null;
    }

    /**
     * Stores binary data using the appropriate storage method (JSON or BLOB)
     */
    private async storeBinaryData(key: string, processedBinary: any, options: MemorySetOptions): Promise<void> {
        const tenantId = options.tenantId || this.defaultTenantId;
        const { originalValue, processedData, shouldUseBlob } = processedBinary;

        if (shouldUseBlob) {
            // Store large binary data in BYTEA fields
            await this.setBlob(key, processedData.buffer, processedData.metadata, {
                tags: options.tags || [],
                tenantId: tenantId
            });
        } else {
            // Store small binary data as Base64 in JSON
            const valueWithBase64 = {
                ...originalValue,
                data: processedData.buffer.toString('base64'),
                encoding: 'base64',
                metadata: processedData.metadata
            };

            await this.prisma.agentMemoryStore.upsert({
                where: {
                    tenantId_key: {
                        tenantId: tenantId,
                        key: key
                    }
                },
                update: {
                    value: valueWithBase64,
                    tags: options.tags || [],
                    updatedAt: new Date()
                },
                create: {
                    tenantId: tenantId,
                    key: key,
                    value: valueWithBase64,
                    tags: options.tags || [],
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            });
        }
    }

    async set(key: string, value: any, options: MemorySetOptions = {}): Promise<void> {

        const tenantId = options.tenantId || this.defaultTenantId;

        // System tenant can set across tenants by prefixing key with tenant:
        if (isSystemTenant(tenantId) && key.includes(':')) {
            const [targetTenant, actualKey] = key.split(':', 2);
            if (targetTenant && actualKey) {
                return this.set(actualKey, value, { ...options, tenantId: targetTenant });
            }
        }

        // Check if entity alignment is requested and available
        if (options.entities && this.entityService) {
            await this.setWithEntityAlignment(key, value, options);
        } else {
            await this.setRegular(key, value, options);
        }
    }

    private async setRegular(key: string, value: any, options: MemorySetOptions): Promise<void> {
        const tenantId = options.tenantId || this.defaultTenantId;

        // Check if the value contains binary data that needs processing
        const processedBinary = await this.processBinaryDataIfNeeded(value, options);

        if (processedBinary) {
            // Store binary data using blob storage
            await this.storeBinaryData(key, processedBinary, options);
        } else {
            // Regular JSON storage for non-binary data
            await this.prisma.agentMemoryStore.upsert({
                where: {
                    tenantId_key: {
                        tenantId: tenantId,
                        key: key
                    }
                },
                update: {
                    value: value,
                    tags: options.tags || [],
                    updatedAt: new Date()
                },
                create: {
                    tenantId: tenantId,
                    key: key,
                    value: value,
                    tags: options.tags || [],
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            });
        }
    }

    private async setWithEntityAlignment(key: string, value: any, options: MemorySetOptions): Promise<void> {
        if (!this.entityService || !options.entities) {
            throw new Error('Entity alignment service not available');
        }

        const tenantId = options.tenantId || this.defaultTenantId;

        // Check if the value contains binary data that needs processing
        const processedBinary = await this.processBinaryDataIfNeeded(value, options);

        if (processedBinary) {
            // Store binary data using blob storage (entity alignment not applied to binary data)
            await this.storeBinaryData(key, processedBinary, options);
        } else {
            // Regular entity alignment flow for non-binary data

            // Parse entity fields from the value using static method
            const entityFields = EntityFieldParser.parseEntityFields(value, options.entities);

            // Perform entity alignment with tenant context
            // This creates embeddings for individual entity fields only
            const alignments = await this.entityService.alignEntityFields(key, entityFields, {
                threshold: options.alignmentThreshold,
                autoCreate: options.autoCreateEntities,
                tenantId: tenantId
            });

            // Store the memory entry without content embedding
            // Only entity fields get embeddings for alignment purposes
            await this.prisma.agentMemoryStore.upsert({
                where: {
                    tenantId_key: {
                        tenantId: tenantId,
                        key: key
                    }
                },
                update: {
                    value: value,
                    tags: options.tags || [],
                    updatedAt: new Date()
                },
                create: {
                    tenantId: tenantId,
                    key: key,
                    value: value,
                    tags: options.tags || [],
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            });
        }
    }

    async get(key: string, opts?: { backend?: string; tenantId?: string }): Promise<any> {
        const tenantId = opts?.tenantId || this.defaultTenantId;

        // System tenant can query across all tenants by prefixing key with tenant:
        if (isSystemTenant(tenantId) && key.includes(':')) {
            const [targetTenant, actualKey] = key.split(':', 2);
            if (targetTenant && actualKey) {
                return this.get(actualKey, { ...opts, tenantId: targetTenant });
            }
        }

        // First check if this key has blob data
        const blobData = await this.getBlob(key, tenantId);
        if (blobData) {
            // Reconstruct the original object structure for blob data
            return {
                data: blobData.buffer,
                filename: blobData.metadata.filename,
                mimeType: blobData.metadata.mimeType,
                description: blobData.metadata.description,
                metadata: blobData.metadata,
                // Include binary data information
                size: blobData.buffer.length,
                dataType: blobData.metadata.dataType || 'buffer',
                originalUrl: blobData.metadata.originalUrl,
                downloadedAt: blobData.metadata.downloadedAt
            };
        }

        // Fall back to regular JSON storage
        const result = await this.prisma.$queryRaw<Array<{
            key: string;
            value: any;
            tags: string[];
            created_at: Date;
            updated_at: Date;
        }>>`
            SELECT key, value, tags, created_at, updated_at
            FROM agent_memory_store 
            WHERE key = ${key} AND tenant_id = ${tenantId}
        `;

        if (!result || result.length === 0) {
            return undefined;
        }

        const memory = result[0];
        let value = memory.value;

        // Handle Base64 encoded data in JSON
        if (value && typeof value === 'object' && value.encoding === 'base64' && value.data) {
            // Convert Base64 back to Buffer for consistent interface
            value = {
                ...value,
                data: Buffer.from(value.data, 'base64')
            };
        }

        // If entity service is available, add aligned proxies
        if (this.entityService) {
            const alignments = await this.getAlignmentsForMemory(key, tenantId);
            if (Object.keys(alignments).length > 0) {
                value = addAlignedProxies(value, alignments);
            }
        }

        return value;
    }

    private async getAlignmentsForMemory(memoryKey: string, tenantId?: string): Promise<Record<string, EntityAlignment>> {
        const resolvedTenantId = tenantId || this.defaultTenantId;
        const alignmentResults = await this.prisma.$queryRaw<Array<{
            field_path: string;
            entity_id: string;
            original_value: string;
            confidence: string;
            aligned_at: Date;
            canonical_name: string;
        }>>`
            SELECT 
                ea.field_path,
                ea.entity_id,
                ea.original_value,
                ea.confidence,
                ea.aligned_at,
                es.canonical_name
            FROM entity_alignment ea
            JOIN entity_store es ON ea.entity_id = es.id
            WHERE ea.memory_key = ${memoryKey} AND ea.tenant_id = ${resolvedTenantId}
        `;

        const alignments: Record<string, EntityAlignment> = {};

        for (const result of alignmentResults) {
            alignments[result.field_path] = {
                entityId: result.entity_id,
                canonicalName: result.canonical_name,
                originalValue: result.original_value,
                confidence: result.confidence as 'high' | 'medium' | 'low',
                alignedAt: result.aligned_at
            };
        }

        return alignments;
    }



    /**
     * Builds a Prisma query condition for filtering on JSON fields
     * @param filter The filter to apply on a JSON field
     * @returns A Prisma-compatible query condition
     * @private
     */
    private buildJsonFilterCondition(filter: { path: string; operator: FilterOperator; value: any }): any {
        const { path, operator, value } = filter;

        // Validate path - must be a non-empty string
        if (!path || typeof path !== 'string') {
            throw new Error('Filter path must be a non-empty string');
        }

        // Split dot notation path into array for nested JSON fields
        const pathParts = path.split('.');

        // Build the appropriate Prisma condition based on the operator
        switch (operator) {
            case '=':
                return {
                    value: {
                        path: pathParts,
                        equals: value
                    }
                };
            case '!=':
                return {
                    NOT: {
                        value: {
                            path: pathParts,
                            equals: value
                        }
                    }
                };
            case '>':
                return {
                    value: {
                        path: pathParts,
                        gt: value
                    }
                };
            case '>=':
                return {
                    value: {
                        path: pathParts,
                        gte: value
                    }
                };
            case '<':
                return {
                    value: {
                        path: pathParts,
                        lt: value
                    }
                };
            case '<=':
                return {
                    value: {
                        path: pathParts,
                        lte: value
                    }
                };
            case 'CONTAINS':
                if (typeof value !== 'string') {
                    throw new Error('CONTAINS operator requires a string value');
                }
                return {
                    value: {
                        path: pathParts,
                        string_contains: value
                    }
                };
            case 'STARTS_WITH':
                if (typeof value !== 'string') {
                    throw new Error('STARTS_WITH operator requires a string value');
                }
                return {
                    value: {
                        path: pathParts,
                        string_starts_with: value
                    }
                };
            case 'ENDS_WITH':
                if (typeof value !== 'string') {
                    throw new Error('ENDS_WITH operator requires a string value');
                }
                return {
                    value: {
                        path: pathParts,
                        string_ends_with: value
                    }
                };
            case 'ENTITY_FUZZY':
            case 'ENTITY_EXACT':
            case 'ENTITY_ALIAS':
                throw new Error(`Entity operator ${operator} should be handled by entity-aware query path, not regular JSON filtering`);
            default:
                throw new Error(`Unsupported operator: ${operator}`);
        }
    }

    async delete(key: string, opts?: { backend?: string; tenantId?: string }): Promise<void> {
        const tenantId = opts?.tenantId || this.defaultTenantId;
        // Delete memory and associated alignments
        await this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`
                DELETE FROM entity_alignment WHERE memory_key = ${key} AND tenant_id = ${tenantId}
            `;
            await tx.$executeRaw`
                DELETE FROM agent_memory_store WHERE key = ${key} AND tenant_id = ${tenantId}
            `;
        });
    }

    async deleteMany(input: GetManyInput, options?: GetManyOptions): Promise<number> {
        const tenantId = (options as any)?.tenantId || this.defaultTenantId;

        // Use getMany with unlimited results to find all matching entries
        const unlimitedOptions = {
            ...options,
            limit: Number.MAX_SAFE_INTEGER  // Remove any limit for deletion
        };
        const entriesToDelete = await this.getMany(input, unlimitedOptions);

        if (entriesToDelete.length === 0) {
            return 0;
        }

        // Extract keys for deletion
        const keysToDelete = entriesToDelete.map(entry => entry.key);

        // Delete in transaction to ensure consistency
        const deletedCount = await this.prisma.$transaction(async (tx) => {
            // Delete entity alignments for all keys
            await tx.$executeRaw`
                DELETE FROM entity_alignment 
                WHERE memory_key = ANY(${keysToDelete}::text[]) AND tenant_id = ${tenantId}
            `;

            // Delete memory entries
            const memoryDeleteResult = await tx.$executeRaw`
                DELETE FROM agent_memory_store 
                WHERE key = ANY(${keysToDelete}::text[]) AND tenant_id = ${tenantId}
            `;

            // Return the number of deleted memory entries
            return Number(memoryDeleteResult);
        });

        return deletedCount;
    }

    async clear(): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`DELETE FROM entity_alignment`;
            await tx.$executeRaw`DELETE FROM agent_memory_store`;
        });
    }

    // Entity management interface
    get entities() {
        if (!this.entityService) {
            throw new Error('Entity alignment not available. Provide an embedding function to enable entity features.');
        }

        return {
            unlink: async (memoryKey: string, fieldPath: string) => {
                await this.entityService!.unlinkEntity(memoryKey, fieldPath);
            },

            realign: async (memoryKey: string, fieldPath: string, entityId: string) => {
                await this.entityService!.forceRealign(memoryKey, fieldPath, entityId);
            },

            stats: async (entityType?: string) => {
                return await this.entityService!.getEntityStats(entityType);
            }
        };
    }

    /**
     * Unified method for retrieving multiple entries
     * Supports both pattern matching and query objects
     */
    async getMany<T>(input: GetManyInput, options?: GetManyOptions): Promise<MemoryQueryResult<T>[]> {
        if (typeof input === 'string') {
            // Pattern matching
            return await this.queryByPattern<T>(input, options);
        } else {
            // Query object - merge with options
            const mergedQuery = {
                ...input,
                limit: options?.limit ?? input.limit,
                orderBy: options?.orderBy ?? input.orderBy,
                backend: options?.backend ?? input.backend,
                tenantId: (options as any)?.tenantId ?? (input as any)?.tenantId
            };
            return await this.queryByObject<T>(mergedQuery);
        }
    }

    /**
     * Pattern matching implementation
     */
    private async queryByPattern<T>(pattern: string, options?: GetManyOptions): Promise<MemoryQueryResult<T>[]> {
        const tenantId = (options as any)?.tenantId || this.defaultTenantId;
        const limit = options?.limit ?? this.DEFAULT_QUERY_LIMIT;

        // System tenant can query across all tenants by prefixing pattern with tenant:
        if (isSystemTenant(tenantId) && pattern.includes(':')) {
            const [targetTenant, actualPattern] = pattern.split(':', 2);
            if (targetTenant && actualPattern) {
                return this.queryByPattern(actualPattern, { ...options, tenantId: targetTenant });
            }
        }

        // Convert pattern to SQL LIKE pattern
        const sqlPattern = this.convertPatternToSQL(pattern);

        let query = `
            SELECT key, value, tags
            FROM agent_memory_store 
            WHERE key LIKE $1 AND tenant_id = $2
        `;

        // Add ordering if specified
        if (options?.orderBy) {
            // For now, only support ordering by created_at/updated_at since JSON path ordering is complex
            if (options.orderBy.path === 'createdAt') {
                query += ` ORDER BY created_at ${options.orderBy.direction.toUpperCase()}`;
            } else if (options.orderBy.path === 'updatedAt') {
                query += ` ORDER BY updated_at ${options.orderBy.direction.toUpperCase()}`;
            } else {
                // For JSON path ordering, we'd need more complex SQL
                console.warn(`Ordering by JSON path '${options.orderBy.path}' not yet implemented for pattern queries`);
                query += ` ORDER BY updated_at DESC`;
            }
        } else {
            query += ` ORDER BY updated_at DESC`;
        }

        query += ` LIMIT ${limit}`;

        const results = await this.prisma.$queryRawUnsafe<Array<{
            key: string;
            value: any;
            tags: string[];
        }>>(query, sqlPattern, tenantId);

        // Add aligned proxies to results if entity service is available
        if (this.entityService) {
            for (const result of results) {
                const alignments = await this.getAlignmentsForMemory(result.key, tenantId);
                if (Object.keys(alignments).length > 0) {
                    result.value = addAlignedProxies(result.value, alignments);
                }
            }
        }

        return results.map(r => ({
            key: r.key,
            value: r.value as T
        }));
    }

    /**
     * Convert pattern with wildcards to SQL LIKE pattern
     */
    private convertPatternToSQL(pattern: string): string {
        // Escape existing SQL wildcards
        let sqlPattern = pattern.replace(/[%_]/g, '\\$&');

        // Convert our wildcards to SQL wildcards
        sqlPattern = sqlPattern.replace(/\*/g, '%');  // * becomes %
        sqlPattern = sqlPattern.replace(/\?/g, '_');  // ? becomes _

        return sqlPattern;
    }

    /**
     * Query using object parameters (existing functionality)
     */
    private async queryByObject<T>(queryObj: GetManyQuery): Promise<MemoryQueryResult<T>[]> {
        // Check for unsupported features
        if ((queryObj as any).similarityVector) {
            throw new MemoryError('Vector search is not supported yet.',
                { code: 'NOT_IMPLEMENTED' });
        }

        if (queryObj.orderBy) {
            throw new MemoryError('Sorting by JSON paths not implemented yet.',
                { code: 'NOT_IMPLEMENTED' });
        }

        try {
            // For simple queries without filters, use raw SQL for better performance with entity alignment
            if (!queryObj.filters || queryObj.filters.length === 0) {
                return await this.querySimple<T>(queryObj);
            } else {
                // For complex queries with filters, use Prisma for JSON path support
                return await this.queryWithFilters<T>(queryObj);
            }
        } catch (error: any) {
            throw new MemoryError(`Failed to query memory: ${error.message}`,
                { originalError: error, queryOptions: queryObj });
        }
    }

    private async querySimple<T>(options: GetManyQuery): Promise<MemoryQueryResult<T>[]> {
        const { tag, limit = this.DEFAULT_QUERY_LIMIT } = options;
        const tenantId = (options as any)?.tenantId || this.defaultTenantId;

        let query = `
            SELECT key, value, tags
            FROM agent_memory_store 
            WHERE tenant_id = $1
        `;
        const queryParams: any[] = [tenantId];

        if (tag) {
            query += ' AND $2 = ANY(tags)';
            queryParams.push(tag);
        }

        query += ` ORDER BY updated_at DESC LIMIT ${limit}`;

        const results = await this.prisma.$queryRawUnsafe<Array<{
            key: string;
            value: any;
            tags: string[];
        }>>(query, ...queryParams);

        // Add aligned proxies to results if entity service is available
        if (this.entityService) {
            for (const result of results) {
                const alignments = await this.getAlignmentsForMemory(result.key, tenantId);
                if (Object.keys(alignments).length > 0) {
                    result.value = addAlignedProxies(result.value, alignments);
                }
            }
        }

        return results.map(r => ({
            key: r.key,
            value: r.value as T
        }));
    }

    private async queryWithFilters<T>(options: GetManyQuery): Promise<MemoryQueryResult<T>[]> {
        const { tag, filters, limit = this.DEFAULT_QUERY_LIMIT } = options;
        const tenantId = (options as any)?.tenantId || this.defaultTenantId;

        // Check if we have entity-aware filters that require special handling
        const hasEntityFilters = filters?.some(filter => {
            if (typeof filter === 'string') {
                const parsed = FilterParser.parseFilter(filter);
                return ['ENTITY_FUZZY', 'ENTITY_EXACT', 'ENTITY_ALIAS'].includes(parsed.operator);
            }
            return ['ENTITY_FUZZY', 'ENTITY_EXACT', 'ENTITY_ALIAS'].includes(filter.operator);
        });

        if (hasEntityFilters && this.entityService) {
            return await this.queryWithEntityFilters<T>(options);
        }

        // Build Prisma query conditions
        const whereConditions: any = {
            tenantId: tenantId  // Always filter by tenant
        };

        // Handle tag filtering
        if (tag) {
            whereConditions.tags = { has: tag };
        }

        // Handle advanced JSON filtering
        if (filters && filters.length > 0) {
            try {
                // Parse string filters to object format
                const parsedFilters = FilterParser.parseFilters(filters);

                parsedFilters.forEach((filter: Exclude<MemoryFilter, string>) => {
                    const jsonCondition = this.buildJsonFilterCondition(filter);
                    whereConditions.AND = whereConditions.AND || [];
                    whereConditions.AND.push(jsonCondition);
                });
            } catch (error: any) {
                throw new MemoryError(`Invalid filter: ${error.message}`, {
                    code: 'INVALID_FILTER',
                    filters: filters
                });
            }
        }

        // Execute Prisma query
        const findOptions: any = {
            take: limit,
            orderBy: { updatedAt: 'desc' }
        };

        if (Object.keys(whereConditions).length > 0) {
            findOptions.where = whereConditions;
        }

        const results = await this.prisma.agentMemoryStore.findMany(findOptions);

        // Add aligned proxies to results if entity service is available
        const processedResults: MemoryQueryResult<T>[] = [];
        for (const result of results) {
            let value = result.value;

            if (this.entityService) {
                const alignments = await this.getAlignmentsForMemory(result.key, tenantId);
                if (Object.keys(alignments).length > 0) {
                    value = addAlignedProxies(value, alignments);
                }
            }

            processedResults.push({
                key: result.key,
                value: value as T
            });
        }

        return processedResults;
    }

    /**
     * Handle queries with entity-aware filters
     */
    private async queryWithEntityFilters<T>(options: GetManyQuery): Promise<MemoryQueryResult<T>[]> {
        const { tag, filters, limit = this.DEFAULT_QUERY_LIMIT } = options;
        const tenantId = (options as any)?.tenantId || this.defaultTenantId;

        if (!this.entityService) {
            throw new MemoryError('Entity service not available for entity-aware queries', {
                code: 'ENTITY_SERVICE_UNAVAILABLE'
            });
        }

        // Parse all filters
        const parsedFilters = FilterParser.parseFilters(filters || []);

        // Separate entity filters from regular filters
        const entityFilters = parsedFilters.filter(f =>
            ['ENTITY_FUZZY', 'ENTITY_EXACT', 'ENTITY_ALIAS'].includes(f.operator)
        );
        const regularFilters = parsedFilters.filter(f =>
            !['ENTITY_FUZZY', 'ENTITY_EXACT', 'ENTITY_ALIAS'].includes(f.operator)
        );

        // Find memory keys that match entity filters
        const entityMatchedKeys = new Set<string>();

        for (const entityFilter of entityFilters) {
            const matchedKeys = await this.findMemoryKeysByEntityFilter(
                entityFilter.path,
                entityFilter.operator as 'ENTITY_FUZZY' | 'ENTITY_EXACT' | 'ENTITY_ALIAS',
                entityFilter.value,
                tenantId
            );

            // If this is the first entity filter, add all matches
            // Otherwise, intersect with existing matches (AND logic)
            if (entityMatchedKeys.size === 0) {
                matchedKeys.forEach(key => entityMatchedKeys.add(key));
            } else {
                // Keep only keys that match both this filter and previous filters
                const intersection = new Set<string>();
                for (const key of entityMatchedKeys) {
                    if (matchedKeys.has(key)) {
                        intersection.add(key);
                    }
                }
                entityMatchedKeys.clear();
                intersection.forEach(key => entityMatchedKeys.add(key));
            }
        }

        // If no entity matches found, return empty results
        if (entityMatchedKeys.size === 0) {
            return [];
        }

        // Build query for memory records that match entity filters
        let query = `
            SELECT key, value, tags
            FROM agent_memory_store 
            WHERE tenant_id = $1 AND key = ANY($2)
        `;
        const queryParams: any[] = [tenantId, Array.from(entityMatchedKeys)];

        // Add tag filter if specified
        if (tag) {
            query += ' AND $3 = ANY(tags)';
            queryParams.push(tag);
        }

        // Add regular JSON filters if any
        if (regularFilters.length > 0) {
            // For now, we'll use a simple approach and filter in memory
            // A more sophisticated approach would build complex SQL
            console.warn('Regular filters combined with entity filters will be applied in memory - may be slower');
        }

        query += ` ORDER BY updated_at DESC LIMIT ${limit}`;

        const results = await this.prisma.$queryRawUnsafe<Array<{
            key: string;
            value: any;
            tags: string[];
        }>>(query, ...queryParams);

        // Apply regular filters in memory if needed
        let filteredResults = results;
        if (regularFilters.length > 0) {
            filteredResults = results.filter(result => {
                return regularFilters.every(filter => {
                    try {
                        return this.evaluateFilterInMemory(result.value, filter);
                    } catch {
                        return false; // Skip records that can't be evaluated
                    }
                });
            });
        }

        // Add aligned proxies to results
        const processedResults: MemoryQueryResult<T>[] = [];
        for (const result of filteredResults) {
            let value = result.value;

            const alignments = await this.getAlignmentsForMemory(result.key, tenantId);
            if (Object.keys(alignments).length > 0) {
                value = addAlignedProxies(value, alignments);
            }

            processedResults.push({
                key: result.key,
                value: value as T
            });
        }

        return processedResults;
    }

    /**
     * Find memory keys that match an entity filter
     */
    private async findMemoryKeysByEntityFilter(
        fieldPath: string,
        operator: 'ENTITY_FUZZY' | 'ENTITY_EXACT' | 'ENTITY_ALIAS',
        searchValue: string,
        tenantId: string
    ): Promise<Set<string>> {
        const matchedKeys = new Set<string>();

        // NEW: Handle array patterns
        const isArrayPattern = fieldPath.includes('[]');
        const sqlFieldPattern = isArrayPattern ?
            fieldPath.replace('[]', '[%]') :
            fieldPath;

        if (operator === 'ENTITY_FUZZY') {
            // Multi-strategy fuzzy search for better venue name matching

            // Strategy 1: Exact match (case-insensitive)
            const exactEntities = await this.prisma.$queryRaw<Array<{ id: string }>>`
                SELECT id
                FROM entity_store
                WHERE LOWER(canonical_name) = LOWER(${searchValue}) AND tenant_id = ${tenantId}
            `;

            for (const entity of exactEntities) {
                const alignedMemories = isArrayPattern ?
                    await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                        SELECT DISTINCT memory_key
                        FROM entity_alignment
                        WHERE entity_id = ${entity.id} AND field_path LIKE ${sqlFieldPattern} AND tenant_id = ${tenantId}
                    ` :
                    await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                        SELECT DISTINCT memory_key
                        FROM entity_alignment
                        WHERE entity_id = ${entity.id} AND field_path = ${fieldPath} AND tenant_id = ${tenantId}
                    `;
                alignedMemories.forEach(record => matchedKeys.add(record.memory_key));
            }

            // Strategy 2: Alias match
            const aliasEntities = await this.prisma.$queryRaw<Array<{ id: string }>>`
                SELECT id
                FROM entity_store
                WHERE ${searchValue} = ANY(aliases) AND tenant_id = ${tenantId}
            `;

            for (const entity of aliasEntities) {
                const alignedMemories = isArrayPattern ?
                    await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                        SELECT DISTINCT memory_key
                        FROM entity_alignment
                        WHERE entity_id = ${entity.id} AND field_path LIKE ${sqlFieldPattern} AND tenant_id = ${tenantId}
                    ` :
                    await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                        SELECT DISTINCT memory_key
                        FROM entity_alignment
                        WHERE entity_id = ${entity.id} AND field_path = ${fieldPath} AND tenant_id = ${tenantId}
                    `;
                alignedMemories.forEach(record => matchedKeys.add(record.memory_key));
            }

            // Strategy 3: Text similarity (normalized comparison)
            const normalizedSearch = this.normalizeForSearch(searchValue);
            const allEntities = await this.prisma.entityStore.findMany({
                where: { tenantId },
                select: { id: true, canonicalName: true, aliases: true }
            });

            for (const entity of allEntities) {
                const normalizedCanonical = this.normalizeForSearch(entity.canonicalName);

                // Check if normalized search matches canonical name or aliases
                if (this.areTextsSimilar(normalizedSearch, normalizedCanonical)) {
                    const alignedMemories = isArrayPattern ?
                        await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                            SELECT DISTINCT memory_key
                            FROM entity_alignment
                            WHERE entity_id = ${entity.id} AND field_path LIKE ${sqlFieldPattern} AND tenant_id = ${tenantId}
                        ` :
                        await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                            SELECT DISTINCT memory_key
                            FROM entity_alignment
                            WHERE entity_id = ${entity.id} AND field_path = ${fieldPath} AND tenant_id = ${tenantId}
                        `;
                    alignedMemories.forEach(record => matchedKeys.add(record.memory_key));
                }

                // Check aliases
                for (const alias of entity.aliases) {
                    const normalizedAlias = this.normalizeForSearch(alias);
                    if (this.areTextsSimilar(normalizedSearch, normalizedAlias)) {
                        const alignedMemories = isArrayPattern ?
                            await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                                SELECT DISTINCT memory_key
                                FROM entity_alignment
                                WHERE entity_id = ${entity.id} AND field_path LIKE ${sqlFieldPattern} AND tenant_id = ${tenantId}
                            ` :
                            await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                                SELECT DISTINCT memory_key
                                FROM entity_alignment
                                WHERE entity_id = ${entity.id} AND field_path = ${fieldPath} AND tenant_id = ${tenantId}
                            `;
                        alignedMemories.forEach(record => matchedKeys.add(record.memory_key));
                        break; // Avoid duplicates
                    }
                }
            }

            // Strategy 4: Embedding similarity (fallback for cases not covered by text similarity)
            if (this.embedFunction && matchedKeys.size === 0) {
                try {
                    const searchEmbedding = await this.embedFunction(searchValue);

                    const similarEntities = await this.prisma.$queryRaw<Array<{
                        id: string;
                        canonical_name: string;
                        entity_type: string;
                        similarity: number;
                    }>>`
                        SELECT 
                            id,
                            canonical_name,
                            entity_type,
                            1 - (embedding <=> ${searchEmbedding}::vector) as similarity
                        FROM entity_store 
                        WHERE tenant_id = ${tenantId}
                        ORDER BY embedding <=> ${searchEmbedding}::vector
                        LIMIT 20
                    `;

                    // Use a lower threshold for embedding similarity as a fallback
                    const threshold = 0.4;
                    const matchingEntities = similarEntities.filter(e => e.similarity > threshold);

                    for (const entity of matchingEntities) {
                        const alignedMemories = isArrayPattern ?
                            await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                                SELECT DISTINCT memory_key
                                FROM entity_alignment
                                WHERE entity_id = ${entity.id} AND field_path LIKE ${sqlFieldPattern} AND tenant_id = ${tenantId}
                            ` :
                            await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                                SELECT DISTINCT memory_key
                                FROM entity_alignment
                                WHERE entity_id = ${entity.id} AND field_path = ${fieldPath} AND tenant_id = ${tenantId}
                            `;
                        alignedMemories.forEach(record => matchedKeys.add(record.memory_key));
                    }
                } catch (error) {
                    console.warn('Embedding similarity search failed:', error);
                }
            }

        } else if (operator === 'ENTITY_EXACT') {
            // Find entities with exact canonical name match
            const exactEntities = await this.prisma.$queryRaw<Array<{ id: string }>>`
                SELECT id
                FROM entity_store
                WHERE canonical_name = ${searchValue} AND tenant_id = ${tenantId}
            `;

            // Find memory records aligned to these entities
            for (const entity of exactEntities) {
                const alignedMemories = isArrayPattern ?
                    await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                        SELECT DISTINCT memory_key
                        FROM entity_alignment
                        WHERE entity_id = ${entity.id} AND field_path LIKE ${sqlFieldPattern} AND tenant_id = ${tenantId}
                    ` :
                    await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                        SELECT DISTINCT memory_key
                        FROM entity_alignment
                        WHERE entity_id = ${entity.id} AND field_path = ${fieldPath} AND tenant_id = ${tenantId}
                    `;

                alignedMemories.forEach(record => matchedKeys.add(record.memory_key));
            }

        } else if (operator === 'ENTITY_ALIAS') {
            // Find entities where search value is in aliases array
            const aliasEntities = await this.prisma.$queryRaw<Array<{ id: string }>>`
                SELECT id
                FROM entity_store
                WHERE ${searchValue} = ANY(aliases) AND tenant_id = ${tenantId}
            `;

            // Find memory records aligned to these entities
            for (const entity of aliasEntities) {
                const alignedMemories = isArrayPattern ?
                    await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                        SELECT DISTINCT memory_key
                        FROM entity_alignment
                        WHERE entity_id = ${entity.id} AND field_path LIKE ${sqlFieldPattern} AND tenant_id = ${tenantId}
                    ` :
                    await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                        SELECT DISTINCT memory_key
                        FROM entity_alignment
                        WHERE entity_id = ${entity.id} AND field_path = ${fieldPath} AND tenant_id = ${tenantId}
                    `;

                alignedMemories.forEach(record => matchedKeys.add(record.memory_key));
            }
        }

        return matchedKeys;
    }

    /**
     * Normalize text for better search matching
     */
    private normalizeForSearch(text: string): string {
        return text
            .toLowerCase()
            .normalize('NFD')  // Decompose accented characters
            .replace(/[\u0300-\u036f]/g, '')  // Remove diacritics
            .replace(/['"''""„]/g, '')  // Remove various quote styles
            .replace(/[^\w\s]/g, ' ')  // Replace punctuation with spaces
            .replace(/\s+/g, ' ')  // Normalize whitespace
            .trim();
    }

    /**
     * Check if two normalized texts are similar using multiple strategies
     */
    private areTextsSimilar(normalized1: string, normalized2: string): boolean {
        // Strategy 1: Exact match after normalization
        if (normalized1 === normalized2) {
            return true;
        }

        // Strategy 2: Whole phrase containment (for prefix/suffix cases)
        // Only apply if both are multi-word OR both are single-word
        const words1 = normalized1.split(' ').filter(w => w.length > 0);
        const words2 = normalized2.split(' ').filter(w => w.length > 0);

        const isSingleWord1 = words1.length === 1;
        const isSingleWord2 = words2.length === 1;

        // Allow containment only if both are single words, or both are multi-word
        if ((isSingleWord1 && isSingleWord2) || (!isSingleWord1 && !isSingleWord2)) {
            if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
                return true;
            }
        }

        // Strategy 3: Core words overlap (for venue names) - but be more conservative
        const longWords1 = words1.filter(w => w.length > 2);
        const longWords2 = words2.filter(w => w.length > 2);

        // Remove common stop words
        const stopWords = ['the', 'a', 'an', 'and', 'or', 'of', 'at', 'in', 'on', 'ktmc', 'center', 'centre'];
        const coreWords1 = longWords1.filter(word => !stopWords.includes(word));
        const coreWords2 = longWords2.filter(word => !stopWords.includes(word));

        // Only apply word overlap logic if both have multiple core words
        // This prevents single words from matching multi-word entities
        if (coreWords1.length > 1 && coreWords2.length > 1) {
            // For multi-word comparisons, use flexible word matching (handles possessives, plurals)
            const overlap = coreWords1.filter(word1 =>
                coreWords2.some(word2 =>
                    word1 === word2 || word1.includes(word2) || word2.includes(word1)
                )
            );
            const minLength = Math.min(coreWords1.length, coreWords2.length);

            // Consider similar if >50% of core words overlap
            return overlap.length > 0 && overlap.length >= minLength * 0.5;
        }

        // Strategy 4: Single word containment (for possessive/plural forms)
        // This was already handled in Strategy 2, but keeping for clarity
        if (coreWords1.length === 1 && coreWords2.length === 1) {
            const word1 = coreWords1[0];
            const word2 = coreWords2[0];
            return word1.includes(word2) || word2.includes(word1);
        }

        return false;
    }

    /**
     * Evaluate a filter condition against a value in memory (for post-processing)
     */
    private evaluateFilterInMemory(value: any, filter: { path: string; operator: FilterOperator; value: any }): boolean {
        // Get the field value using JSON path
        const fieldValue = this.getValueByPath(value, filter.path);

        switch (filter.operator) {
            case '=':
                return fieldValue === filter.value;
            case '!=':
                return fieldValue !== filter.value;
            case '>':
                return fieldValue > filter.value;
            case '>=':
                return fieldValue >= filter.value;
            case '<':
                return fieldValue < filter.value;
            case '<=':
                return fieldValue <= filter.value;
            case 'CONTAINS':
                return String(fieldValue).includes(String(filter.value));
            case 'STARTS_WITH':
                return String(fieldValue).startsWith(String(filter.value));
            case 'ENDS_WITH':
                return String(fieldValue).endsWith(String(filter.value));
            default:
                return false;
        }
    }

    /**
     * Get a value from an object using a dot-notation path with automatic array traversal
     * Examples:
     * - "venue.name" → looks for obj.venue.name
     * - "titleAndDescription.title" → looks for obj.titleAndDescription[*].title (automatic array search)
     * - "sessions.speakers.name" → handles arrays at any level
     */
    private getValueByPath(obj: any, path: string): any {
        return this.getValueByPathRecursive(obj, path.split('.'), 0);
    }

    /**
     * Recursive helper for getValueByPath that handles arrays naturally
     */
    private getValueByPathRecursive(obj: any, pathParts: string[], partIndex: number): any {
        // Base case: we've processed all path parts
        if (partIndex >= pathParts.length) {
            return obj;
        }

        // Invalid current object
        if (!obj || typeof obj !== 'object') {
            return undefined;
        }

        const currentPart = pathParts[partIndex];
        const remainingParts = pathParts.slice(partIndex + 1);

        // Case 1: Direct property access (standard object navigation)
        if (currentPart in obj) {
            const value = obj[currentPart];

            // If there are more parts to traverse
            if (remainingParts.length > 0) {
                // If the value is an array, search within array elements
                if (Array.isArray(value)) {
                    return this.searchArrayForPath(value, remainingParts);
                }
                // Otherwise continue normal traversal
                return this.getValueByPathRecursive(value, pathParts, partIndex + 1);
            }

            // No more parts, return the value
            return value;
        }

        // Case 2: Current object is an array - search within array elements
        if (Array.isArray(obj)) {
            return this.searchArrayForPath(obj, pathParts.slice(partIndex));
        }

        // Case 3: Property doesn't exist
        return undefined;
    }

    /**
     * Search for a field path within an array of objects
     * Returns the first matching value found (not limited to strings like EntityFieldParser)
     */
    private searchArrayForPath(array: any[], remainingPath: string[]): any {
        for (const item of array) {
            const result = this.getValueByPathRecursive(item, remainingPath, 0);
            if (result !== undefined) {
                return result; // Return first match found
            }
        }
        return undefined;
    }

    /**
     * Recognize if a candidate object exists in memory using entity alignment and LLM disambiguation
     */
    async recognize<T>(candidateData: T, options: any = {}): Promise<any> {
        if (!this.recognitionService) {
            throw new Error('Recognition service not available. Entity alignment with embedFunction required.');
        }

        // Extract the taskContext from options
        const { taskContext, ...recognitionOptions } = options;

        if (!taskContext) {
            throw new Error('TaskContext is required for recognition');
        }

        return await this.recognitionService.recognize(candidateData, taskContext, recognitionOptions);
    }

    /**
     * Enrich a memory entry by consolidating it with additional data using LLM
     * By default, the enriched data is automatically saved back to memory.
     * Use dryRun: true to preview enrichment without saving.
     */
    async enrich<T>(key: string, additionalData: T[], options: any = {}): Promise<any> {
        if (!this.enrichmentService) {
            throw new Error('Enrichment service not available. Entity alignment with embedFunction required.');
        }

        // Extract the taskContext and dryRun from options  
        const { taskContext, dryRun = false, ...enrichmentOptions } = options;

        if (!taskContext) {
            throw new Error('TaskContext is required for enrichment');
        }

        // Get the existing data and its metadata
        const existingData = await this.get(key, { tenantId: taskContext.tenantId });

        if (!existingData) {
            throw new Error(`Memory entry with key "${key}" not found`);
        }

        // Get the original memory entry metadata (tags, etc.)
        const originalMemoryEntry = await this.prisma.$queryRaw<Array<{
            key: string;
            value: any;
            tags: string[];
            created_at: Date;
            updated_at: Date;
        }>>`
            SELECT key, value, tags, created_at, updated_at
            FROM agent_memory_store 
            WHERE key = ${key} AND tenant_id = ${taskContext.tenantId}
        `;

        const originalMetadata = originalMemoryEntry[0];

        // Get enriched data from the enrichment service
        const enrichmentResult = await this.enrichmentService.enrich(key, existingData, additionalData, taskContext, enrichmentOptions);

        // If not a dry run, save the enriched data back to memory
        if (!dryRun) {
            await this.set(key, enrichmentResult.enrichedData, {
                tenantId: taskContext.tenantId,
                // Preserve existing tags from the original memory entry
                tags: originalMetadata?.tags || []
            });
        }

        // Return the enrichment result with saved flag
        return {
            ...enrichmentResult,
            saved: !dryRun
        };
    }

    // ========================================
    // Blob Storage Methods
    // ========================================

    /**
     * Store binary data (images, files, etc.) with metadata
     * @param key The unique identifier for the blob entry
     * @param buffer Binary data to store
     * @param metadata Metadata about the blob (filename, mimeType, etc.)
     * @param options Storage options (tags, tenantId, etc.)
     */
    async setBlob(key: string, buffer: Buffer, metadata: any = {}, options: MemorySetOptions = {}): Promise<void> {
        const tenantId = options.tenantId || this.defaultTenantId;

        // Prepare blob metadata with standard fields
        const blobMetadata = {
            size: buffer.length,
            storedAt: new Date().toISOString(),
            encoding: 'binary',
            ...metadata
        };

        await this.prisma.agentMemoryStore.upsert({
            where: {
                tenantId_key: { tenantId, key }
            },
            update: {
                value: { type: 'blob', message: 'Binary data stored in blobData field' },
                blobData: buffer,
                blobMetadata: blobMetadata,
                tags: options.tags || [],
                updatedAt: new Date()
            },
            create: {
                tenantId,
                key,
                value: { type: 'blob', message: 'Binary data stored in blobData field' },
                blobData: buffer,
                blobMetadata: blobMetadata,
                tags: options.tags || []
            }
        });
    }

    /**
     * Retrieve binary data and metadata
     * @param key The unique identifier for the blob entry
     * @param tenantId Optional tenant ID override
     * @returns Object with buffer and metadata, or null if not found
     */
    async getBlob(key: string, tenantId?: string): Promise<{ buffer: Buffer; metadata: any } | null> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        const result = await this.prisma.agentMemoryStore.findUnique({
            where: {
                tenantId_key: {
                    tenantId: resolvedTenantId,
                    key
                }
            },
            select: {
                blobData: true,
                blobMetadata: true
            }
        });

        if (!result?.blobData) {
            return null;
        }

        return {
            buffer: Buffer.from(result.blobData),
            metadata: result.blobMetadata as any
        };
    }

    /**
     * Check if a key has blob data
     * @param key The unique identifier to check
     * @param tenantId Optional tenant ID override
     * @returns true if blob data exists, false otherwise
     */
    async hasBlob(key: string, tenantId?: string): Promise<boolean> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        const result = await this.prisma.agentMemoryStore.findUnique({
            where: {
                tenantId_key: {
                    tenantId: resolvedTenantId,
                    key
                }
            },
            select: {
                blobData: true
            }
        });

        return !!result?.blobData;
    }

    /**
     * Remove blob data while keeping the regular value data
     * @param key The unique identifier for the blob entry
     * @param tenantId Optional tenant ID override
     */
    async deleteBlob(key: string, tenantId?: string): Promise<void> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        await this.prisma.agentMemoryStore.update({
            where: {
                tenantId_key: {
                    tenantId: resolvedTenantId,
                    key
                }
            },
            data: {
                blobData: undefined,
                blobMetadata: undefined,
                updatedAt: new Date()
            }
        });
    }

    /**
     * Get blob metadata without the binary data (useful for listings)
     * @param key The unique identifier for the blob entry
     * @param tenantId Optional tenant ID override
     * @returns Metadata object or null if not found
     */
    async getBlobMetadata(key: string, tenantId?: string): Promise<any | null> {
        const resolvedTenantId = tenantId || this.defaultTenantId;

        const result = await this.prisma.agentMemoryStore.findUnique({
            where: {
                tenantId_key: {
                    tenantId: resolvedTenantId,
                    key
                }
            },
            select: {
                blobMetadata: true
            }
        });

        return result?.blobMetadata as any || null;
    }

    /**
     * List all blob entries for a tenant (returns metadata only, not binary data)
     * @param tenantId Optional tenant ID override
     * @param options Query options (limit, tags, etc.)
     * @returns Array of blob entries with metadata
     */
    async listBlobs(tenantId?: string, options: { limit?: number; tags?: string[] } = {}): Promise<Array<{
        key: string;
        metadata: any;
        tags: string[];
        createdAt: Date;
        updatedAt: Date;
    }>> {
        const resolvedTenantId = tenantId || this.defaultTenantId;
        const { limit = 100, tags } = options;

        const whereClause: any = {
            tenantId: resolvedTenantId,
            blobData: { not: null }
        };

        if (tags && tags.length > 0) {
            whereClause.tags = { hasSome: tags };
        }

        const results = await this.prisma.agentMemoryStore.findMany({
            where: whereClause,
            select: {
                key: true,
                blobMetadata: true,
                tags: true,
                createdAt: true,
                updatedAt: true
            },
            take: limit,
            orderBy: { updatedAt: 'desc' }
        });

        return results.map(result => ({
            key: result.key,
            metadata: result.blobMetadata as any,
            tags: result.tags,
            createdAt: result.createdAt,
            updatedAt: result.updatedAt
        }));
    }
} 
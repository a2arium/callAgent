import { PrismaClient } from '@prisma/client';
import { SemanticMemoryBackend, MemoryQueryOptions, MemoryQueryResult, MemoryFilter, FilterOperator, MemoryError } from '@callagent/types';
import { MemorySetOptions, EntityAlignment, VectorEmbedding, GetManyInput, GetManyOptions, GetManyQuery } from './types.js';
import { EntityFieldParser } from './EntityFieldParser.js';
import { EntityAlignmentService } from './EntityAlignmentService.js';
import { addAlignedProxies } from './AlignedValueProxy.js';
import { FilterParser } from './FilterParser.js';

export class MemorySQLAdapter implements SemanticMemoryBackend {
    private entityService?: EntityAlignmentService;

    constructor(
        private prisma: PrismaClient,
        private embedFunction?: (text: string) => Promise<number[]>
    ) {
        if (embedFunction) {
            this.entityService = new EntityAlignmentService(prisma, embedFunction);
        }
    }

    async set(key: string, value: any, options: MemorySetOptions = {}): Promise<void> {
        // Check if entity alignment is requested and available
        if (options.entities && this.entityService) {
            await this.setWithEntityAlignment(key, value, options);
        } else {
            await this.setRegular(key, value, options);
        }
    }

    private async setRegular(key: string, value: any, options: MemorySetOptions): Promise<void> {
        // Generate embedding for the entire value if embedding function is available
        let embedding: VectorEmbedding = null;
        if (this.embedFunction) {
            try {
                const text = typeof value === 'string' ? value : JSON.stringify(value);
                embedding = await this.embedFunction(text);
            } catch (error) {
                console.warn('Failed to generate embedding:', error);
                embedding = null;
            }
        }

        // Use raw SQL to handle vector type properly
        const embeddingLiteral = embedding ? `'[${embedding.join(',')}]'::vector` : 'NULL';
        await this.prisma.$executeRawUnsafe(`
            INSERT INTO agent_memory_store (key, value, tags, embedding, created_at, updated_at)
            VALUES (
                $1,
                $2::jsonb,
                $3::text[],
                ${embeddingLiteral},
                NOW(),
                NOW()
            )
            ON CONFLICT (key) 
            DO UPDATE SET 
                value = EXCLUDED.value,
                tags = EXCLUDED.tags,
                embedding = EXCLUDED.embedding,
                updated_at = NOW()
        `, key, JSON.stringify(value), options.tags || []);
    }

    private async setWithEntityAlignment(key: string, value: any, options: MemorySetOptions): Promise<void> {
        if (!this.entityService || !options.entities) {
            throw new Error('Entity alignment service not available');
        }

        // Parse entity fields from the value using static method
        const entityFields = EntityFieldParser.parseEntityFields(value, options.entities);

        // Perform entity alignment
        const alignments = await this.entityService.alignEntityFields(key, entityFields, {
            threshold: options.alignmentThreshold,
            autoCreate: options.autoCreateEntities
        });

        // Generate embedding for the entire value
        let embedding: VectorEmbedding = null;
        if (this.embedFunction) {
            try {
                const text = typeof value === 'string' ? value : JSON.stringify(value);
                embedding = await this.embedFunction(text);
            } catch (error) {
                console.warn('Failed to generate embedding:', error);
                embedding = null;
            }
        }

        // Store the memory entry with embedding
        const embeddingLiteral = embedding ? `'[${embedding.join(',')}]'::vector` : 'NULL';
        await this.prisma.$executeRawUnsafe(`
            INSERT INTO agent_memory_store (key, value, tags, embedding, created_at, updated_at)
            VALUES (
                $1,
                $2::jsonb,
                $3::text[],
                ${embeddingLiteral},
                NOW(),
                NOW()
            )
            ON CONFLICT (key) 
            DO UPDATE SET 
                value = EXCLUDED.value,
                tags = EXCLUDED.tags,
                embedding = EXCLUDED.embedding,
                updated_at = NOW()
        `, key, JSON.stringify(value), options.tags || []);
    }

    async get(key: string): Promise<any> {
        const result = await this.prisma.$queryRaw<Array<{
            key: string;
            value: any;
            tags: string[];
            created_at: Date;
            updated_at: Date;
        }>>`
            SELECT key, value, tags, created_at, updated_at
            FROM agent_memory_store 
            WHERE key = ${key}
        `;

        if (result.length === 0) {
            return undefined;
        }

        const memory = result[0];
        let value = memory.value;

        // If entity service is available, add aligned proxies
        if (this.entityService) {
            const alignments = await this.getAlignmentsForMemory(key);
            if (Object.keys(alignments).length > 0) {
                value = addAlignedProxies(value, alignments);
            }
        }

        return value;
    }

    private async getAlignmentsForMemory(memoryKey: string): Promise<Record<string, EntityAlignment>> {
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
            WHERE ea.memory_key = ${memoryKey}
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
    private buildJsonFilterCondition(filter: Exclude<MemoryFilter, string>): any {
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
            default:
                throw new Error(`Unsupported operator: ${operator}`);
        }
    }

    async delete(key: string): Promise<void> {
        // Delete memory and associated alignments
        await this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`
                DELETE FROM entity_alignment WHERE memory_key = ${key}
            `;
            await tx.$executeRaw`
                DELETE FROM agent_memory_store WHERE key = ${key}
            `;
        });
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
                backend: options?.backend ?? input.backend
            };
            return await this.queryByObject<T>(mergedQuery);
        }
    }

    /**
     * Pattern matching implementation
     */
    private async queryByPattern<T>(pattern: string, options?: GetManyOptions): Promise<MemoryQueryResult<T>[]> {
        // Convert pattern to SQL LIKE pattern
        const sqlPattern = this.convertPatternToSQL(pattern);

        const limit = options?.limit ?? 100;

        let query = `
            SELECT key, value, tags
            FROM agent_memory_store 
            WHERE key LIKE $1
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
        }>>(query, sqlPattern);

        // Add aligned proxies to results if entity service is available
        if (this.entityService) {
            for (const result of results) {
                const alignments = await this.getAlignmentsForMemory(result.key);
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
        const { tag, limit = 100 } = options;

        let query = `
            SELECT key, value, tags
            FROM agent_memory_store 
        `;
        const queryParams: any[] = [];

        if (tag) {
            query += ' WHERE $1 = ANY(tags)';
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
                const alignments = await this.getAlignmentsForMemory(result.key);
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
        const { tag, filters, limit = 100 } = options;

        // Build Prisma query conditions
        const whereConditions: any = {};

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
                const alignments = await this.getAlignmentsForMemory(result.key);
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
} 
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import {
    MemoryQueryOptions,
    MemoryQueryResult,
    MemoryFilter,
    MemoryError
} from '@callagent/types';

/**
 * PostgreSQL implementation of the IMemory interface using Prisma ORM
 * Provides durable, SQL-backed storage for agent memory
 */
export class MemorySQLAdapter {
    /**
     * Creates a new MemorySQLAdapter
     * @param prisma Injected PrismaClient instance
     */
    constructor(private prisma: PrismaClient) { }

    /**
     * Retrieves a memory entry by key
     * @param key The unique identifier for the memory entry
     * @returns The stored value or null if not found
     */
    async get<T>(key: string): Promise<T | null> {
        try {
            const result = await this.prisma.agentMemoryStore.findUnique({
                where: { key }
            });
            return result ? (result.value as T) : null;
        } catch (error: any) {
            throw new MemoryError(`Failed to get key '${key}': ${error.message}`, { originalError: error });
        }
    }

    /**
     * Stores a memory entry with an associated key
     * @param key The unique identifier for the memory entry
     * @param value The data to store
     * @param options Optional settings like tags
     */
    async set<T>(key: string, value: T, options?: { tags?: string[] }): Promise<void> {
        const data = {
            key,
            value: value as any, // Prisma handles JSON serialization
            tags: options?.tags ?? [],
        };
        try {
            await this.prisma.agentMemoryStore.upsert({
                where: { key },
                create: data,
                update: { value: data.value, tags: data.tags }, // Only update value/tags
            });
        } catch (error: any) {
            throw new MemoryError(`Failed to set key '${key}': ${error.message}`, { originalError: error });
        }
    }

    /**
     * Deletes a memory entry by key
     * @param key The unique identifier of the entry to delete
     */
    async delete(key: string): Promise<void> {
        try {
            await this.prisma.agentMemoryStore.delete({ where: { key } });
        } catch (error: any) {
            if (
                (error instanceof PrismaClientKnownRequestError && error.code === 'P2025') ||
                (error && error.name === 'PrismaClientKnownRequestError' && error.code === 'P2025')
            ) {
                return;
            }
            throw new MemoryError(`Failed to delete key '${key}': ${error.message}`, { originalError: error });
        }
    }

    /**
     * Queries memory entries based on tag, similarity vector, or JSON field filters
     * @param opts Query options including tag, similarity vector, filters, and/or limit
     * @returns Array of matching key/value entries
     */
    async query<T>(opts: MemoryQueryOptions): Promise<MemoryQueryResult<T>[]> {
        if (opts.similarityVector) {
            throw new MemoryError('Vector search is not supported by this adapter version.',
                { code: 'NOT_IMPLEMENTED' });
        }

        const findOptions: Prisma.AgentMemoryStoreFindManyArgs = {};

        if (opts.limit) {
            findOptions.take = opts.limit;
        }

        // Start building the where conditions
        const whereConditions: any = {};

        // Handle tag filtering
        if (opts.tag) {
            // Prisma `has` checks if array contains the element
            whereConditions.tags = { has: opts.tag };
        }

        // Handle advanced JSON filtering
        if (opts.filters && opts.filters.length > 0) {
            try {
                opts.filters.forEach((filter: MemoryFilter) => {
                    const jsonCondition = this.buildJsonFilterCondition(filter);
                    whereConditions.AND = whereConditions.AND || [];
                    whereConditions.AND.push(jsonCondition);
                });
            } catch (error: any) {
                throw new MemoryError(`Invalid filter: ${error.message}`, {
                    code: 'INVALID_FILTER',
                    filters: opts.filters
                });
            }
        }

        // Apply all where conditions
        if (Object.keys(whereConditions).length > 0) {
            findOptions.where = whereConditions;
        }

        // Handle sorting
        if (opts.orderBy) {
            // Note: Sorting by JSON paths requires specific DB implementation
            throw new MemoryError('Sorting by JSON paths not implemented yet.',
                { code: 'NOT_IMPLEMENTED' });
        }

        try {
            const results = await this.prisma.agentMemoryStore.findMany(findOptions);
            return results.map((r: { key: string; value: unknown }) => ({
                key: r.key,
                value: r.value as T
            }));
        } catch (error: any) {
            throw new MemoryError(`Failed to query memory: ${error.message}`,
                { originalError: error, queryOptions: opts });
        }
    }

    /**
     * Builds a Prisma query condition for filtering on JSON fields
     * @param filter The filter to apply on a JSON field
     * @returns A Prisma-compatible query condition
     * @private
     */
    private buildJsonFilterCondition(filter: MemoryFilter): any {
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

    /**
     * Queries memory entries by key patterns (supports * wildcard)
     * @param keyPattern Key pattern with * as wildcard (e.g., "user:*:profile")
     * @returns Array of matching key/value entries
     */
    async queryByKeyPattern<T>(keyPattern: string): Promise<MemoryQueryResult<T>[]> {
        try {
            // If no wildcards, use exact match
            if (!keyPattern.includes('*')) {
                const result = await this.get<T>(keyPattern);
                return result ? [{ key: keyPattern, value: result }] : [];
            }

            // For patterns with wildcards, use raw SQL for proper LIKE matching
            const sqlPattern = keyPattern.replace(/\*/g, '%');

            const results = await this.prisma.$queryRaw<Array<{ key: string; value: any }>>`
                SELECT key, value 
                FROM agent_memory_store 
                WHERE key LIKE ${sqlPattern}
            `;

            return results.map((r: { key: string; value: unknown }) => ({
                key: r.key,
                value: r.value as T
            }));
        } catch (error: any) {
            throw new MemoryError(`Failed to query keys by pattern '${keyPattern}': ${error.message}`,
                { originalError: error, keyPattern });
        }
    }

    /**
     * Advanced key pattern matching using raw SQL LIKE queries
     * @param keyPattern Key pattern with * as wildcard and ? as single character wildcard
     * @returns Array of matching key/value entries
     */
    async queryByKeyPatternAdvanced<T>(keyPattern: string): Promise<MemoryQueryResult<T>[]> {
        try {
            // Convert wildcard pattern to SQL LIKE pattern
            const sqlPattern = keyPattern
                .replace(/\*/g, '%')    // * matches any sequence of characters
                .replace(/\?/g, '_');   // ? matches any single character

            const results = await this.prisma.$queryRaw<Array<{ key: string; value: any }>>`
                SELECT key, value 
                FROM agent_memory_store 
                WHERE key LIKE ${sqlPattern}
            `;

            return results.map((r: { key: string; value: unknown }) => ({
                key: r.key,
                value: r.value as T
            }));
        } catch (error: any) {
            throw new MemoryError(`Failed to query keys by advanced pattern '${keyPattern}': ${error.message}`,
                { originalError: error, keyPattern });
        }
    }
} 
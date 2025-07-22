import { PrismaClient } from '@prisma/client';
import { SemanticMemoryBackend, MemoryQueryResult } from '@a2arium/callagent-types';
import { MemorySetOptions, GetManyInput, GetManyOptions } from './types.js';
export declare class MemorySQLAdapter implements SemanticMemoryBackend {
    private prisma;
    private embedFunction?;
    private options;
    private entityService?;
    private recognitionService?;
    private enrichmentService?;
    private defaultTenantId;
    private readonly DEFAULT_QUERY_LIMIT;
    constructor(prisma: PrismaClient, embedFunction?: ((text: string) => Promise<number[]>) | undefined, options?: {
        defaultTenantId?: string;
        defaultQueryLimit?: number;
    });
    set(key: string, value: any, options?: MemorySetOptions): Promise<void>;
    private setRegular;
    private setWithEntityAlignment;
    get(key: string, opts?: {
        backend?: string;
        tenantId?: string;
    }): Promise<any>;
    private getAlignmentsForMemory;
    /**
     * Builds a Prisma query condition for filtering on JSON fields
     * @param filter The filter to apply on a JSON field
     * @returns A Prisma-compatible query condition
     * @private
     */
    private buildJsonFilterCondition;
    delete(key: string, opts?: {
        backend?: string;
        tenantId?: string;
    }): Promise<void>;
    deleteMany(input: GetManyInput, options?: GetManyOptions): Promise<number>;
    clear(): Promise<void>;
    get entities(): {
        unlink: (memoryKey: string, fieldPath: string) => Promise<void>;
        realign: (memoryKey: string, fieldPath: string, entityId: string) => Promise<void>;
        stats: (entityType?: string) => Promise<{
            totalEntities: number;
            totalAlignments: number;
            entitiesByType: Record<string, number>;
        }>;
    };
    /**
     * Unified method for retrieving multiple entries
     * Supports both pattern matching and query objects
     */
    getMany<T>(input: GetManyInput, options?: GetManyOptions): Promise<MemoryQueryResult<T>[]>;
    /**
     * Pattern matching implementation
     */
    private queryByPattern;
    /**
     * Convert pattern with wildcards to SQL LIKE pattern
     */
    private convertPatternToSQL;
    /**
     * Query using object parameters (existing functionality)
     */
    private queryByObject;
    private querySimple;
    private queryWithFilters;
    /**
     * Handle queries with entity-aware filters
     */
    private queryWithEntityFilters;
    /**
     * Find memory keys that match an entity filter
     */
    private findMemoryKeysByEntityFilter;
    /**
     * Normalize text for better search matching
     */
    private normalizeForSearch;
    /**
     * Check if two normalized texts are similar using multiple strategies
     */
    private areTextsSimilar;
    /**
     * Evaluate a filter condition against a value in memory (for post-processing)
     */
    private evaluateFilterInMemory;
    /**
     * Get a value from an object using a dot-notation path with automatic array traversal
     * Examples:
     * - "venue.name" → looks for obj.venue.name
     * - "titleAndDescription.title" → looks for obj.titleAndDescription[*].title (automatic array search)
     * - "sessions.speakers.name" → handles arrays at any level
     */
    private getValueByPath;
    /**
     * Recursive helper for getValueByPath that handles arrays naturally
     */
    private getValueByPathRecursive;
    /**
     * Search for a field path within an array of objects
     * Returns the first matching value found (not limited to strings like EntityFieldParser)
     */
    private searchArrayForPath;
    /**
     * Recognize if a candidate object exists in memory using entity alignment and LLM disambiguation
     */
    recognize<T>(candidateData: T, options?: any): Promise<any>;
    /**
     * Enrich a memory entry by consolidating it with additional data using LLM
     * By default, the enriched data is automatically saved back to memory.
     * Use dryRun: true to preview enrichment without saving.
     */
    enrich<T>(key: string, additionalData: T[], options?: any): Promise<any>;
    /**
     * Store binary data (images, files, etc.) with metadata
     * @param key The unique identifier for the blob entry
     * @param buffer Binary data to store
     * @param metadata Metadata about the blob (filename, mimeType, etc.)
     * @param options Storage options (tags, tenantId, etc.)
     */
    setBlob(key: string, buffer: Buffer, metadata?: any, options?: MemorySetOptions): Promise<void>;
    /**
     * Retrieve binary data and metadata
     * @param key The unique identifier for the blob entry
     * @param tenantId Optional tenant ID override
     * @returns Object with buffer and metadata, or null if not found
     */
    getBlob(key: string, tenantId?: string): Promise<{
        buffer: Buffer;
        metadata: any;
    } | null>;
    /**
     * Check if a key has blob data
     * @param key The unique identifier to check
     * @param tenantId Optional tenant ID override
     * @returns true if blob data exists, false otherwise
     */
    hasBlob(key: string, tenantId?: string): Promise<boolean>;
    /**
     * Remove blob data while keeping the regular value data
     * @param key The unique identifier for the blob entry
     * @param tenantId Optional tenant ID override
     */
    deleteBlob(key: string, tenantId?: string): Promise<void>;
    /**
     * Get blob metadata without the binary data (useful for listings)
     * @param key The unique identifier for the blob entry
     * @param tenantId Optional tenant ID override
     * @returns Metadata object or null if not found
     */
    getBlobMetadata(key: string, tenantId?: string): Promise<any | null>;
    /**
     * List all blob entries for a tenant (returns metadata only, not binary data)
     * @param tenantId Optional tenant ID override
     * @param options Query options (limit, tags, etc.)
     * @returns Array of blob entries with metadata
     */
    listBlobs(tenantId?: string, options?: {
        limit?: number;
        tags?: string[];
    }): Promise<Array<{
        key: string;
        metadata: any;
        tags: string[];
        createdAt: Date;
        updatedAt: Date;
    }>>;
}

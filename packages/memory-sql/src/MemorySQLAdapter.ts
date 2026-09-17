import { getSafePgConfig } from './safePool.js';
import { PrismaClient } from './generated/prisma/index.js';
import type { PrismaClient as PrismaClientType, Prisma } from './generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import {
    SemanticMemoryBackend,
    SemanticAtomicCapability,
    SemanticCompareAndSetInput,
    SemanticCompareAndSetOptions,
    SemanticCompareAndSetResult,
    SemanticVersionedValue,
    SemanticAtomicError,
    MemoryQueryOptions,
    MemoryQueryResult,
    MemoryFilter,
    FilterOperator,
    MemoryError,
    RecognitionOptions,
    RecognitionResult,
    EnrichmentOptions,
    EnrichmentResult,
    SemanticQueryError,
    SEMANTIC_QUERY_EXECUTION_OBSERVER,
    SemanticQueryExecutionObserver,
    SemanticPaginationCapability,
    SemanticReadPageFilter,
    SemanticReadPage,
} from '@a2arium/callagent-types';
import { MemorySetOptions, EntityAlignment, VectorEmbedding, GetManyInput, GetManyOptions, GetManyQuery } from './types.js';
import { EntityFieldParser } from './EntityFieldParser.js';
import { EntityAlignmentService } from './EntityAlignmentService.js';
import { addAlignedProxies } from './AlignedValueProxy.js';
import { FilterParser, ParsedFilter, AtomicParsedFilter, FilterGroup } from './FilterParser.js';
import { RecognitionService, EnrichmentService } from './recognition/index.js';
import { processDataForStorage, detectDataType, BinaryProcessorConfig } from './BinaryDataProcessor.js';
import {
    normalizeRequiredTags,
    normalizeStoredTags,
    SEMANTIC_TAG_LIMITS,
    validateSemanticReadPageInput,
} from '@a2arium/callagent-utils';
import { validatePgEnvironment } from './pgEnvValidator.js';
import { createSafePool } from './safePool.js';
import {
    parseSemanticCursorKey,
    SemanticPageCursorCodec,
    semanticPageQueryDigest,
} from './SemanticPageCursor.js';

/**
 * Configuration options for MemorySQLAdapter
 */
export interface MemorySQLConfig {
    /** Pre-configured Prisma client instance */
    prismaClient?: PrismaClientType;
    /** Database connection URL (used if prismaClient not provided) */
    databaseUrl?: string;
    /** Default tenant ID for operations */
    defaultTenantId?: string;
    /** Embedding function for vector operations */
    embedFunction?: (text: string) => Promise<number[]>;
    /** Default query result limit */
    defaultQueryLimit?: number;
    /** Maximum candidates inspected by a compatibility residual scan. */
    maxResidualScanRows?: number;
    /** Stable base64url-encoded 32-byte key used for opaque page cursors. */
    semanticCursorKey?: string;
}

// Define system tenant constants locally for this adapter
const SYSTEM_TENANT = '__system__';
const DEFAULT_ENTITY_ALIGNMENT_THRESHOLD = 0.7;
const MAX_POSTGRES_BIGINT = 9223372036854775807n;
const isSystemTenant = (tenantId: string): boolean => tenantId === SYSTEM_TENANT;

function assertExactJsonValue(value: unknown, seen = new WeakSet<object>()): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || seen.has(value)) throw new Error('Value is outside the JSON domain');

    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const ownKeys = Reflect.ownKeys(value);
            if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) {
                throw new Error('JSON arrays must not be sparse or have extra properties');
            }
            for (let index = 0; index < value.length; index++) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (!descriptor?.enumerable || !('value' in descriptor)) {
                    throw new Error('JSON arrays must contain plain indexed values');
                }
                assertExactJsonValue(descriptor.value, seen);
            }
            return;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error('JSON objects must be plain objects');
        }
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== 'string') throw new Error('JSON objects cannot contain symbol keys');
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor?.enumerable || !('value' in descriptor)) {
                throw new Error('JSON objects must contain enumerable data properties');
            }
            assertExactJsonValue(descriptor.value, seen);
        }
    } finally {
        seen.delete(value);
    }
}

export class MemorySQLAdapter implements SemanticMemoryBackend {
    private prisma: PrismaClientType;
    private ownsPrisma: boolean = false;
    private embedFunction?: (text: string) => Promise<number[]>;
    private entityService?: EntityAlignmentService;
    private recognitionService?: RecognitionService;
    private enrichmentService?: EnrichmentService;
    private defaultTenantId: string;
    private defaultQueryLimit: number = SEMANTIC_TAG_LIMITS.defaultQueryLimit;
    private maxResidualScanRows = 50_000;
    private semanticPageCursorCodec?: SemanticPageCursorCodec;

    public readonly pagination?: SemanticPaginationCapability;

    public readonly capabilities = {
        backendKind: 'sql',
        tagQuery: { allOf: true, returnsStoredTags: true },
        predicateRemoval: {
            allOfTags: true,
            predicateRechecked: true,
            returnsCount: true,
            entityFilters: false,
        },
    } as const;

    public readonly atomic: SemanticAtomicCapability = {
        getVersioned: <T>(key: string) => this.getVersioned<T>(key),
        compareAndSet: <T>(input: SemanticCompareAndSetInput<T>, opts?: SemanticCompareAndSetOptions) =>
            this.compareAndSet(input, opts),
    };

    // Support both old and new constructor signatures for backward compatibility
    constructor(
        configOrPrisma?: MemorySQLConfig | PrismaClientType,
        embedFunction?: (text: string) => Promise<number[]>,
        options: { defaultTenantId?: string; defaultQueryLimit?: number; maxResidualScanRows?: number; semanticCursorKey?: string } = {}
    ) {
        let config: MemorySQLConfig;

        // Detect old vs new constructor signature
        if (configOrPrisma && typeof (configOrPrisma as any).$connect === 'function') {
            // Old signature: constructor(prisma, embedFunction?, options?)
            config = {
                prismaClient: configOrPrisma as PrismaClientType,
                embedFunction,
                defaultTenantId: options.defaultTenantId,
                defaultQueryLimit: options.defaultQueryLimit,
                maxResidualScanRows: options.maxResidualScanRows,
                semanticCursorKey: options.semanticCursorKey,
            };
        } else {
            // New signature: constructor(config?)
            config = configOrPrisma as MemorySQLConfig || {};
        }
        // Initialize Prisma client
        if (config.prismaClient) {
            // Use provided client
            this.prisma = config.prismaClient as PrismaClientType;
            this.ownsPrisma = false;
        } else {
            if (config.databaseUrl) {
                // Create client with provided URL
                if (typeof config.databaseUrl !== 'string') {
                    throw new Error(`Invalid type for databaseUrl: expected string, received ${typeof config.databaseUrl}. Check your configuration object.`);
                }
                validatePgEnvironment('MemorySQLAdapter');
                this.prisma = new (PrismaClient as any)({
                    adapter: new PrismaPg(getSafePgConfig(config.databaseUrl))
                });
                this.ownsPrisma = true;
            } else if (process.env.MEMORY_DATABASE_URL) {
                // Fallback to MEMORY_DATABASE_URL only
                const dbUrl = process.env.MEMORY_DATABASE_URL;
                if (typeof dbUrl !== 'string') {
                    throw new Error(`Invalid type for MEMORY_DATABASE_URL: expected string, received ${typeof dbUrl}. Check your environment variables.`);
                }
                validatePgEnvironment('MemorySQLAdapter');
                console.warn(`MemorySQLAdapter: Using MEMORY_DATABASE_URL from environment. Ensure PRISMA_SKIP_DOTENV is handled if this is a monorepo setup.`);
                this.prisma = new (PrismaClient as any)({
                    adapter: new PrismaPg(getSafePgConfig(dbUrl))
                });
                this.ownsPrisma = true;
            } else {
                throw new Error(`
MemorySQLAdapter requires database configuration. Provide either:
1. config.prismaClient: Pre-configured PrismaClient
2. config.databaseUrl: Database connection string  
3. Environment variable: MEMORY_DATABASE_URL

Example:
new MemorySQLAdapter({ 
  databaseUrl: "postgresql://user:pass@localhost:5432/mydb" 
})
                `.trim());
            }
        }

        // Set configuration options
        this.defaultTenantId = config.defaultTenantId || 'default';
        this.embedFunction = config.embedFunction;
        const semanticCursorKey = parseSemanticCursorKey(config.semanticCursorKey ?? process.env.SEMANTIC_CURSOR_KEY);
        if (semanticCursorKey) {
            this.semanticPageCursorCodec = new SemanticPageCursorCodec(semanticCursorKey);
            this.pagination = {
                readPage: <T>(filter: Omit<SemanticReadPageFilter, 'backend'>, pageOptions: Parameters<SemanticPaginationCapability['readPage']>[1]) =>
                    this.readSemanticPage<T>(filter, pageOptions),
            };
        }
        if (config.defaultQueryLimit !== undefined) this.defaultQueryLimit = this.validateQueryLimit(config.defaultQueryLimit);
        if (config.maxResidualScanRows !== undefined) {
            if (!Number.isInteger(config.maxResidualScanRows) || config.maxResidualScanRows <= 0 || config.maxResidualScanRows > 1_000_000) {
                throw new SemanticQueryError('SEMANTIC_QUERY_LIMIT_INVALID', 'maxResidualScanRows must be an integer from 1 through 1000000');
            }
            this.maxResidualScanRows = config.maxResidualScanRows;
        }

        // Initialize embedding-dependent services if embedFunction provided
        if (config.embedFunction) {
            this.entityService = new EntityAlignmentService(this.prisma, config.embedFunction, {
                defaultThreshold: DEFAULT_ENTITY_ALIGNMENT_THRESHOLD
            });

            // Initialize recognition and enrichment services
            this.recognitionService = new RecognitionService(this.prisma, this.entityService);
            this.enrichmentService = new EnrichmentService();
        }
    }

    private validateQueryLimit(value: unknown): number {
        const limit = value === undefined ? this.defaultQueryLimit : value;
        if (!Number.isFinite(limit) || !Number.isInteger(limit) || (limit as number) < 0 || (limit as number) > SEMANTIC_TAG_LIMITS.maxQueryLimit) {
            throw new SemanticQueryError('SEMANTIC_QUERY_LIMIT_INVALID', 'Semantic-memory query limit is invalid', {
                details: { maxQueryLimit: SEMANTIC_TAG_LIMITS.maxQueryLimit },
            });
        }
        return limit as number;
    }

    private executionObserver(options?: GetManyOptions): SemanticQueryExecutionObserver | undefined {
        return options?.[SEMANTIC_QUERY_EXECUTION_OBSERVER];
    }

    /**
     * Disconnect from the database (only if we created the Prisma client)
     */
    async disconnect(): Promise<void> {
        if (this.ownsPrisma && this.prisma) {
            await this.prisma.$disconnect();
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

        // Normalize tags before storage
        const normalizedTags = normalizeStoredTags(options.tags || []);

        if (shouldUseBlob) {
            // Store large binary data in BYTEA fields
            await this.setBlob(key, processedData.buffer, processedData.metadata, {
                tags: normalizedTags,
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
                    tags: normalizedTags,
                    updatedAt: new Date()
                },
                create: {
                    tenantId: tenantId,
                    key: key,
                    value: valueWithBase64,
                    tags: normalizedTags,
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

        // Normalize tags before storage
        const normalizedTags = normalizeStoredTags(options.tags || []);
        // Debug log
        // upsert

        // Check if the value contains binary data that needs processing
        const processedBinary = await this.processBinaryDataIfNeeded(value, options);

        if (processedBinary) {
            // Store binary data using blob storage
            await this.storeBinaryData(key, processedBinary, { ...options, tags: normalizedTags });
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
                    tags: normalizedTags,
                    updatedAt: new Date()
                },
                create: {
                    tenantId: tenantId,
                    key: key,
                    value: value,
                    tags: normalizedTags,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            });
            // Verify write landed; throw if not found
            const verify = await this.prisma.$queryRaw<Array<{ key: string }>>`
                SELECT key FROM agent_memory_store WHERE key = ${key} AND tenant_id = ${tenantId}
            `;
            if (!verify || verify.length === 0) {
                throw new Error(`[MemorySQLAdapter.setRegular] Verification failed: row not found after upsert for key=${key}, tenant=${tenantId}`);
            }
        }
    }

    private async setWithEntityAlignment(key: string, value: any, options: MemorySetOptions): Promise<void> {
        if (!this.entityService || !options.entities) {
            throw new Error('Entity alignment service not available');
        }

        const tenantId = options.tenantId || this.defaultTenantId;

        // Normalize tags before storage
        const normalizedTags = normalizeStoredTags(options.tags || []);

        // Check if the value contains binary data that needs processing
        const processedBinary = await this.processBinaryDataIfNeeded(value, options);

        if (processedBinary) {
            // Store binary data using blob storage (entity alignment not applied to binary data)
            await this.storeBinaryData(key, processedBinary, { ...options, tags: normalizedTags });
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
                    tags: normalizedTags,
                    updatedAt: new Date()
                },
                create: {
                    tenantId: tenantId,
                    key: key,
                    value: value,
                    tags: normalizedTags,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            });
        }
    }

    async get<T>(key: string, opts?: { backend?: string; tenantId?: string }): Promise<T | null> {
        const tenantId = opts?.tenantId || this.defaultTenantId;
        // select by key

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
            } as any as T;
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
            return null;
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

        return value as T;
    }

    private validateSemanticVersion(version: string): bigint {
        if (!/^[1-9][0-9]*$/.test(version)) {
            throw new SemanticAtomicError(
                'SEMANTIC_ATOMIC_INVALID_VERSION',
                'Semantic version must be a canonical positive decimal string'
            );
        }
        const parsed = BigInt(version);
        if (parsed > MAX_POSTGRES_BIGINT) {
            throw new SemanticAtomicError(
                'SEMANTIC_ATOMIC_INVALID_VERSION',
                'Semantic version exceeds the PostgreSQL bigint range'
            );
        }
        return parsed;
    }

    private serializeAtomicValue(value: unknown): string {
        try {
            assertExactJsonValue(value);
            if (value && typeof value === 'object' && 'data' in value) {
                const dataType = detectDataType((value as { data?: unknown }).data);
                if (dataType !== 'unknown') {
                    throw new Error('Semantic CAS v1 does not support binary-backed values');
                }
            }
            const serialized = JSON.stringify(value);
            return serialized;
        } catch {
            throw new SemanticAtomicError(
                'SEMANTIC_ATOMIC_VALUE_UNSUPPORTED',
                'Semantic CAS v1 requires an exact JSON value'
            );
        }
    }

    private validateAtomicOptions(options?: SemanticCompareAndSetOptions): void {
        const runtimeOptions = options as Record<string, unknown> | undefined;
        if (runtimeOptions && (
            runtimeOptions.entities !== undefined
            || runtimeOptions.alignmentThreshold !== undefined
            || runtimeOptions.autoCreateEntities !== undefined
        )) {
            throw new SemanticAtomicError(
                'SEMANTIC_ATOMIC_OPTION_UNSUPPORTED',
                'Semantic CAS v1 does not support entity-alignment options'
            );
        }
    }

    async getVersioned<T>(key: string): Promise<SemanticVersionedValue<T> | null> {
        const tenantId = this.defaultTenantId;
        const rows = await this.prisma.$queryRaw<Array<{
            value: unknown;
            version: bigint | string;
            blob_data: Buffer | null;
            has_alignment: boolean;
        }>>`
            SELECT memory.value,
                   memory.version,
                   memory.blob_data,
                   EXISTS (
                       SELECT 1
                       FROM entity_alignment alignment
                       WHERE alignment.tenant_id = memory.tenant_id
                           AND alignment.memory_key = memory.key
                   ) AS has_alignment
            FROM agent_memory_store memory
            WHERE memory.tenant_id = ${tenantId} AND memory.key = ${key}
        `;
        const row = rows[0];
        if (!row) return null;
        if (row.has_alignment) {
            throw new SemanticAtomicError(
                'SEMANTIC_ATOMIC_OPTION_UNSUPPORTED',
                'Semantic CAS v1 does not support entity-aligned rows'
            );
        }
        if (row.blob_data || (
            row.value
            && typeof row.value === 'object'
            && (row.value as { encoding?: unknown }).encoding === 'base64'
        )) {
            throw new SemanticAtomicError(
                'SEMANTIC_ATOMIC_VALUE_UNSUPPORTED',
                'Semantic CAS v1 does not support binary-backed values'
            );
        }
        return { value: row.value as T, version: String(row.version) };
    }

    async compareAndSet<T>(
        input: SemanticCompareAndSetInput<T>,
        options?: SemanticCompareAndSetOptions
    ): Promise<SemanticCompareAndSetResult> {
        this.validateAtomicOptions(options);
        const expectedVersion = input.expectedVersion === null
            ? null
            : this.validateSemanticVersion(input.expectedVersion);
        const serializedValue = this.serializeAtomicValue(input.value);
        const normalizedTags = normalizeStoredTags(options?.tags || []);
        const tenantId = this.defaultTenantId;

        let updated: Array<{ version: bigint | string }>;
        if (expectedVersion === null) {
            updated = await this.prisma.$queryRaw<Array<{ version: bigint | string }>>`
                INSERT INTO agent_memory_store
                    (tenant_id, key, value, tags, created_at, updated_at)
                VALUES
                    (${tenantId}, ${input.key}, ${serializedValue}::jsonb, ${normalizedTags}::text[],
                        (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3),
                        (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3))
                ON CONFLICT (tenant_id, key) DO NOTHING
                RETURNING version
            `;
        } else {
            updated = await this.prisma.$queryRaw<Array<{ version: bigint | string }>>`
                UPDATE agent_memory_store
                SET value = ${serializedValue}::jsonb,
                    tags = ${normalizedTags}::text[],
                    blob_data = NULL,
                    blob_metadata = NULL,
                    updated_at = (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
                WHERE tenant_id = ${tenantId}
                    AND key = ${input.key}
                    AND version = ${expectedVersion}
                    AND blob_data IS NULL
                    AND COALESCE(value->>'encoding', '') <> 'base64'
                    AND NOT EXISTS (
                        SELECT 1
                        FROM entity_alignment alignment
                        WHERE alignment.tenant_id = agent_memory_store.tenant_id
                            AND alignment.memory_key = agent_memory_store.key
                    )
                RETURNING version
            `;
        }

        if (updated[0]) return { status: 'updated', version: String(updated[0].version) };

        const current = await this.prisma.$queryRaw<Array<{
            version: bigint | string;
            blob_data: Buffer | null;
            value: unknown;
            has_alignment: boolean;
        }>>`
            SELECT memory.version,
                   memory.blob_data,
                   memory.value,
                   EXISTS (
                       SELECT 1
                       FROM entity_alignment alignment
                       WHERE alignment.tenant_id = memory.tenant_id
                           AND alignment.memory_key = memory.key
                   ) AS has_alignment
            FROM agent_memory_store memory
            WHERE memory.tenant_id = ${tenantId} AND memory.key = ${input.key}
        `;
        if (expectedVersion !== null && current[0]?.has_alignment) {
            throw new SemanticAtomicError(
                'SEMANTIC_ATOMIC_OPTION_UNSUPPORTED',
                'Semantic CAS v1 does not support entity-aligned rows'
            );
        }
        if (expectedVersion !== null && (current[0]?.blob_data || (
            current[0]?.value
            && typeof current[0].value === 'object'
            && (current[0].value as { encoding?: unknown }).encoding === 'base64'
        ))) {
            throw new SemanticAtomicError(
                'SEMANTIC_ATOMIC_VALUE_UNSUPPORTED',
                'Semantic CAS v1 does not support binary-backed values'
            );
        }
        return {
            status: 'conflict',
            currentVersion: current[0] ? String(current[0].version) : null,
        };
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

    private async getAlignmentsForMemories(
        memoryKeys: readonly string[],
        tenantId: string
    ): Promise<Map<string, Record<string, EntityAlignment>>> {
        const result = new Map<string, Record<string, EntityAlignment>>();
        if (memoryKeys.length === 0) return result;
        const rows = await this.prisma.$queryRaw<Array<{
            memory_key: string;
            field_path: string;
            entity_id: string;
            original_value: string;
            confidence: string;
            aligned_at: Date;
            canonical_name: string;
        }>>`
            SELECT ea.memory_key,
                   ea.field_path,
                   ea.entity_id,
                   ea.original_value,
                   ea.confidence,
                   ea.aligned_at,
                   es.canonical_name
            FROM entity_alignment ea
            JOIN entity_store es ON ea.entity_id = es.id AND ea.tenant_id = es.tenant_id
            WHERE ea.tenant_id = ${tenantId}
              AND ea.memory_key = ANY(${[...memoryKeys]}::text[])
        `;
        for (const row of rows) {
            const memory = result.get(row.memory_key) ?? {};
            memory[row.field_path] = {
                entityId: row.entity_id,
                canonicalName: row.canonical_name,
                originalValue: row.original_value,
                confidence: row.confidence as 'high' | 'medium' | 'low',
                alignedAt: row.aligned_at,
            };
            result.set(row.memory_key, memory);
        }
        return result;
    }

    private async mapQueryRows<T>(
        rows: Array<{ key: string; value: unknown; tags: string[] | null }>,
        tenantId: string,
        observer?: SemanticQueryExecutionObserver
    ): Promise<MemoryQueryResult<T>[]> {
        const alignments = this.entityService && rows.length > 0
            ? await this.getAlignmentsForMemories(rows.map((row) => row.key), tenantId)
            : new Map<string, Record<string, EntityAlignment>>();
        observer?.({ alignmentBatchQueries: this.entityService && rows.length > 0 ? 1 : 0 });
        return rows.map((row) => {
            const aligned = alignments.get(row.key);
            return {
                key: row.key,
                value: aligned && Object.keys(aligned).length > 0
                    ? addAlignedProxies(row.value, aligned) as T
                    : row.value as T,
                tags: row.tags ?? [],
            };
        });
    }



    /**
     * Builds a Prisma query condition for filtering on JSON fields with array support
     * @param filter The parsed filter to apply on a JSON field
     * @returns A Prisma-compatible query condition
     * @private
     */
    private buildJsonFilterCondition(filter: ParsedFilter): any {
        if (filter.type === 'group') {
            throw new Error('JSON filter condition does not support groups');
        }
        const { path, isArrayPath } = filter;

        // Validate path - must be a non-empty string
        if (!path || typeof path !== 'string') {
            throw new Error('Filter path must be a non-empty string');
        }

        // Validate array filter if applicable
        if (isArrayPath) {
            this.validateArrayFilter(filter);
            return this.buildArrayFilterCondition(filter);
        }

        // Handle regular (non-array) paths
        return this.buildRegularFilterCondition(filter);
    }

    /**
     * Validates array filter syntax and compatibility
     * @param filter The array filter to validate
     * @private
     */
    private validateArrayFilter(filter: ParsedFilter): void {
        if (filter.type === 'group') {
            throw new MemoryError('Array filter validation does not support groups', { code: 'INVALID_ARRAY_FILTER' });
        }
        const { arrayPathInfo, path, operator } = filter;

        if (!arrayPathInfo) {
            throw new MemoryError(`Path "${path}" must be an array path (e.g., "events[].date")`, {
                code: 'INVALID_ARRAY_FILTER',
                filter: filter.path
            });
        }

        const { arrayField, nestedPath } = arrayPathInfo;

        if (!arrayField.trim()) {
            throw new MemoryError('Array field name cannot be empty', {
                code: 'INVALID_ARRAY_FILTER',
                filter: filter.path
            });
        }

        // Entity filter operators check
        if (['ENTITY_FUZZY', 'ENTITY_EXACT', 'ENTITY_ALIAS'].includes(operator)) {
            // NOTE: We allow this here so logical OR/AND groups can still be processed,
            // but these will be handled in-memory by evaluateFilterInMemory rather than in SQL
            // because building cross-joins for entity alignments inside JSON arrays is extremely complex.
            return;
        }
    }

    /**
 * Builds raw SQL condition for array filtering using PostgreSQL JSONB operators
 * @param filter The array filter to build condition for
 * @returns Raw SQL fragment that can be used in WHERE clauses
 * @private
 */
    private buildArrayFilterCondition(filter: AtomicParsedFilter): { sql: string; params: any[] } {
        this.validateArrayFilter(filter);
        const { arrayPathInfo, operator, value } = filter;

        if (!arrayPathInfo) {
            throw new MemoryError('Array path info missing for array filter', { code: 'INVALID_ARRAY_FILTER' });
        }

        const { arrayField, nestedPath } = arrayPathInfo;

        let sqlOperator: string;
        let paramValue = value;

        switch (operator) {
            case '=':
                sqlOperator = '=';
                break;
            case '!=':
                sqlOperator = '!=';
                break;
            case '>':
                sqlOperator = '>';
                break;
            case '>=':
                sqlOperator = '>=';
                break;
            case '<':
                sqlOperator = '<';
                break;
            case '<=':
                sqlOperator = '<=';
                break;
            case 'CONTAINS':
                if (typeof value !== 'string') {
                    throw new MemoryError('CONTAINS operator requires a string value', {
                        code: 'INVALID_VALUE_TYPE',
                        operator,
                        value
                    });
                }
                sqlOperator = 'ILIKE';
                paramValue = `%${value}%`;
                break;
            case 'STARTS_WITH':
                if (typeof value !== 'string') {
                    throw new MemoryError('STARTS_WITH operator requires a string value', {
                        code: 'INVALID_VALUE_TYPE',
                        operator,
                        value
                    });
                }
                sqlOperator = 'ILIKE';
                paramValue = `${value}%`;
                break;
            case 'ENDS_WITH':
                if (typeof value !== 'string') {
                    throw new MemoryError('ENDS_WITH operator requires a string value', {
                        code: 'INVALID_VALUE_TYPE',
                        operator,
                        value
                    });
                }
                sqlOperator = 'ILIKE';
                paramValue = `%${value}`;
                break;
            case 'ENTITY_FUZZY':
            case 'ENTITY_EXACT':
            case 'ENTITY_ALIAS':
                if (typeof value !== 'string') {
                    throw new MemoryError(`${operator} requires a string value`, {
                        code: 'INVALID_VALUE_TYPE',
                        operator,
                        value,
                    });
                }
                sqlOperator = 'ILIKE';
                paramValue = `%${value}%`;
                break;
            default:
                throw new MemoryError(`Operator "${operator}" is not supported for array filtering`, {
                    code: 'UNSUPPORTED_OPERATOR',
                    operator
                });
        }

        let fieldAccessor = 'elem #>> $2::text[]';

        // PostgreSQL JSONB extraction always returns text, so we need to cast for numeric/boolean operators
        const needsNumericCast = typeof value === 'number';
        const needsBooleanCast = typeof value === 'boolean';

        if (needsNumericCast) {
            fieldAccessor = `(${fieldAccessor})::numeric`;
        } else if (needsBooleanCast) {
            fieldAccessor = `(${fieldAccessor})::boolean`;
        }

        const sql = `EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(value -> $1, '[]'::jsonb)) AS elem
            WHERE ${fieldAccessor} ${sqlOperator} $3
        )`;

        const params = [arrayField, nestedPath.split('.'), paramValue];

        return { sql, params };
    }

    /**
     * Builds regular (non-array) filter condition
     * @param filter The regular filter to build condition for
     * @returns Prisma query condition
     * @private
     */
    private buildRegularFilterCondition(filter: AtomicParsedFilter): any {
        const { path, operator, value } = filter;

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
                    throw new MemoryError('CONTAINS operator requires a string value', {
                        code: 'INVALID_VALUE_TYPE',
                        operator,
                        value
                    });
                }
                return {
                    value: {
                        path: pathParts,
                        string_contains: value
                    }
                };
            case 'STARTS_WITH':
                if (typeof value !== 'string') {
                    throw new MemoryError('STARTS_WITH operator requires a string value', {
                        code: 'INVALID_VALUE_TYPE',
                        operator,
                        value
                    });
                }
                return {
                    value: {
                        path: pathParts,
                        string_starts_with: value
                    }
                };
            case 'ENDS_WITH':
                if (typeof value !== 'string') {
                    throw new MemoryError('ENDS_WITH operator requires a string value', {
                        code: 'INVALID_VALUE_TYPE',
                        operator,
                        value
                    });
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
                throw new MemoryError(`Entity operator ${operator} should be handled by entity-aware query path, not regular JSON filtering`, {
                    code: 'INVALID_ENTITY_OPERATOR',
                    operator
                });
            default:
                throw new MemoryError(`Unsupported operator: ${operator}`, {
                    code: 'UNSUPPORTED_OPERATOR',
                    operator
                });
        }
    }

    async delete(key: string, opts?: { backend?: string; tenantId?: string }): Promise<void> {
        const tenantId = opts?.tenantId || this.defaultTenantId;
        // Delete memory and associated alignments
        await this.prisma.$transaction(async (tx: any) => {
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
        if (typeof input === 'string') {
            // Pattern removal is a legacy low-level API. Keep it bounded; strict callers use
            // SemanticMemoryRegistry.removeItems(), which always supplies a structured predicate.
            let targetTenant = tenantId;
            let pattern = input;
            if (isSystemTenant(tenantId) && input.includes(':')) {
                const [candidateTenant, candidatePattern] = input.split(':', 2);
                if (candidateTenant && candidatePattern) {
                    targetTenant = candidateTenant;
                    pattern = candidatePattern;
                }
            }
            const requestedLimit = options?.limit === undefined
                ? Number.POSITIVE_INFINITY
                : this.validateQueryLimit(options.limit);
            if (requestedLimit === 0) return 0;
            let removedTotal = 0;
            while (removedTotal < requestedLimit) {
                const batchLimit = Math.min(
                    SEMANTIC_TAG_LIMITS.maxQueryLimit,
                    requestedLimit - removedTotal
                );
                const entries = await this.getMany(pattern, { ...options, tenantId: targetTenant, limit: batchLimit });
                if (entries.length === 0) break;
                const keys = entries.map((entry) => entry.key);
                const removed = await this.prisma.$transaction(async (tx: any) => {
                    await tx.$executeRaw`
                        DELETE FROM entity_alignment
                        WHERE memory_key = ANY(${keys}::text[]) AND tenant_id = ${targetTenant}
                    `;
                    return Number(await tx.$executeRaw`
                        DELETE FROM agent_memory_store
                        WHERE key = ANY(${keys}::text[]) AND tenant_id = ${targetTenant}
                    `);
                });
                removedTotal += removed;
                if (entries.length < batchLimit || removed === 0) break;
            }
            return removedTotal;
        }

        const query: GetManyQuery = {
            ...input,
            limit: options?.limit ?? input.limit,
            orderBy: options?.orderBy ?? input.orderBy,
            backend: options?.backend ?? input.backend,
            tenantId: (options as any)?.tenantId ?? input.tenantId,
            [SEMANTIC_QUERY_EXECUTION_OBSERVER]: options?.[SEMANTIC_QUERY_EXECUTION_OBSERVER],
        } as GetManyQuery;
        const limit = this.validateQueryLimit(query.limit);
        const { requiredTags } = normalizeRequiredTags(query);
        const filters = FilterParser.parseFilters(query.filters ?? []);
        if (requiredTags.length === 0 && filters.length === 0) {
            throw new SemanticQueryError('SEMANTIC_QUERY_INVALID_COMBINATION', 'Structured semantic-memory removal requires a selector');
        }
        if (filters.some((filter) => this.hasEntityOperators(filter))) {
            throw new SemanticQueryError(
                'SEMANTIC_PREDICATE_REMOVE_UNSUPPORTED',
                'Atomic removal does not support entity predicates'
            );
        }
        if (limit === 0) return 0;

        const selectedParams: unknown[] = [tenantId];
        let selectedPredicate = 'tenant_id = $1';
        if (requiredTags.length > 0) {
            selectedParams.push(requiredTags);
            selectedPredicate += ` AND tags @> $${selectedParams.length}::text[]`;
        }
        if (filters.length > 0) {
            const compiled = this.buildFilterRecursiveRawSQL(
                { type: 'group', logic: 'AND', filters },
                selectedParams.length + 1
            );
            selectedPredicate += ` AND (${compiled.sql})`;
            selectedParams.push(...compiled.params);
        }
        selectedParams.push(limit);
        const limitParameter = selectedParams.length;

        const recheckParams: unknown[] = [tenantId];
        let recheckPredicate = `memory.tenant_id = $${selectedParams.length + 1}`;
        if (requiredTags.length > 0) {
            recheckParams.push(requiredTags);
            recheckPredicate += ` AND memory.tags @> $${selectedParams.length + recheckParams.length}::text[]`;
        }
        if (filters.length > 0) {
            const compiled = this.buildFilterRecursiveRawSQL(
                { type: 'group', logic: 'AND', filters },
                selectedParams.length + recheckParams.length + 1
            );
            recheckPredicate += ` AND (${this.qualifyMemoryPredicate(compiled.sql)})`;
            recheckParams.push(...compiled.params);
        }

        const sql = `
            WITH selected AS MATERIALIZED (
                SELECT key
                FROM agent_memory_store
                WHERE ${selectedPredicate}
                ORDER BY ${this.orderSql(query)}
                LIMIT $${limitParameter}
            ),
            locked AS MATERIALIZED (
                SELECT memory.key
                FROM agent_memory_store AS memory
                JOIN selected ON selected.key = memory.key
                WHERE ${recheckPredicate}
                ORDER BY memory.key ASC
                FOR UPDATE OF memory
            )
            DELETE FROM agent_memory_store AS memory
            USING locked
            WHERE memory.tenant_id = $${selectedParams.length + 1}
              AND memory.key = locked.key
            RETURNING memory.key
        `;
        const params = [...selectedParams, ...recheckParams];
        const observer = this.executionObserver(query as GetManyOptions);
        const startedAt = Date.now();

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const removed = await this.prisma.$transaction(async (tx: any) => {
                    const rows = await tx.$queryRawUnsafe(sql, ...params) as Array<{ key: string }>;
                    if (rows.length > 0) {
                        await tx.$executeRaw`
                            DELETE FROM entity_alignment
                            WHERE tenant_id = ${tenantId}
                              AND memory_key = ANY(${rows.map((row) => row.key)}::text[])
                        `;
                    }
                    return rows.length;
                });
                observer?.({ databaseDurationMs: Date.now() - startedAt });
                return removed;
            } catch (error) {
                const sqlState = this.sqlState(error);
                if ((sqlState !== '40P01' && sqlState !== '40001') || attempt === 3) {
                    if ((sqlState === '40P01' || sqlState === '40001') && attempt === 3) {
                        throw new SemanticQueryError('SEMANTIC_REMOVE_CONTENTION', 'Semantic-memory removal contention retries were exhausted', {
                            retryable: true,
                            details: { attempts: attempt, sqlState },
                            cause: error,
                        });
                    }
                    throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 41)));
            }
        }
        throw new SemanticQueryError('SEMANTIC_REMOVE_CONTENTION', 'Semantic-memory removal did not complete', { retryable: true });
    }

    private qualifyMemoryPredicate(sql: string): string {
        return sql
            .replace(/\bvalue\b/g, 'memory.value')
            .replace(/\btags\b/g, 'memory.tags');
    }

    private sqlState(error: unknown): string | undefined {
        const candidate = error as { code?: unknown; cause?: { code?: unknown }; meta?: { code?: unknown } };
        for (const value of [candidate?.code, candidate?.cause?.code, candidate?.meta?.code]) {
            if (typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value)) return value;
        }
        return undefined;
    }

    // Facade-compatible method names
    async read<T>(input: GetManyInput, options?: GetManyOptions): Promise<MemoryQueryResult<T>[]> {
        return this.getMany<T>(input, options);
    }

    async remove(input: GetManyInput, options?: GetManyOptions): Promise<number> {
        return this.deleteMany(input, options);
    }

    async clear(): Promise<void> {
        await this.prisma.$transaction(async (tx: any) => {
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
                random: options?.random ?? input.random,
                backend: options?.backend ?? input.backend,
                tenantId: (options as any)?.tenantId ?? (input as any)?.tenantId,
                [SEMANTIC_QUERY_EXECUTION_OBSERVER]: options?.[SEMANTIC_QUERY_EXECUTION_OBSERVER],
            };
            return await this.queryByObject<T>(mergedQuery);
        }
    }

    private orderSql(options: Pick<GetManyQuery, 'orderBy' | 'random'>): string {
        if (options.orderBy && options.random) {
            throw new SemanticQueryError('SEMANTIC_QUERY_INVALID_COMBINATION', 'Semantic-memory orderBy and random cannot be combined');
        }
        if (options.random) return 'RANDOM()';
        const path = options.orderBy?.path ?? 'updatedAt';
        if (path !== 'createdAt' && path !== 'updatedAt') {
            throw new SemanticQueryError('SEMANTIC_QUERY_INVALID_COMBINATION', 'Semantic-memory order path is unsupported');
        }
        const column = path === 'createdAt' ? 'created_at' : 'updated_at';
        const direction = options.orderBy?.direction === 'asc' ? 'ASC' : 'DESC';
        return `${column} ${direction}, key ASC`;
    }

    private normalizePageFilter(filter: ParsedFilter): unknown {
        if (filter.type === 'atomic') {
            return {
                type: 'atomic',
                path: filter.path,
                operator: filter.operator,
                value: filter.value,
                isArrayPath: filter.isArrayPath,
            };
        }
        const filters = filter.filters.map((child) => this.normalizePageFilter(child));
        filters.sort((left, right) => semanticPageQueryDigest(left).localeCompare(semanticPageQueryDigest(right)));
        return { type: 'group', logic: filter.logic, filters };
    }

    private async readSemanticPage<T>(
        filter: Omit<SemanticReadPageFilter, 'backend'>,
        options: Parameters<SemanticPaginationCapability['readPage']>[1],
    ): Promise<SemanticReadPage<T>> {
        validateSemanticReadPageInput(filter);
        const codec = this.semanticPageCursorCodec;
        if (!codec) {
            throw new SemanticQueryError(
                'SEMANTIC_BACKEND_METHOD_UNAVAILABLE',
                'SQL semantic-memory pagination is not configured',
            );
        }
        const limit = this.validateQueryLimit(filter.limit);
        if (limit === 0) {
            throw new SemanticQueryError('SEMANTIC_QUERY_LIMIT_INVALID', 'Semantic-memory page limit must be positive', {
                details: { maxQueryLimit: SEMANTIC_TAG_LIMITS.maxQueryLimit },
            });
        }
        const orderBy = filter.orderBy ?? { path: 'updatedAt' as const, direction: 'desc' as const };
        if (orderBy.path !== 'createdAt' && orderBy.path !== 'updatedAt') {
            throw new SemanticQueryError('SEMANTIC_QUERY_INVALID_COMBINATION', 'Semantic-memory order path is unsupported');
        }
        if (orderBy.direction !== 'asc' && orderBy.direction !== 'desc') {
            throw new SemanticQueryError('SEMANTIC_QUERY_INVALID_COMBINATION', 'Semantic-memory order direction is unsupported');
        }

        const tenantId = this.defaultTenantId;
        const { requiredTags } = normalizeRequiredTags(filter);
        const sortedTags = [...requiredTags].sort();
        let parsedFilters: ParsedFilter[];
        try {
            parsedFilters = FilterParser.parseFilters(filter.filters ?? []);
        } catch (error) {
            throw new MemoryError(`Invalid filter: ${error instanceof Error ? error.message : String(error)}`, {
                code: 'INVALID_FILTER',
            });
        }
        const normalizedFilters = parsedFilters
            .map((entry) => this.normalizePageFilter(entry))
            .sort((left, right) => semanticPageQueryDigest(left).localeCompare(semanticPageQueryDigest(right)));
        const queryDigest = semanticPageQueryDigest({
            tenantId,
            backendName: options.backendName,
            tags: sortedTags,
            filters: normalizedFilters,
            orderBy,
        });
        const cursor = filter.cursor !== undefined ? codec.decode(filter.cursor, queryDigest) : undefined;

        const orderColumn = orderBy.path === 'createdAt' ? 'memory.created_at' : 'memory.updated_at';
        const comparison = orderBy.direction === 'asc' ? '>' : '<';
        const directionSql = orderBy.direction === 'asc' ? 'ASC' : 'DESC';
        const timestampFormat = 'YYYY-MM-DD HH24:MI:SS.MS';
        const queryParams: unknown[] = [tenantId, cursor?.asOf ?? null];
        let query = `
            WITH page_clock AS (
                SELECT COALESCE(
                    $2::timestamp(3),
                    (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
                ) AS as_of
            )
            SELECT
                memory.key,
                memory.value,
                COALESCE(memory.tags, ARRAY[]::text[]) AS tags,
                to_char(${orderColumn}, '${timestampFormat}') AS order_value,
                to_char(page_clock.as_of, '${timestampFormat}') AS as_of
            FROM agent_memory_store AS memory
            CROSS JOIN page_clock
            WHERE memory.tenant_id = $1
              AND ${orderColumn} <= page_clock.as_of
        `;

        if (sortedTags.length > 0) {
            queryParams.push(sortedTags);
            query += ` AND memory.tags @> $${queryParams.length}::text[]`;
        }
        if (parsedFilters.length > 0) {
            const group: FilterGroup = { type: 'group', logic: 'AND', filters: parsedFilters };
            const compiled = parsedFilters.some((entry) => this.hasEntityOperators(entry))
                ? await this.buildEntityAwareFilterSQL(group, queryParams.length + 1, tenantId)
                : this.buildFilterRecursiveRawSQL(group, queryParams.length + 1);
            query += ` AND (${compiled.sql})`;
            queryParams.push(...compiled.params);
            if ('entityCandidateCount' in compiled && typeof compiled.entityCandidateCount === 'number') {
                options[SEMANTIC_QUERY_EXECUTION_OBSERVER]?.({
                    residualFilter: false,
                    scannedRows: compiled.entityCandidateCount,
                });
            }
        }
        if (cursor) {
            queryParams.push(cursor.after.orderValue, cursor.after.key);
            const timestampParameter = `$${queryParams.length - 1}::timestamp(3)`;
            const keyParameter = `$${queryParams.length}`;
            query += ` AND (${orderColumn} ${comparison} ${timestampParameter}`
                + ` OR (${orderColumn} = ${timestampParameter} AND memory.key ${comparison} ${keyParameter}))`;
        }
        queryParams.push(limit + 1);
        query += ` ORDER BY ${orderColumn} ${directionSql}, memory.key ${directionSql} LIMIT $${queryParams.length}`;

        const observer = options[SEMANTIC_QUERY_EXECUTION_OBSERVER];
        const startedAt = Date.now();
        const rows = await this.prisma.$queryRawUnsafe(query, ...queryParams) as Array<{
            key: string;
            value: unknown;
            tags: string[] | null;
            order_value: string;
            as_of: string;
        }>;
        observer?.({ databaseDurationMs: Date.now() - startedAt });

        const pageRows = rows.slice(0, limit);
        const mapped = await this.mapQueryRows<T>(pageRows, tenantId, observer);
        const items = mapped.map((item) => ({
            id: item.key,
            value: item.value,
            tags: item.tags,
            entities: item.entities,
        }));
        const lastRow = pageRows.at(-1);
        return {
            items,
            ...(rows.length > limit && lastRow
                ? {
                    nextCursor: codec.encode(queryDigest, {
                        asOf: lastRow.as_of,
                        after: { orderValue: lastRow.order_value, key: lastRow.key },
                    }),
                }
                : {}),
        };
    }

    /**
     * Pattern matching implementation
     */
    private async queryByPattern<T>(pattern: string, options?: GetManyOptions): Promise<MemoryQueryResult<T>[]> {
        const tenantId = (options as any)?.tenantId || this.defaultTenantId;
        const limit = this.validateQueryLimit(options?.limit);
        if (limit === 0) return [];
        // pattern query

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
            SELECT key, value, COALESCE(tags, ARRAY[]::text[]) AS tags
            FROM agent_memory_store 
            WHERE key LIKE $1 AND tenant_id = $2
        `;
        query += ` ORDER BY ${this.orderSql(options ?? {})} LIMIT $3`;

        const observer = this.executionObserver(options);
        const startedAt = Date.now();
        const results = await this.prisma.$queryRawUnsafe(query, sqlPattern, tenantId, limit) as Array<{
            key: string;
            value: unknown;
            tags: string[] | null;
        }>;
        observer?.({ databaseDurationMs: Date.now() - startedAt });
        return this.mapQueryRows<T>(results, tenantId, observer);
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

        const limit = this.validateQueryLimit(queryObj.limit);
        this.orderSql(queryObj);
        const { requiredTags } = normalizeRequiredTags(queryObj);
        const prepared: GetManyQuery = {
            ...queryObj,
            tag: undefined,
            tags: requiredTags,
            limit,
        };
        if (limit === 0) return [];

        try {
            // For simple queries without filters, use querySimple
            if (!prepared.filters || prepared.filters.length === 0) {
                return await this.querySimple<T>(prepared);
            } else {
                // For complex queries with filters, use the specialized filter handler
                return await this.queryWithFilters<T>(prepared);
            }
        } catch (error: any) {
            if (error instanceof MemoryError || error instanceof SemanticQueryError) throw error;
            throw new MemoryError(`Failed to query memory: ${error.message}`,
                { originalError: error, queryShape: { hasTags: requiredTags.length > 0, hasFilters: Boolean(prepared.filters?.length) } });
        }
    }

    /**
     * Recursive check for entity operators in a filter tree
     * @private
     */
    private hasEntityOperators(filter: ParsedFilter): boolean {
        if (filter.type === 'group') {
            return filter.filters.some(f => this.hasEntityOperators(f));
        }
        return ['ENTITY_FUZZY', 'ENTITY_EXACT', 'ENTITY_ALIAS'].includes(filter.operator);
    }

    private async querySimple<T>(options: GetManyQuery): Promise<MemoryQueryResult<T>[]> {
        const limit = this.validateQueryLimit(options.limit);
        const tenantId = (options as any)?.tenantId || this.defaultTenantId;
        const { requiredTags } = normalizeRequiredTags(options);

        let query = `
            SELECT key, value, COALESCE(tags, ARRAY[]::text[]) AS tags
            FROM agent_memory_store 
            WHERE tenant_id = $1
        `;
        const queryParams: any[] = [tenantId];

        if (requiredTags.length > 0) {
            query += ` AND tags @> $${queryParams.length + 1}::text[]`;
            queryParams.push(requiredTags);
        }

        query += ` ORDER BY ${this.orderSql(options)} LIMIT $${queryParams.length + 1}`;
        queryParams.push(limit);

        const observer = this.executionObserver(options as GetManyOptions);
        const startedAt = Date.now();
        const results = await this.prisma.$queryRawUnsafe(query, ...queryParams) as Array<{
            key: string;
            value: unknown;
            tags: string[] | null;
        }>;
        observer?.({ databaseDurationMs: Date.now() - startedAt });
        return this.mapQueryRows<T>(results, tenantId, observer);
    }

    private async queryWithFilters<T>(options: GetManyQuery): Promise<MemoryQueryResult<T>[]> {
        const { filters } = options;
        const limit = this.validateQueryLimit(options.limit);
        const tenantId = (options as any)?.tenantId || this.defaultTenantId;
        const { requiredTags } = normalizeRequiredTags(options);
        // filter query

        // Check if we have entity-aware filters that require special handling
        const hasEntityFilters = filters?.some(filter => {
            const parsed = typeof filter === 'string' ? FilterParser.parseFilter(filter) : {
                type: 'atomic',
                operator: filter.operator
            } as any;
            return this.hasEntityOperators(parsed);
        });

        if (hasEntityFilters || options.random) {
            return await this.queryWithEntityFilters<T>(options);
        }

        // Check if we have array filters - if so, use raw SQL approach
        if (filters && filters.length > 0) {
            try {
                const parsedFilters = FilterParser.parseFilters(filters);
                // If any filter is an array path or a group, we must use raw SQL
                const needsRawSQL = options.random || parsedFilters.some(f => {
                    if (f.type === 'group') return true;
                    return f.isArrayPath;
                });

                if (needsRawSQL) {
                    return await this.queryWithRawArrayFilters<T>(options);
                }
            } catch (error: any) {
                throw new MemoryError(`Invalid filter: ${error.message}`, {
                    code: 'INVALID_FILTER',
                    filters: filters
                });
            }
        }

        // Build Prisma query conditions for regular filters only
        const whereConditions: any = {
            tenantId: tenantId  // Always filter by tenant
        };

        // Handle tag filtering with normalization
        if (requiredTags.length > 0) whereConditions.tags = { hasEvery: requiredTags };

        // Handle advanced JSON filtering
        if (filters && filters.length > 0) {
            try {
                // Parse string filters to object format
                const parsedFilters = FilterParser.parseFilters(filters);

                // Regular filters only - use Prisma ORM
                parsedFilters.forEach((filter: ParsedFilter) => {
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
            orderBy: options.random ? undefined : [
                { [options.orderBy?.path === 'createdAt' ? 'createdAt' : 'updatedAt']: options.orderBy?.direction ?? 'desc' },
                { key: 'asc' },
            ]
        };

        // Note: Prisma does not support ORDER BY RANDOM() natively. 
        // If random is requested, we should have already routed to raw SQL paths above.
        // But if we landed here, we fallback to standard order.

        if (Object.keys(whereConditions).length > 0) {
            findOptions.where = whereConditions;
        }

        const observer = this.executionObserver(options as GetManyOptions);
        const startedAt = Date.now();
        const results = await this.prisma.agentMemoryStore.findMany(findOptions);
        observer?.({ databaseDurationMs: Date.now() - startedAt });
        return this.mapQueryRows<T>(results.map((result) => ({
            key: result.key,
            value: result.value,
            tags: result.tags,
        })), tenantId, observer);
    }

    /**
     * Handle queries with array filters using raw SQL
     */
    private async queryWithRawArrayFilters<T>(options: GetManyQuery): Promise<MemoryQueryResult<T>[]> {
        const { filters } = options;
        const limit = this.validateQueryLimit(options.limit);
        const tenantId = (options as any)?.tenantId || this.defaultTenantId;
        const { requiredTags } = normalizeRequiredTags(options);

        // Parse all filters
        const parsedFilters = FilterParser.parseFilters(filters || []);

        // Build base query
        let query = `
            SELECT key, value, COALESCE(tags, ARRAY[]::text[]) AS tags
            FROM agent_memory_store 
            WHERE tenant_id = $1
        `;
        let queryParams: any[] = [tenantId];
        let paramIndex = 2;

        if (requiredTags.length > 0) {
            query += ` AND tags @> $${paramIndex}::text[]`;
            queryParams.push(requiredTags);
            paramIndex++;
        }

        // Add filter conditions
        if (parsedFilters.length > 0) {
            const { sql: filterSql, params: filterParams } = this.buildFilterRecursiveRawSQL(
                { type: 'group', logic: 'AND', filters: parsedFilters },
                paramIndex
            );
            query += ` AND (${filterSql})`;
            queryParams.push(...filterParams);
            paramIndex += filterParams.length;
        }

        // Add ordering and limit
        query += ` ORDER BY ${this.orderSql(options)} LIMIT $${paramIndex}`;
        queryParams.push(limit);

        const observer = this.executionObserver(options as GetManyOptions);
        const startedAt = Date.now();
        const results = await this.prisma.$queryRawUnsafe(query, ...queryParams) as Array<{
            key: string;
            value: unknown;
            tags: string[] | null;
        }>;
        observer?.({ databaseDurationMs: Date.now() - startedAt });
        return this.mapQueryRows<T>(results, tenantId, observer);
    }

    /**
     * Build raw SQL for a filter recursively, supporting logical groups
     * @private
     */
    private buildFilterRecursiveRawSQL(filter: ParsedFilter, paramIndex: number): { sql: string; params: any[] } {
        if (filter.type === 'group') {
            const parts: string[] = [];
            const allParams: any[] = [];
            let currentParamIndex = paramIndex;

            for (const subFilter of filter.filters) {
                const result = this.buildFilterRecursiveRawSQL(subFilter, currentParamIndex);
                parts.push(`(${result.sql})`);
                allParams.push(...result.params);
                currentParamIndex += result.params.length;
            }

            return {
                sql: parts.join(` ${filter.logic} `),
                params: allParams
            };
        }

        // Atomic filter
        if (filter.isArrayPath) {
            // Validate first
            this.validateArrayFilter(filter);

            const arrayCondition = this.buildArrayFilterCondition(filter);
            // Replace parameter placeholders with actual parameter numbers
            const adjustedSql = arrayCondition.sql.replace(
                /\$(\d+)/g,
                (_match, index: string) => `$${paramIndex + Number(index) - 1}`
            );
            return { sql: adjustedSql, params: arrayCondition.params };
        } else {
            return this.buildRegularFilterRawSQL(filter, paramIndex);
        }
    }

    /**
     * Builds raw SQL condition for regular (non-array) filters
     * @param filter The regular filter
     * @param startParamIndex Starting parameter index for SQL placeholders
     * @returns Raw SQL condition with parameters
     * @private
     */
    private buildRegularFilterRawSQL(filter: AtomicParsedFilter, startParamIndex: number): { sql: string; params: any[] } {
        const { path, operator, value } = filter;
        const pathParts = path.split('.');

        let sqlOperator: string;
        let params: any[];

        switch (operator) {
            case '=':
                sqlOperator = '=';
                params = [pathParts, value];
                break;
            case '!=':
                sqlOperator = '!=';
                params = [pathParts, value];
                break;
            case '>':
                sqlOperator = '>';
                params = [pathParts, value];
                break;
            case '>=':
                sqlOperator = '>=';
                params = [pathParts, value];
                break;
            case '<':
                sqlOperator = '<';
                params = [pathParts, value];
                break;
            case '<=':
                sqlOperator = '<=';
                params = [pathParts, value];
                break;
            case 'CONTAINS':
                if (typeof value !== 'string') {
                    throw new MemoryError('CONTAINS operator requires a string value', {
                        code: 'INVALID_VALUE_TYPE',
                        operator,
                        value
                    });
                }
                sqlOperator = 'ILIKE';
                params = [pathParts, `%${value}%`];
                break;
            case 'STARTS_WITH':
                if (typeof value !== 'string') {
                    throw new MemoryError('STARTS_WITH operator requires a string value', {
                        code: 'INVALID_VALUE_TYPE',
                        operator,
                        value
                    });
                }
                sqlOperator = 'ILIKE';
                params = [pathParts, `${value}%`];
                break;
            case 'ENDS_WITH':
                if (typeof value !== 'string') {
                    throw new MemoryError('ENDS_WITH operator requires a string value', {
                        code: 'INVALID_VALUE_TYPE',
                        operator,
                        value
                    });
                }
                sqlOperator = 'ILIKE';
                params = [pathParts, `%${value}`];
                break;
            case 'ENTITY_FUZZY':
            case 'ENTITY_EXACT':
            case 'ENTITY_ALIAS':
                if (typeof value !== 'string') {
                    throw new MemoryError(`${operator} requires a string value`, {
                        code: 'INVALID_VALUE_TYPE',
                        operator,
                        value,
                    });
                }
                sqlOperator = 'ILIKE';
                params = [pathParts, `%${value}%`];
                break;
            default:
                throw new MemoryError(`Operator "${operator}" is not supported`, {
                    code: 'UNSUPPORTED_OPERATOR',
                    operator
                });
        }

        // PostgreSQL JSONB extraction always returns text, so we need to cast for comparison operators
        const needsNumericCast = typeof value === 'number';
        const needsBooleanCast = typeof value === 'boolean';

        let finalPath = `value #>> $${startParamIndex}::text[]`;
        if (needsNumericCast) {
            finalPath = `(${finalPath})::numeric`;
        } else if (needsBooleanCast) {
            finalPath = `(${finalPath})::boolean`;
        }

        const sql = `${finalPath} ${sqlOperator} $${startParamIndex + 1}`;
        return { sql, params };
    }

    /**
     * Handle queries with entity-aware filters
     */
    private async queryWithEntityFilters<T>(options: GetManyQuery): Promise<MemoryQueryResult<T>[]> {
        const { filters } = options;
        const limit = this.validateQueryLimit(options.limit);
        const tenantId = (options as any)?.tenantId || this.defaultTenantId;
        const { requiredTags } = normalizeRequiredTags(options);

        const parsedFilters = FilterParser.parseFilters(filters || []);
        let query = `
            SELECT key, value, COALESCE(tags, ARRAY[]::text[]) AS tags
            FROM agent_memory_store
            WHERE tenant_id = $1
        `;
        const queryParams: any[] = [tenantId];
        let paramIndex = 2;

        if (requiredTags.length > 0) {
            query += ` AND tags @> $${paramIndex}::text[]`;
            queryParams.push(requiredTags);
            paramIndex++;
        }

        if (parsedFilters.length > 0) {
            const { sql, params, entityCandidateCount } = await this.buildEntityAwareFilterSQL(
                { type: 'group', logic: 'AND', filters: parsedFilters },
                paramIndex,
                tenantId
            );
            query += ` AND (${sql})`;
            queryParams.push(...params);
            paramIndex += params.length;
            this.executionObserver(options as GetManyOptions)?.({
                residualFilter: false,
                scannedRows: entityCandidateCount,
            });
        }

        query += ` ORDER BY ${this.orderSql(options)} LIMIT $${paramIndex}`;
        queryParams.push(limit);

        const observer = this.executionObserver(options as GetManyOptions);
        const startedAt = Date.now();
        const results = await this.prisma.$queryRawUnsafe(query, ...queryParams) as Array<{
            key: string;
            value: unknown;
            tags: string[] | null;
        }>;
        observer?.({ databaseDurationMs: Date.now() - startedAt });
        return this.mapQueryRows<T>(results, tenantId, observer);
    }

    private async buildEntityAwareFilterSQL(
        filter: ParsedFilter,
        paramIndex: number,
        tenantId: string
    ): Promise<{ sql: string; params: unknown[]; entityCandidateCount: number }> {
        if (filter.type === 'group') {
            const parts: string[] = [];
            const params: unknown[] = [];
            let entityCandidateCount = 0;
            for (const child of filter.filters) {
                const compiled = await this.buildEntityAwareFilterSQL(
                    child,
                    paramIndex + params.length,
                    tenantId
                );
                parts.push(`(${compiled.sql})`);
                params.push(...compiled.params);
                entityCandidateCount += compiled.entityCandidateCount;
                if (entityCandidateCount > this.maxResidualScanRows) {
                    throw new SemanticQueryError(
                        'SEMANTIC_QUERY_SCAN_BUDGET_EXCEEDED',
                        'Semantic-memory entity candidate expansion exceeded its configured budget',
                        { details: { maxResidualScanRows: this.maxResidualScanRows } }
                    );
                }
            }
            return { sql: parts.join(` ${filter.logic} `), params, entityCandidateCount };
        }

        if (['ENTITY_FUZZY', 'ENTITY_EXACT', 'ENTITY_ALIAS'].includes(filter.operator)) {
            if (typeof filter.value !== 'string') {
                throw new SemanticQueryError('SEMANTIC_QUERY_INVALID_COMBINATION', 'Entity filter values must be strings');
            }
            const keys = [...await this.findMemoryKeysByEntityFilter(
                filter.path,
                filter.operator as 'ENTITY_FUZZY' | 'ENTITY_EXACT' | 'ENTITY_ALIAS',
                filter.value,
                tenantId
            )];
            if (keys.length > this.maxResidualScanRows) {
                throw new SemanticQueryError(
                    'SEMANTIC_QUERY_SCAN_BUDGET_EXCEEDED',
                    'Semantic-memory entity candidate expansion exceeded its configured budget',
                    { details: { maxResidualScanRows: this.maxResidualScanRows } }
                );
            }
            // Preserve legacy JSON-resident entity matching for records that have not yet been
            // aligned. Alignment candidates and the bounded JSON compatibility predicate are
            // combined before ordering/limit, so hybrid OR expressions cannot under-return.
            const fallback = this.buildFilterRecursiveRawSQL(filter, paramIndex + (keys.length > 0 ? 1 : 0));
            return keys.length === 0
                ? { ...fallback, entityCandidateCount: 0 }
                : {
                    sql: `(key = ANY($${paramIndex}::text[]) OR (${fallback.sql}))`,
                    params: [keys, ...fallback.params],
                    entityCandidateCount: keys.length,
                };
        }

        const compiled = this.buildFilterRecursiveRawSQL(filter, paramIndex);
        return { ...compiled, entityCandidateCount: 0 };
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
        const isArrayPattern = fieldPath.includes('[]');
        const sqlFieldPattern = isArrayPattern ?
            fieldPath.replace('[]', '[%]') :
            fieldPath;
        const expansionLimit = this.maxResidualScanRows + 1;

        if (operator === 'ENTITY_EXACT' || operator === 'ENTITY_ALIAS') {
            let rows: Array<{ memory_key: string }>;
            if (operator === 'ENTITY_EXACT' && isArrayPattern) {
                rows = await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                    SELECT DISTINCT alignment.memory_key
                    FROM entity_alignment AS alignment
                    JOIN entity_store AS entity
                      ON entity.id = alignment.entity_id AND entity.tenant_id = alignment.tenant_id
                    WHERE alignment.tenant_id = ${tenantId}
                      AND alignment.field_path LIKE ${sqlFieldPattern}
                      AND entity.canonical_name = ${searchValue}
                    ORDER BY alignment.memory_key ASC
                    LIMIT ${expansionLimit}
                `;
            } else if (operator === 'ENTITY_EXACT') {
                rows = await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                    SELECT DISTINCT alignment.memory_key
                    FROM entity_alignment AS alignment
                    JOIN entity_store AS entity
                      ON entity.id = alignment.entity_id AND entity.tenant_id = alignment.tenant_id
                    WHERE alignment.tenant_id = ${tenantId}
                      AND alignment.field_path = ${fieldPath}
                      AND entity.canonical_name = ${searchValue}
                    ORDER BY alignment.memory_key ASC
                    LIMIT ${expansionLimit}
                `;
            } else if (isArrayPattern) {
                rows = await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                    SELECT DISTINCT alignment.memory_key
                    FROM entity_alignment AS alignment
                    JOIN entity_store AS entity
                      ON entity.id = alignment.entity_id AND entity.tenant_id = alignment.tenant_id
                    WHERE alignment.tenant_id = ${tenantId}
                      AND alignment.field_path LIKE ${sqlFieldPattern}
                      AND ${searchValue} = ANY(entity.aliases)
                    ORDER BY alignment.memory_key ASC
                    LIMIT ${expansionLimit}
                `;
            } else {
                rows = await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                    SELECT DISTINCT alignment.memory_key
                    FROM entity_alignment AS alignment
                    JOIN entity_store AS entity
                      ON entity.id = alignment.entity_id AND entity.tenant_id = alignment.tenant_id
                    WHERE alignment.tenant_id = ${tenantId}
                      AND alignment.field_path = ${fieldPath}
                      AND ${searchValue} = ANY(entity.aliases)
                    ORDER BY alignment.memory_key ASC
                    LIMIT ${expansionLimit}
                `;
            }
            this.assertEntityExpansionWithinBudget(rows.length);
            return new Set(rows.map((row) => row.memory_key));
        }

        const entities = await this.prisma.entityStore.findMany({
            where: { tenantId },
            select: { id: true, canonicalName: true, aliases: true },
            orderBy: { id: 'asc' },
            take: expansionLimit,
        });
        this.assertEntityExpansionWithinBudget(entities.length);
        const normalizedSearch = this.normalizeForSearch(searchValue);
        const entityIds = entities
            .filter((entity: { canonicalName: string; aliases: string[] }) =>
                this.areTextsSimilar(normalizedSearch, this.normalizeForSearch(entity.canonicalName))
                || entity.aliases.some((alias) => this.areTextsSimilar(normalizedSearch, this.normalizeForSearch(alias)))
            )
            .map((entity: { id: string }) => entity.id);

        if (entityIds.length === 0 && this.embedFunction) {
            try {
                const searchEmbedding = await this.embedFunction(searchValue);
                const similarEntities = await this.prisma.$queryRaw<Array<{ id: string; similarity: number }>>`
                    SELECT id, 1 - (embedding <=> ${searchEmbedding}::vector) AS similarity
                    FROM entity_store
                    WHERE tenant_id = ${tenantId}
                    ORDER BY embedding <=> ${searchEmbedding}::vector
                    LIMIT 20
                `;
                entityIds.push(...similarEntities.filter((entity) => entity.similarity > 0.4).map((entity) => entity.id));
            } catch (error) {
                console.warn('Embedding similarity search failed:', error);
            }
        }
        if (entityIds.length === 0) return new Set();

        const rows = isArrayPattern
            ? await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                SELECT DISTINCT memory_key
                FROM entity_alignment
                WHERE tenant_id = ${tenantId}
                  AND entity_id = ANY(${entityIds}::text[])
                  AND field_path LIKE ${sqlFieldPattern}
                ORDER BY memory_key ASC
                LIMIT ${expansionLimit}
            `
            : await this.prisma.$queryRaw<Array<{ memory_key: string }>>`
                SELECT DISTINCT memory_key
                FROM entity_alignment
                WHERE tenant_id = ${tenantId}
                  AND entity_id = ANY(${entityIds}::text[])
                  AND field_path = ${fieldPath}
                ORDER BY memory_key ASC
                LIMIT ${expansionLimit}
            `;
        this.assertEntityExpansionWithinBudget(rows.length);
        return new Set(rows.map((row) => row.memory_key));
    }

    private assertEntityExpansionWithinBudget(count: number): void {
        if (count <= this.maxResidualScanRows) return;
        throw new SemanticQueryError(
            'SEMANTIC_QUERY_SCAN_BUDGET_EXCEEDED',
            'Semantic-memory entity candidate expansion exceeded its configured budget',
            { details: { maxResidualScanRows: this.maxResidualScanRows } }
        );
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
    private evaluateFilterInMemory(value: any, filter: ParsedFilter): boolean {
        if (filter.type === 'group') {
            if (filter.logic === 'OR') {
                return filter.filters.some(f => this.evaluateFilterInMemory(value, f));
            } else {
                return filter.filters.every(f => this.evaluateFilterInMemory(value, f));
            }
        }

        // Atomic filter
        // If it's an array path, we need to check if ANY element matches
        if (filter.isArrayPath) {
            const values = this.getValuesByPath(value, filter.path);
            return values.some(val => this.evaluateAtomicValue(val, filter.operator, filter.value));
        }

        const fieldValue = this.getValueByPath(value, filter.path);
        return this.evaluateAtomicValue(fieldValue, filter.operator, filter.value);
    }

    private evaluateAtomicValue(fieldValue: any, operator: string, filterValue: any): boolean {
        switch (operator) {
            case '=':
                return fieldValue === filterValue;
            case '!=':
                return fieldValue !== filterValue;
            case '>':
                return fieldValue > filterValue;
            case '>=':
                return fieldValue >= filterValue;
            case '<':
                return fieldValue < filterValue;
            case '<=':
                return fieldValue <= filterValue;
            case 'CONTAINS':
                return String(fieldValue).toLowerCase().includes(String(filterValue).toLowerCase());
            case 'STARTS_WITH':
                return String(fieldValue).toLowerCase().startsWith(String(filterValue).toLowerCase());
            case 'ENDS_WITH':
                return String(fieldValue).toLowerCase().endsWith(String(filterValue).toLowerCase());
            case 'ENTITY_FUZZY':
            case 'ENTITY_EXACT':
            case 'ENTITY_ALIAS':
                return String(fieldValue).toLowerCase().includes(String(filterValue).toLowerCase());
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
     * Get ALL matching values from an object using a dot-notation path with automatic array traversal
     */
    private getValuesByPath(obj: any, path: string): any[] {
        const results: any[] = [];
        this.getValuesByPathRecursive(obj, path.split('.'), 0, results);
        return results;
    }

    /**
     * Recursive helper for getValuesByPath that collects all matching elements
     */
    private getValuesByPathRecursive(obj: any, pathParts: string[], partIndex: number, results: any[]): void {
        if (partIndex >= pathParts.length) {
            results.push(obj);
            return;
        }

        if (!obj || typeof obj !== 'object') {
            return;
        }

        const currentPartRaw = pathParts[partIndex];
        const currentPart = currentPartRaw.replace('[]', '');
        const remainingParts = pathParts.slice(partIndex + 1);

        if (Array.isArray(obj)) {
            for (const item of obj) {
                this.getValuesByPathRecursive(item, pathParts, partIndex, results);
            }
            return;
        }

        if (currentPart in obj) {
            const value = obj[currentPart];
            if (Array.isArray(value)) {
                for (const item of value) {
                    this.getValuesByPathRecursive(item, pathParts, partIndex + 1, results);
                }
            } else {
                this.getValuesByPathRecursive(value, pathParts, partIndex + 1, results);
            }
        }
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

        const currentPartRaw = pathParts[partIndex];
        const currentPart = currentPartRaw.replace('[]', '');
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
    async recognize<T>(candidateData: T, options: RecognitionOptions = {}): Promise<RecognitionResult<T>> {
        if (!this.recognitionService) {
            throw new Error('Recognition service not available. Entity alignment with embedFunction required.');
        }

        // Extract the taskContext from options
        const { taskContext, ...recognitionOptions } = options;

        if (!taskContext) {
            throw new Error('TaskContext is required for recognition');
        }

        return await this.recognitionService.recognize(candidateData, taskContext, recognitionOptions) as RecognitionResult<T>;
    }

    /**
     * Enrich a memory entry by consolidating it with additional data using LLM
     * By default, the enriched data is automatically saved back to memory.
     * Use dryRun: true to preview enrichment without saving.
     */
    async enrich<T>(key: string, additionalData: T[], options: EnrichmentOptions = {}): Promise<EnrichmentResult<T>> {
        if (!this.enrichmentService) {
            throw new Error('Enrichment service not available. Entity alignment with embedFunction required.');
        }

        // Extract the taskContext and dryRun from options  
        const { taskContext, dryRun = false, ...enrichmentOptions } = options;

        if (!taskContext) {
            throw new Error('TaskContext is required for enrichment');
        }

        // Get the existing data and its metadata
        const existingData = await this.get<T>(key, { tenantId: taskContext.tenantId });

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
        const enrichmentResult = await (this.enrichmentService as any).enrich(key, existingData, additionalData, taskContext, enrichmentOptions);

        // If not a dry run, save the enriched data back to memory
        if (!dryRun) {
            // Normalize existing tags when preserving them
            const existingTags = originalMetadata?.tags || [];
            const normalizedTags = normalizeStoredTags(existingTags);

            await this.set(key, enrichmentResult.enrichedData, {
                tenantId: taskContext.tenantId,
                // Preserve existing tags from the original memory entry
                tags: normalizedTags
            });
        }

        // Return the enrichment result with saved flag
        return {
            ...enrichmentResult,
            saved: !dryRun
        } as EnrichmentResult<T>;
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

        // Normalize tags before storage
        const normalizedTags = normalizeStoredTags(options.tags || []);

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
                blobData: buffer as any,
                blobMetadata: blobMetadata,
                tags: normalizedTags,
                updatedAt: new Date()
            },
            create: {
                tenantId,
                key,
                value: { type: 'blob', message: 'Binary data stored in blobData field' },
                blobData: buffer as any,
                blobMetadata: blobMetadata,
                tags: normalizedTags
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
                blobData: null,
                blobMetadata: null as any,
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

        return results.map((result: { key: string; blobMetadata: unknown; tags: string[]; createdAt: Date; updatedAt: Date }) => ({
            key: result.key,
            metadata: result.blobMetadata as any,
            tags: result.tags,
            createdAt: result.createdAt,
            updatedAt: result.updatedAt
        }));
    }
}

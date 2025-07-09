import { PrismaClient } from '@prisma/client';
import { EntityMatch, EntityAlignment, ParsedEntityField, EntityAlignmentOptions, VectorEmbedding } from './types.js';
import { logger } from '@callagent/utils';

const alignmentLogger = logger.createLogger({ prefix: 'EntityAlignment' });

export class EntityAlignmentService {
    constructor(
        private prisma: PrismaClient,
        private embedFunction: (text: string) => Promise<number[]>,
        private options: EntityAlignmentOptions = {
            defaultThreshold: 0.6
        }
    ) { }

    /**
     * Process multiple entity fields for alignment
     */
    async alignEntityFields(
        memoryKey: string,
        entityFields: ParsedEntityField[],
        options: { threshold?: number; autoCreate?: boolean; tenantId?: string } = {}
    ): Promise<Record<string, EntityAlignment | null>> {
        const results: Record<string, EntityAlignment | null> = {};
        const tenantId = options.tenantId || 'default';

        for (const field of entityFields) {
            // Priority: field-specific threshold > global override > default
            const threshold = field.threshold ||
                options.threshold ||
                this.options.defaultThreshold;

            const alignment = await this.alignSingleEntity(
                memoryKey,
                field,
                threshold,
                options.autoCreate ?? true,
                tenantId
            );

            results[field.fieldName] = alignment;
        }

        return results;
    }

    /**
     * Normalize text for better venue name matching
     */
    private normalizeVenueText(text: string): string {
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
     * Extract core terms from venue name for better matching
     */
    private extractCoreTerms(venueText: string): string[] {
        const normalized = this.normalizeVenueText(venueText);
        const words = normalized.split(' ').filter(w => w.length > 0);

        // Remove common prefixes and suffixes
        const stopWords = ['the', 'a', 'an', 'and', 'or', 'of', 'at', 'in', 'on', 'ktmc', 'center', 'centre'];
        const coreWords = words.filter(word => !stopWords.includes(word) && word.length > 2);

        return coreWords;
    }

    /**
     * Check if two venue names are similar based on core terms
     */
    private areVenueNamesSimilar(name1: string, name2: string): boolean {
        const core1 = this.extractCoreTerms(name1);
        const core2 = this.extractCoreTerms(name2);

        // Check for significant overlap in core terms
        const overlap = core1.filter(term => core2.includes(term));
        const minLength = Math.min(core1.length, core2.length);

        // Consider similar if >50% of terms overlap
        return overlap.length > 0 && overlap.length >= minLength * 0.5;
    }

    /**
     * Enhanced entity alignment with multiple strategies
     */
    private async alignSingleEntity(
        memoryKey: string,
        field: ParsedEntityField,
        threshold: number,
        autoCreate: boolean,
        tenantId: string = 'default'
    ): Promise<EntityAlignment | null> {
        alignmentLogger.debug(`Aligning entity: "${field.value}" (type: ${field.entityType}, threshold: ${threshold})`);

        // Strategy 1: Exact match (case-insensitive, normalized)
        const exactMatch = await this.findExactMatch(field.value, field.entityType, tenantId);
        if (exactMatch) {
            alignmentLogger.debug(`Exact match found: "${field.value}" → "${exactMatch.canonicalName}"`);
            await this.addAliasToEntity(exactMatch.entityId, field.value, tenantId);
            await this.storeAlignment(memoryKey, field.fieldName, exactMatch.entityId, field.value, 'high', tenantId);
            return {
                entityId: exactMatch.entityId,
                canonicalName: exactMatch.canonicalName,
                originalValue: field.value,
                confidence: 'high',
                alignedAt: new Date()
            };
        }

        // Strategy 2: Alias match
        const aliasMatch = await this.findAliasMatch(field.value, field.entityType, tenantId);
        if (aliasMatch) {
            alignmentLogger.debug(`Alias match found: "${field.value}" → "${aliasMatch.canonicalName}"`);
            await this.storeAlignment(memoryKey, field.fieldName, aliasMatch.entityId, field.value, 'high', tenantId);
            return {
                entityId: aliasMatch.entityId,
                canonicalName: aliasMatch.canonicalName,
                originalValue: field.value,
                confidence: 'high',
                alignedAt: new Date()
            };
        }

        // Strategy 3: Venue name similarity (for location types)
        if (field.entityType === 'location') {
            const venueMatch = await this.findVenueNameMatch(field.value, tenantId);
            if (venueMatch) {
                alignmentLogger.debug(`Venue name match found: "${field.value}" → "${venueMatch.canonicalName}"`);
                await this.addAliasToEntity(venueMatch.entityId, field.value, tenantId);
                await this.storeAlignment(memoryKey, field.fieldName, venueMatch.entityId, field.value, 'medium', tenantId);
                return {
                    entityId: venueMatch.entityId,
                    canonicalName: venueMatch.canonicalName,
                    originalValue: field.value,
                    confidence: 'medium',
                    alignedAt: new Date()
                };
            }
        }

        // Strategy 4: Embedding similarity (fallback)
        let embedding: number[];
        try {
            embedding = await this.embedFunction(field.value);
        } catch (error) {
            alignmentLogger.warn(`Failed to generate embedding for "${field.value}"`, error);
            return null;
        }

        const matches = await this.findSimilarEntities(
            field.entityType,
            embedding,
            threshold,
            tenantId
        );

        let entityId: string;
        let canonicalName: string;
        let confidence: 'high' | 'medium' | 'low';

        if (matches.length > 0) {
            // Use best match
            const bestMatch = matches[0];
            entityId = bestMatch.entityId;
            canonicalName = bestMatch.canonicalName;
            confidence = bestMatch.confidence;

            alignmentLogger.debug(`Embedding match found: "${field.value}" → "${canonicalName}" (similarity: ${bestMatch.similarity.toFixed(3)})`);

            // Update entity with new alias if not already present
            await this.addAliasToEntity(entityId, field.value, tenantId);
        } else if (autoCreate) {
            // Create new entity
            alignmentLogger.debug(`Creating new entity for "${field.value}"`);
            const newEntity = await this.createNewEntity(
                field.value,
                field.entityType,
                embedding,
                tenantId
            );
            entityId = newEntity.entityId;
            canonicalName = newEntity.canonicalName;
            confidence = 'high';
        } else {
            alignmentLogger.debug(`No match found for "${field.value}" and auto-create disabled`);
            return null;
        }

        // Store alignment record
        await this.storeAlignment(
            memoryKey,
            field.fieldName,
            entityId,
            field.value,
            confidence,
            tenantId
        );

        return {
            entityId,
            canonicalName,
            originalValue: field.value,
            confidence,
            alignedAt: new Date()
        };
    }

    /**
     * Find exact match using normalized text
     */
    private async findExactMatch(
        value: string,
        entityType: string,
        tenantId: string
    ): Promise<{ entityId: string; canonicalName: string } | null> {
        const normalized = this.normalizeVenueText(value);

        const results = await this.prisma.entityStore.findMany({
            where: {
                entityType,
                tenantId,
                OR: [
                    { canonicalName: { equals: value, mode: 'insensitive' } },
                    // Also check if normalized version matches
                ]
            },
            select: { id: true, canonicalName: true }
        });

        if (results.length > 0) {
            return { entityId: results[0].id, canonicalName: results[0].canonicalName };
        }

        // Check normalized matches
        const allEntities = await this.prisma.entityStore.findMany({
            where: { entityType, tenantId },
            select: { id: true, canonicalName: true }
        });

        for (const entity of allEntities) {
            if (this.normalizeVenueText(entity.canonicalName) === normalized) {
                return { entityId: entity.id, canonicalName: entity.canonicalName };
            }
        }

        return null;
    }

    /**
     * Find alias match
     */
    private async findAliasMatch(
        value: string,
        entityType: string,
        tenantId: string
    ): Promise<{ entityId: string; canonicalName: string } | null> {
        const results = await this.prisma.$queryRaw<Array<{ id: string; canonical_name: string }>>`
            SELECT id, canonical_name
            FROM entity_store
            WHERE entity_type = ${entityType} 
            AND tenant_id = ${tenantId}
            AND ${value} = ANY(aliases)
            LIMIT 1
        `;

        if (results.length > 0) {
            return { entityId: results[0].id, canonicalName: results[0].canonical_name };
        }

        return null;
    }

    /**
     * Find venue name match using core term similarity
     */
    private async findVenueNameMatch(
        value: string,
        tenantId: string
    ): Promise<{ entityId: string; canonicalName: string } | null> {
        const allVenues = await this.prisma.entityStore.findMany({
            where: { entityType: 'location', tenantId },
            select: { id: true, canonicalName: true }
        });

        for (const venue of allVenues) {
            if (this.areVenueNamesSimilar(value, venue.canonicalName)) {
                return { entityId: venue.id, canonicalName: venue.canonicalName };
            }
        }

        return null;
    }

    private async findSimilarEntities(
        entityType: string,
        embedding: number[],
        threshold: number,
        tenantId: string = 'default'
    ): Promise<EntityMatch[]> {
        alignmentLogger.debug(`Searching for similar entities of type "${entityType}" with threshold ${threshold}`);

        // First, get ALL entities of this type to see their similarities
        const allResults = await this.prisma.$queryRaw<Array<{
            id: string;
            canonical_name: string;
            similarity: number;
        }>>`
            SELECT 
                id,
                canonical_name,
                1 - (embedding <=> ${embedding}::vector) as similarity
            FROM entity_store 
            WHERE entity_type = ${entityType} AND tenant_id = ${tenantId}
            ORDER BY embedding <=> ${embedding}::vector
            LIMIT 10
        `;

        alignmentLogger.debug(`All entities of type "${entityType}":`, allResults.map(r => ({
            name: r.canonical_name,
            similarity: r.similarity.toFixed(3)
        })));

        // Filter by threshold
        const results = allResults.filter(r => r.similarity > threshold);

        alignmentLogger.debug(`Found ${results.length} similar entities above threshold ${threshold}:`, results.map(r => ({
            name: r.canonical_name,
            similarity: r.similarity.toFixed(3)
        })));

        return results.map(r => ({
            entityId: r.id,
            canonicalName: r.canonical_name,
            similarity: r.similarity,
            confidence: r.similarity > 0.95 ? 'high' :
                r.similarity > 0.85 ? 'medium' : 'low'
        }));
    }

    private async createNewEntity(
        value: string,
        entityType: string,
        embedding: number[],
        tenantId: string = 'default'
    ): Promise<{ entityId: string; canonicalName: string }> {
        // Use raw SQL to create entity since Prisma types don't handle vector properly
        const result = await this.prisma.$queryRaw<Array<{ id: string }>>`
            INSERT INTO entity_store (id, entity_type, canonical_name, aliases, embedding, metadata, confidence, tenant_id, created_at, updated_at)
            VALUES (
                gen_random_uuid()::text,
                ${entityType},
                ${value},
                ARRAY[${value}],
                ${embedding}::vector,
                '{}'::jsonb,
                1.0,
                ${tenantId},
                NOW(),
                NOW()
            )
            RETURNING id
        `;

        return {
            entityId: result[0].id,
            canonicalName: value
        };
    }

    private async addAliasToEntity(entityId: string, alias: string, tenantId: string = 'default'): Promise<void> {
        // Check if alias already exists and add if not
        await this.prisma.$executeRaw`
            UPDATE entity_store 
            SET aliases = array_append(aliases, ${alias})
            WHERE id = ${entityId} AND tenant_id = ${tenantId}
            AND NOT (${alias} = ANY(aliases))
        `;
    }

    private async storeAlignment(
        memoryKey: string,
        fieldPath: string,
        entityId: string,
        originalValue: string,
        confidence: 'high' | 'medium' | 'low',
        tenantId: string = 'default'
    ): Promise<void> {
        await this.prisma.$executeRaw`
            INSERT INTO entity_alignment (id, tenant_id, memory_key, field_path, entity_id, original_value, confidence, aligned_at)
            VALUES (gen_random_uuid()::text, ${tenantId}, ${memoryKey}, ${fieldPath}, ${entityId}, ${originalValue}, ${confidence}, NOW())
            ON CONFLICT (tenant_id, memory_key, field_path) 
            DO UPDATE SET 
                entity_id = EXCLUDED.entity_id,
                original_value = EXCLUDED.original_value,
                confidence = EXCLUDED.confidence,
                aligned_at = NOW()
        `;
    }

    // Manual override methods
    async unlinkEntity(memoryKey: string, fieldPath: string, tenantId: string = 'default'): Promise<void> {
        await this.prisma.$executeRaw`
            DELETE FROM entity_alignment 
            WHERE memory_key = ${memoryKey} AND field_path = ${fieldPath} AND tenant_id = ${tenantId}
        `;
    }

    async forceRealign(
        memoryKey: string,
        fieldPath: string,
        newEntityId: string,
        tenantId: string = 'default'
    ): Promise<void> {
        // Check if entity exists
        const entity = await this.prisma.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM entity_store WHERE id = ${newEntityId} AND tenant_id = ${tenantId}
        `;

        if (entity.length === 0) {
            throw new Error(`Entity with ID ${newEntityId} not found`);
        }

        await this.prisma.$executeRaw`
            UPDATE entity_alignment 
            SET entity_id = ${newEntityId}, confidence = 'high', aligned_at = NOW()
            WHERE memory_key = ${memoryKey} AND field_path = ${fieldPath} AND tenant_id = ${tenantId}
        `;
    }

    async getEntityStats(entityType?: string, tenantId: string = 'default'): Promise<{
        totalEntities: number;
        totalAlignments: number;
        entitiesByType: Record<string, number>;
    }> {
        const whereClause = entityType
            ? `WHERE entity_type = '${entityType}' AND tenant_id = '${tenantId}'`
            : `WHERE tenant_id = '${tenantId}'`;

        const [totalEntitiesResult, totalAlignmentsResult, entitiesByTypeResult] = await Promise.all([
            this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
                `SELECT COUNT(*) as count FROM entity_store ${whereClause}`
            ),
            this.prisma.$queryRaw<Array<{ count: bigint }>>`
                SELECT COUNT(*) as count FROM entity_alignment WHERE tenant_id = ${tenantId}
            `,
            this.prisma.$queryRaw<Array<{ entity_type: string; count: bigint }>>`
                SELECT entity_type, COUNT(*) as count 
                FROM entity_store 
                WHERE tenant_id = ${tenantId}
                GROUP BY entity_type
            `
        ]);

        const typeStats = entitiesByTypeResult.reduce((acc, item) => {
            acc[item.entity_type] = Number(item.count);
            return acc;
        }, {} as Record<string, number>);

        return {
            totalEntities: Number(totalEntitiesResult[0].count),
            totalAlignments: Number(totalAlignmentsResult[0].count),
            entitiesByType: typeStats
        };
    }
} 
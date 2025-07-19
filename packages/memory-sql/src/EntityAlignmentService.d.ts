import { PrismaClient } from '@prisma/client';
import { EntityAlignment, ParsedEntityField, EntityAlignmentOptions } from './types.js';
export declare class EntityAlignmentService {
    private prisma;
    private embedFunction;
    private options;
    constructor(prisma: PrismaClient, embedFunction: (text: string) => Promise<number[]>, options?: EntityAlignmentOptions);
    /**
     * Process multiple entity fields for alignment
     */
    alignEntityFields(memoryKey: string, entityFields: ParsedEntityField[], options?: {
        threshold?: number;
        autoCreate?: boolean;
        tenantId?: string;
        previousFieldPaths?: string[];
    }): Promise<Record<string, EntityAlignment | null>>;
    /**
     * NEW: Cleanup orphaned alignments
     */
    cleanupOrphanedAlignments(memoryKey: string, orphanedFieldPaths: string[], tenantId: string): Promise<void>;
    /**
     * Normalize text for better name matching (generic for all entity types)
     */
    private normalizeText;
    /**
     * Extract core terms from text for better matching (generic)
     */
    private extractCoreTerms;
    /**
     * Check if two texts are similar based on core terms (generic)
     */
    private areTextsSimilar;
    /**
     * Enhanced entity alignment with multiple strategies
     */
    private alignSingleEntity;
    /**
     * Find exact match using normalized text
     */
    private findExactMatch;
    /**
     * Find alias match
     */
    private findAliasMatch;
    /**
     * Find text similarity match using core term similarity (generic for all entity types)
     */
    private findTextSimilarityMatch;
    private findSimilarEntities;
    private createNewEntity;
    private addAliasToEntity;
    private storeAlignment;
    unlinkEntity(memoryKey: string, fieldPath: string, tenantId?: string): Promise<void>;
    forceRealign(memoryKey: string, fieldPath: string, newEntityId: string, tenantId?: string): Promise<void>;
    getEntityStats(entityType?: string, tenantId?: string): Promise<{
        totalEntities: number;
        totalAlignments: number;
        entitiesByType: Record<string, number>;
    }>;
}

import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';
/**
 * Hallucination Mitigator Interface - reduces hallucinations and ensures accuracy
 * Implements fact-checking, consistency verification, and source validation
 */
export type IHallucinationMitigator = IStageProcessor & {
    readonly stageName: 'utilization';
    readonly componentName: 'hallucinationMitigation';
    /**
     * Apply hallucination mitigation to memory items
     * @param item Memory item to process
     * @returns Memory item with mitigation metadata
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Configure hallucination mitigation
     */
    configure(config: {
        enabled?: boolean;
        placeholder?: boolean;
        consistencyChecking?: boolean;
        conversationAware?: boolean;
        factChecking?: boolean;
        sourceVerification?: boolean;
        researchMode?: boolean;
        confidenceThreshold?: number;
        [key: string]: unknown;
    }): void;
    /**
     * Verify content against known facts
     */
    verifyContent(content: string, sources: MemoryItem<unknown>[], options?: {
        strictMode?: boolean;
        allowPartialMatches?: boolean;
        requireMultipleSources?: boolean;
    }): Promise<{
        isVerified: boolean;
        confidence: number;
        issues: Array<{
            type: 'factual_error' | 'unsupported_claim' | 'contradiction' | 'missing_source';
            description: string;
            severity: 'low' | 'medium' | 'high';
            suggestion: string;
        }>;
        supportingEvidence: MemoryItem<unknown>[];
    }>;
    /**
     * Check consistency across memory items
     */
    checkConsistency(items: MemoryItem<unknown>[], options?: {
        temporalAware?: boolean;
        contextSensitive?: boolean;
        allowEvolution?: boolean;
    }): Promise<{
        isConsistent: boolean;
        consistencyScore: number;
        conflicts: Array<{
            item1: MemoryItem<unknown>;
            item2: MemoryItem<unknown>;
            conflictType: 'direct_contradiction' | 'temporal_inconsistency' | 'logical_conflict';
            severity: number;
            description: string;
            resolution: string;
        }>;
        recommendations: string[];
    }>;
    /**
     * Detect potential hallucinations in content
     */
    detectHallucinations(content: string, context: MemoryItem<unknown>[], options?: {
        sensitivityLevel?: 'low' | 'medium' | 'high';
        checkTypes?: string[];
    }): Promise<{
        hallucinationRisk: number;
        detectedIssues: Array<{
            type: 'fabricated_fact' | 'impossible_claim' | 'anachronism' | 'logical_impossibility';
            content: string;
            confidence: number;
            explanation: string;
        }>;
        mitigationSuggestions: string[];
    }>;
    /**
     * Validate sources and references
     */
    validateSources(content: string, claimedSources: string[], availableSources: MemoryItem<unknown>[]): Promise<{
        validSources: string[];
        invalidSources: string[];
        missingSources: string[];
        sourceQuality: Record<string, {
            reliability: number;
            relevance: number;
            recency: number;
        }>;
    }>;
    /**
     * Generate confidence scores for statements
     */
    generateConfidenceScores(statements: string[], supportingEvidence: MemoryItem<unknown>[]): Promise<Array<{
        statement: string;
        confidence: number;
        evidenceStrength: number;
        uncertaintyFactors: string[];
        recommendedActions: string[];
    }>>;
    /**
     * Cross-reference information across sources
     */
    crossReferenceInformation(claim: string, sources: MemoryItem<unknown>[]): Promise<{
        supportingCount: number;
        contradictingCount: number;
        neutralCount: number;
        consensus: 'strong' | 'moderate' | 'weak' | 'conflicted';
        evidenceQuality: number;
        crossReferences: Array<{
            source: MemoryItem<unknown>;
            support: 'supporting' | 'contradicting' | 'neutral';
            relevance: number;
            excerpt: string;
        }>;
    }>;
    /**
     * Get hallucination mitigation statistics
     */
    getMitigationStats(): {
        totalItemsProcessed: number;
        hallucinationsDetected: number;
        consistencyIssues: number;
        factCheckingResults: {
            verified: number;
            unverified: number;
            contradicted: number;
        };
        averageConfidenceScore: number;
        mitigationStrategies: Record<string, number>;
    };
};

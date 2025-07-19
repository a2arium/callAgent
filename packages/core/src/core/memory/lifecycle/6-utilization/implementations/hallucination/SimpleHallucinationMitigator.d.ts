import { IHallucinationMitigator } from '../../interfaces/IHallucinationMitigator.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class SimpleHallucinationMitigator implements IHallucinationMitigator {
    readonly stageName: "utilization";
    readonly componentName: "hallucinationMitigation";
    readonly stageNumber = 6;
    private logger;
    private metrics;
    private stats;
    /**
     * PHASE 1: No-op hallucination mitigation
     *   - Appends stageName, returns the item unchanged.
     *
     * FUTURE (Phase 2+):
     *   - Implement fact-checking against knowledge bases
     *   - Use LLM-based consistency verification
     *   - Implement source validation and cross-referencing
     *   - Libraries:
     *       • Fact-checking APIs (Google Fact Check Tools API)
     *       • Knowledge graph validation (Wikidata, DBpedia)
     *       • LLM-based verification with confidence scoring
     *       • Semantic similarity for contradiction detection
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
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
    generateConfidenceScores(statements: string[], supportingEvidence: MemoryItem<unknown>[]): Promise<Array<{
        statement: string;
        confidence: number;
        evidenceStrength: number;
        uncertaintyFactors: string[];
        recommendedActions: string[];
    }>>;
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
    getMetrics(): ProcessorMetrics;
}

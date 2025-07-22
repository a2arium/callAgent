import { EnrichmentOptions, EnrichmentResult } from '@a2arium/callagent-types';
/**
 * Service that implements the enrich() functionality for semantic memory
 */
export declare class EnrichmentService {
    /**
     * Enrich a memory entry by consolidating it with additional data using LLM
     */
    enrich<T>(key: string, existingData: T, additionalData: T[], taskContext: any, // TaskContext from @a2arium/core  
    options: EnrichmentOptions): Promise<EnrichmentResult<T>>;
    /**
     * Analyze differences between existing data and additional data sources
     */
    private analyzeDataDifferences;
    /**
     * Auto-resolve simple conflicts without LLM
     */
    private autoResolveSimpleConflicts;
    /**
     * Use LLM to perform complex enrichment
     */
    private performLLMEnrichment;
    /**
     * Build comprehensive prompt for LLM enrichment
     */
    private buildEnrichmentPrompt;
    /**
     * Get the agent's goal from working memory
     */
    private getAgentGoal;
    /**
     * Generate changes by comparing original and enriched data
     */
    private generateChangesFromComparison;
    /**
     * Convert any value to string for change logging
     */
    private valueToString;
    private isSimpleConflict;
    private resolveSimpleConflict;
    private getAllFieldPaths;
    private getNestedValue;
    private setNestedValue;
}

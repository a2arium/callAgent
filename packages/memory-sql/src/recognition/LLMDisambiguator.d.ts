/**
 * Uses LLM to disambiguate between similar objects when confidence scores are uncertain
 */
export declare class LLMDisambiguator {
    /**
     * Determine if two objects represent the same entity using LLM
     * Requires a TaskContext with LLM capabilities
     */
    disambiguateMatch<T>(candidateData: T, existingData: T, confidence: number, taskContext: any, // TaskContext from @callagent/core
    options?: {
        customPrompt?: string;
        agentGoal?: string;
    }): Promise<{
        isMatch: boolean;
        explanation: string;
        adjustedConfidence: number;
    }>;
    /**
     * Build a comprehensive prompt for LLM disambiguation
     */
    private buildDisambiguationPrompt;
}

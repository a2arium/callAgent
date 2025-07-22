/**
 * Uses LLM to disambiguate between similar objects when confidence scores are uncertain
 */
export class LLMDisambiguator {
    /**
     * Determine if two objects represent the same entity using LLM
     * Requires a TaskContext with LLM capabilities
     */
    async disambiguateMatch<T>(
        candidateData: T,
        existingData: T,
        confidence: number,
        taskContext: any, // TaskContext from @a2arium/core
        options: {
            customPrompt?: string;
            agentGoal?: string;
        } = {}
    ): Promise<{
        isMatch: boolean;
        explanation: string;
        adjustedConfidence: number;
    }> {
        const prompt = this.buildDisambiguationPrompt(
            candidateData,
            existingData,
            confidence,
            options.customPrompt,
            options.agentGoal
        );

        const llm = taskContext.llm;

        try {
            const responses = await llm.call(prompt, {
                jsonSchema: {
                    name: 'DisambiguationResult',
                    schema: {
                        type: 'object',
                        properties: {
                            reasoning: {
                                type: 'string',
                                description: 'Brief explanation of the decision'
                            },
                            isMatch: {
                                type: 'boolean',
                                description: 'Whether the two objects represent the same entity'
                            },
                            confidence: {
                                type: 'number',
                                description: 'Confidence score between 0 and 1 for this decision',
                                minimum: 0,
                                maximum: 1
                            }
                        },
                        required: ['isMatch', 'confidence', 'reasoning']
                    }
                },
                responseFormat: 'json',
                settings: {
                    temperature: 0.1 // Low temperature for consistent decisions
                }
            });

            if (responses.length === 0) {
                throw new Error('No response from LLM');
            }

            const result = JSON.parse(responses[0].content);

            return {
                isMatch: result.isMatch,
                explanation: result.reasoning,
                adjustedConfidence: result.confidence
            };

        } catch (error) {
            // Fallback to original confidence if LLM fails
            console.warn('LLM disambiguation failed:', error);
            return {
                isMatch: confidence > 0.75,
                explanation: `LLM disambiguation failed, using confidence threshold: ${confidence}`,
                adjustedConfidence: confidence
            };
        }
    }

    /**
     * Build a comprehensive prompt for LLM disambiguation
     */
    private buildDisambiguationPrompt<T>(
        candidateData: T,
        existingData: T,
        confidence: number,
        customPrompt?: string,
        agentGoal?: string
    ): string {
        if (customPrompt) {
            return customPrompt
                .replace('${candidateData}', JSON.stringify(candidateData, null, 2))
                .replace('${existingData}', JSON.stringify(existingData, null, 2))
                .replace('${confidence}', confidence.toString());
        }

        const contextSection = agentGoal
            ? `\n\nCONTEXT: This comparison is being done as part of: ${agentGoal}`
            : '';

        return `I need to determine if these two data objects represent the same real-world entity.

OBJECT 1 (Candidate):
${JSON.stringify(candidateData, null, 2)}

OBJECT 2 (Existing):
${JSON.stringify(existingData, null, 2)}

ANALYSIS CONTEXT:
- Algorithmic confidence score: ${confidence.toFixed(3)} (where 1.0 = identical, 0.0 = completely different).
- This score suggests the objects are similar but not definitively the same and it is a bit ambiguous to make a decision.
- I need your expert judgment to make the final determination${contextSection}

INSTRUCTIONS:
1. Compare the key identifying information (names, titles, locations, dates, etc.)
2. Look for variations that could indicate the same entity (different spellings, abbreviations, formatting)
3. Consider if these could be the same entity with updated/different information
4. Be strict about matches - only return true if you're confident they represent the same entity

Please analyze and return:
- isMatch: true/false
- confidence: your confidence in this decision (0.0-1.0)
- reasoning: brief explanation of your decision`;
    }
} 
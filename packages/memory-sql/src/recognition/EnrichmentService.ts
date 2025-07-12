import { EnrichmentOptions, EnrichmentResult } from '@callagent/types';

/**
 * Service that implements the enrich() functionality for semantic memory
 */
export class EnrichmentService {
    /**
     * Enrich a memory entry by consolidating it with additional data using LLM
     */
    async enrich<T>(
        key: string,
        existingData: T,
        additionalData: T[],
        taskContext: any, // TaskContext from @callagent/core  
        options: EnrichmentOptions
    ): Promise<EnrichmentResult<T>> {
        const {
            customPrompt,
            focusFields,
            schema,
            forceLLMEnrichment = false
        } = options;

        // Step 1: Analyze differences and conflicts
        const analysis = this.analyzeDataDifferences(existingData, additionalData);

        // Step 2: Auto-resolve simple conflicts if not forcing LLM
        let resolvedData = existingData;
        const changes: Array<{
            field: string;
            action: 'added' | 'updated' | 'resolved_conflict' | 'combined';
            oldValue?: any;
            newValue: any;
            source: 'llm' | 'automatic';
        }> = [];

        if (!forceLLMEnrichment) {
            const autoResolved = this.autoResolveSimpleConflicts(
                existingData,
                additionalData,
                analysis
            );
            resolvedData = autoResolved.data;
            changes.push(...autoResolved.changes);
        }

        // Step 3: Use LLM for complex enrichment if needed
        if (analysis.hasComplexConflicts || forceLLMEnrichment) {
            const agentGoal = await this.getAgentGoal(taskContext);
            const llmResult = await this.performLLMEnrichment(
                resolvedData,
                additionalData,
                analysis,
                taskContext,
                {
                    customPrompt,
                    focusFields,
                    schema,
                    agentGoal
                }
            );

            resolvedData = llmResult.enrichedData;
            changes.push(...llmResult.changes);

            return {
                enrichedData: resolvedData,
                changes,
                usedLLM: true,
                explanation: llmResult.explanation
            };
        }

        return {
            enrichedData: resolvedData,
            changes,
            usedLLM: false
        };
    }

    /**
     * Analyze differences between existing data and additional data sources
     */
    private analyzeDataDifferences<T>(
        existingData: T,
        additionalData: T[]
    ): DataAnalysis {
        const conflicts: FieldConflict[] = [];
        const additions: FieldAddition[] = [];
        let hasComplexConflicts = false;

        const existingFields = this.getAllFieldPaths(existingData);
        const allAdditionalFields = new Map<string, any[]>();

        // Collect all field values from additional data
        for (const data of additionalData) {
            const fields = this.getAllFieldPaths(data);
            for (const field of fields) {
                const value = this.getNestedValue(data, field);
                if (!allAdditionalFields.has(field)) {
                    allAdditionalFields.set(field, []);
                }
                allAdditionalFields.get(field)!.push(value);
            }
        }

        // Analyze each field
        for (const [field, additionalValues] of allAdditionalFields.entries()) {
            const existingValue = this.getNestedValue(existingData, field);

            if (!existingFields.includes(field)) {
                // New field - addition
                const uniqueValues = [...new Set(additionalValues.map(v => JSON.stringify(v)))].map(v => JSON.parse(v));
                additions.push({
                    field,
                    values: uniqueValues,
                    isSimple: uniqueValues.length === 1
                });
            } else {
                // Existing field - check for conflicts
                const allValues = [existingValue, ...additionalValues];
                const uniqueValues = [...new Set(allValues.map(v => JSON.stringify(v)))].map(v => JSON.parse(v));

                if (uniqueValues.length > 1) {
                    const isSimple = this.isSimpleConflict(uniqueValues, field);
                    conflicts.push({
                        field,
                        existingValue,
                        additionalValues,
                        uniqueValues,
                        isSimple
                    });

                    if (!isSimple) {
                        hasComplexConflicts = true;
                    }
                }
            }
        }

        return {
            conflicts,
            additions,
            hasComplexConflicts
        };
    }

    /**
     * Auto-resolve simple conflicts without LLM
     */
    private autoResolveSimpleConflicts<T>(
        existingData: T,
        additionalData: T[],
        analysis: DataAnalysis
    ): { data: T; changes: any[] } {
        const result = JSON.parse(JSON.stringify(existingData)); // Deep clone
        const changes: any[] = [];

        // Add new fields (simple additions)
        for (const addition of analysis.additions) {
            if (addition.isSimple) {
                this.setNestedValue(result, addition.field, addition.values[0]);
                changes.push({
                    field: addition.field,
                    action: 'added',
                    newValue: this.valueToString(addition.values[0]),
                    source: 'automatic'
                });
            }
        }

        // Resolve simple conflicts
        for (const conflict of analysis.conflicts) {
            if (conflict.isSimple) {
                const resolvedValue = this.resolveSimpleConflict(conflict);
                if (resolvedValue !== undefined) {
                    this.setNestedValue(result, conflict.field, resolvedValue);
                    changes.push({
                        field: conflict.field,
                        action: 'resolved_conflict',
                        oldValue: this.valueToString(conflict.existingValue),
                        newValue: this.valueToString(resolvedValue),
                        source: 'automatic'
                    });
                }
            }
        }

        return { data: result, changes };
    }

    /**
     * Use LLM to perform complex enrichment
     */
    private async performLLMEnrichment<T>(
        baseData: T,
        additionalData: T[],
        analysis: DataAnalysis,
        taskContext: any,
        options: {
            customPrompt?: string;
            focusFields?: string[];
            schema?: any;
            agentGoal?: string;
        }
    ): Promise<{
        enrichedData: T;
        changes: any[];
        explanation: string;
    }> {
        const prompt = this.buildEnrichmentPrompt(
            baseData,
            additionalData,
            analysis,
            options
        );

        const llm = taskContext.llm;

        try {
            const responses = await llm.call(prompt, {
                jsonSchema: {
                    name: 'enrichedData',
                    schema: options.schema,
                },
                settings: {
                    temperature: 0.2 // Low temperature for consistent data handling
                }
            });

            if (responses.length === 0) {
                throw new Error('No response from LLM');
            }

            const enrichedData = JSON.parse(responses[0].content);

            // Track changes by comparing original and enriched data
            const changes = this.generateChangesFromComparison(baseData, enrichedData);

            return {
                enrichedData,
                changes,
                explanation: 'LLM enrichment completed'
            };

        } catch (error) {
            console.warn('LLM enrichment failed:', error);
            // Fallback to the base data
            return {
                enrichedData: baseData,
                changes: [],
                explanation: `LLM enrichment failed: ${error}`
            };
        }
    }

    /**
     * Build comprehensive prompt for LLM enrichment
     */
    private buildEnrichmentPrompt<T>(
        baseData: T,
        additionalData: T[],
        analysis: DataAnalysis,
        options: {
            customPrompt?: string;
            focusFields?: string[];
            agentGoal?: string;
        }
    ): string {
        if (options.customPrompt) {
            return options.customPrompt
                .replace('${baseData}', JSON.stringify(baseData, null, 2))
                .replace('${additionalData}', JSON.stringify(additionalData, null, 2))
                .replace('${analysis}', JSON.stringify(analysis, null, 2));
        }

        const contextSection = options.agentGoal
            ? `\n\nCONTEXT: This enrichment is being done as part of: ${options.agentGoal}`
            : '';

        const focusSection = options.focusFields && options.focusFields.length > 0
            ? `\n\nFOCUS FIELDS: Pay special attention to these fields: ${options.focusFields.join(', ')}`
            : '';

        return `I need to enrich and consolidate data from multiple sources into a single, comprehensive object.

BASE DATA (existing):
${JSON.stringify(baseData, null, 2)}

ADDITIONAL DATA SOURCES:
${additionalData.map((data, i) => `Source ${i + 1}:\n${JSON.stringify(data, null, 2)}`).join('\n\n')}

ANALYSIS:
- Conflicts found: ${analysis.conflicts.length}
- New fields to add: ${analysis.additions.length}
- Complex conflicts requiring LLM: ${analysis.hasComplexConflicts}

DETAILED CONFLICTS:
${analysis.conflicts.map(c => `Field "${c.field}": ${c.uniqueValues.length} different values`).join('\n')}${contextSection}${focusSection}

INSTRUCTIONS:
1. Create an enriched version by intelligently combining all data sources
2. Resolve conflicts by choosing the most accurate/complete information
3. Add missing fields from additional sources
4. Maintain data consistency and logical relationships
5. For arrays, merge intelligently (avoid duplicates, preserve structure)
6. For objects, combine fields from all sources
7. For conflicting simple values, choose the most recent or complete one

Return ONLY the final enriched data object (not wrapped in any other structure).`;
    }

    /**
     * Get the agent's goal from working memory
     */
    private async getAgentGoal(taskContext: any): Promise<string | undefined> {
        try {
            if (taskContext.memory?.working?.get) {
                const goal = await taskContext.memory.working.get('goal');
                return goal ? String(goal) : undefined;
            }
        } catch (error) {
            // Ignore errors, goal is optional
        }
        return undefined;
    }



    // Helper methods for data analysis and manipulation

    /**
     * Generate changes by comparing original and enriched data
     */
    private generateChangesFromComparison<T>(original: T, enriched: T): any[] {
        const changes: any[] = [];

        // Simple comparison - just track that LLM enrichment happened
        changes.push({
            field: 'data',
            action: 'llm_enriched',
            oldValue: this.valueToString(original),
            newValue: this.valueToString(enriched),
            source: 'llm'
        });

        return changes;
    }

    /**
     * Convert any value to string for change logging
     */
    private valueToString(value: any): string {
        if (value === null || value === undefined) {
            return String(value);
        }
        if (typeof value === 'string') {
            return value;
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }
        // For objects and arrays, use JSON string
        return JSON.stringify(value);
    }

    private isSimpleConflict(values: any[], field: string): boolean {
        // Simple conflicts are those that can be resolved automatically
        // Examples: null vs value, empty string vs value, similar strings

        if (values.length <= 1) return true;

        // Check for null/undefined vs real values
        const nonNullValues = values.filter(v => v !== null && v !== undefined && v !== '');
        if (nonNullValues.length <= 1) return true;

        // Check for string length differences (longer is usually better)
        if (values.every(v => typeof v === 'string')) {
            const lengths = values.map(v => v.length);
            const maxLength = Math.max(...lengths);
            const minLength = Math.min(...lengths);
            return maxLength > minLength * 2; // Simple if one is significantly longer
        }

        // Check for array length differences  
        if (values.every(v => Array.isArray(v))) {
            const lengths = values.map(v => v.length);
            const maxLength = Math.max(...lengths);
            const minLength = Math.min(...lengths);
            return maxLength > minLength; // Simple if one has more items
        }

        return false; // Complex conflict
    }

    private resolveSimpleConflict(conflict: FieldConflict): any {
        const values = conflict.uniqueValues;

        // Remove null/undefined/empty values
        const nonEmptyValues = values.filter(v =>
            v !== null && v !== undefined && v !== '' &&
            !(Array.isArray(v) && v.length === 0) &&
            !(typeof v === 'object' && Object.keys(v).length === 0)
        );

        if (nonEmptyValues.length === 1) {
            return nonEmptyValues[0];
        }

        if (nonEmptyValues.length === 0) {
            return conflict.existingValue;
        }

        // For strings, prefer the longest
        if (nonEmptyValues.every(v => typeof v === 'string')) {
            return nonEmptyValues.reduce((longest, current) =>
                current.length > longest.length ? current : longest
            );
        }

        // For arrays, prefer the longest
        if (nonEmptyValues.every(v => Array.isArray(v))) {
            return nonEmptyValues.reduce((longest, current) =>
                current.length > longest.length ? current : longest
            );
        }

        // Default to existing value for complex cases
        return conflict.existingValue;
    }

    private getAllFieldPaths(obj: any, prefix = ''): string[] {
        const paths: string[] = [];

        if (obj === null || typeof obj !== 'object') {
            return [];
        }

        if (Array.isArray(obj)) {
            if (obj.length > 0) {
                const firstElementPaths = this.getAllFieldPaths(obj[0], prefix);
                paths.push(...firstElementPaths);
            }
        } else {
            for (const [key, value] of Object.entries(obj)) {
                const currentPath = prefix ? `${prefix}.${key}` : key;
                paths.push(currentPath);

                if (value && typeof value === 'object') {
                    const nestedPaths = this.getAllFieldPaths(value, currentPath);
                    paths.push(...nestedPaths);
                }
            }
        }

        return paths;
    }

    private getNestedValue(obj: any, path: string): any {
        return path.split('.').reduce((current, key) => {
            if (current === null || current === undefined) return undefined;

            if (Array.isArray(current) && !isNaN(Number(key))) {
                return current[Number(key)];
            }

            if (Array.isArray(current) && current.length > 0) {
                return current[0][key];
            }

            return current[key];
        }, obj);
    }

    private setNestedValue(obj: any, path: string, value: any): void {
        const keys = path.split('.');
        const lastKey = keys.pop()!;

        let current = obj;
        for (const key of keys) {
            if (!(key in current)) {
                current[key] = {};
            }
            current = current[key];
        }

        current[lastKey] = value;
    }
}

// Supporting types

type DataAnalysis = {
    conflicts: FieldConflict[];
    additions: FieldAddition[];
    hasComplexConflicts: boolean;
};

type FieldConflict = {
    field: string;
    existingValue: any;
    additionalValues: any[];
    uniqueValues: any[];
    isSimple: boolean;
};

type FieldAddition = {
    field: string;
    values: any[];
    isSimple: boolean;
}; 
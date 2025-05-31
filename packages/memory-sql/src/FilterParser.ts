import { MemoryFilter, FilterOperator } from '@callagent/types';

/**
 * Parser for string-based filter syntax
 * Converts strings like 'priority >= 8' to { path: 'priority', operator: '>=', value: 8 }
 */
export class FilterParser {
    private static readonly OPERATOR_PATTERNS = [
        { pattern: /\s*(>=)\s*/, operator: '>=' as FilterOperator },
        { pattern: /\s*(<=)\s*/, operator: '<=' as FilterOperator },
        { pattern: /\s*(!=)\s*/, operator: '!=' as FilterOperator },
        { pattern: /\s*(>)\s*/, operator: '>' as FilterOperator },
        { pattern: /\s*(<)\s*/, operator: '<' as FilterOperator },
        { pattern: /\s*(=)\s*/, operator: '=' as FilterOperator },
        { pattern: /\s+contains\s+/i, operator: 'CONTAINS' as FilterOperator },
        { pattern: /\s+starts_with\s+/i, operator: 'STARTS_WITH' as FilterOperator },
        { pattern: /\s+ends_with\s+/i, operator: 'ENDS_WITH' as FilterOperator },
    ];

    /**
     * Parse a string filter into a filter object
     * @param filterString String like 'priority >= 8' or 'name contains "John"'
     * @returns Parsed filter object
     */
    static parseFilter(filterString: string): { path: string; operator: FilterOperator; value: any } {
        const trimmed = filterString.trim();

        // Find the operator in the string
        for (const { pattern, operator } of this.OPERATOR_PATTERNS) {
            const match = trimmed.match(pattern);
            if (match) {
                const operatorIndex = match.index!;
                const operatorLength = match[0].length;

                // Extract path (before operator)
                const path = trimmed.substring(0, operatorIndex).trim();
                if (!path) {
                    throw new Error(`Invalid filter: missing path in "${filterString}"`);
                }

                // Extract value (after operator)
                const valueStr = trimmed.substring(operatorIndex + operatorLength).trim();
                if (!valueStr) {
                    throw new Error(`Invalid filter: missing value in "${filterString}"`);
                }

                // Parse the value
                const value = this.parseValue(valueStr);

                return {
                    path,
                    operator,
                    value
                };
            }
        }

        throw new Error(`Invalid filter: no valid operator found in "${filterString}"`);
    }

    /**
     * Parse a value string into the appropriate type
     * @param valueStr String representation of the value
     * @returns Parsed value (string, number, boolean, or null)
     */
    private static parseValue(valueStr: string): any {
        const trimmed = valueStr.trim();

        // Handle quoted strings
        if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
            (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
            return trimmed.slice(1, -1);
        }

        // Handle booleans
        if (trimmed.toLowerCase() === 'true') return true;
        if (trimmed.toLowerCase() === 'false') return false;

        // Handle null
        if (trimmed.toLowerCase() === 'null') return null;

        // Handle numbers
        const numValue = Number(trimmed);
        if (!isNaN(numValue) && isFinite(numValue)) {
            return numValue;
        }

        // Default to string (unquoted)
        return trimmed;
    }

    /**
     * Parse multiple filters from an array that can contain both strings and objects
     * @param filters Array of string filters and/or MemoryFilter objects
     * @returns Array of parsed filter objects
     */
    static parseFilters(filters: MemoryFilter[]): Array<{ path: string; operator: FilterOperator; value: any }> {
        return filters.map(filter => {
            if (typeof filter === 'string') {
                return this.parseFilter(filter);
            }
            return filter as { path: string; operator: FilterOperator; value: any };
        });
    }
} 
import { MemoryFilter, FilterOperator } from '@a2arium/callagent-types';

/**
 * Information about an array path like "eventOccurences[].date"
 */
interface ArrayPathInfo {
    arrayField: string;     // "eventOccurences" 
    nestedPath: string;     // "date"
    hasNestedArrays: boolean; // For future "sessions[].speakers[].name" support
}

/**
 * Enhanced filter result interface with array path detection
 */
interface ParsedFilter {
    path: string;
    operator: FilterOperator;
    value: any;
    isArrayPath: boolean;
    arrayPathInfo?: ArrayPathInfo;
}

/**
 * Parser for string-based filter syntax
 * Converts strings like 'priority >= 8' to { path: 'priority', operator: '>=', value: 8 }
 * Now supports array paths like 'eventOccurences[].date = "2025-07-24"'
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
        { pattern: /\s+entity_is\s+/i, operator: 'ENTITY_EXACT' as FilterOperator },
        { pattern: /\s+entity_like\s+/i, operator: 'ENTITY_ALIAS' as FilterOperator },
        { pattern: /\s*(~)\s*/, operator: 'ENTITY_FUZZY' as FilterOperator },
    ];

    /**
     * Parse a string filter into a filter object with array path support
     * @param filterString String like 'priority >= 8' or 'eventOccurences[].date = "2025-07-24"'
     * @returns Parsed filter object with array path information
     */
    static parseFilter(filterString: string): ParsedFilter {
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

                // Check if this is an array path
                const isArrayPath = path.includes('[]');
                const arrayPathInfo = isArrayPath ? this.parseArrayPath(path) : undefined;

                return {
                    path,
                    operator,
                    value,
                    isArrayPath,
                    arrayPathInfo
                };
            }
        }

        throw new Error(`Invalid filter: no valid operator found in "${filterString}"`);
    }

    /**
     * Parse array path syntax like "eventOccurences[].date" or "events[].venue.name"
     * @param path The array path to parse
     * @returns Array path information
     */
    private static parseArrayPath(path: string): ArrayPathInfo {
        // Handle simple case: "eventOccurences[].date"
        const arrayMatch = path.match(/^(.+?)\[\]\.(.+)$/);
        if (arrayMatch) {
            const [, arrayField, nestedPath] = arrayMatch;
            return {
                arrayField: arrayField.trim(),
                nestedPath: nestedPath.trim(),
                hasNestedArrays: nestedPath.includes('[]') // For future nested array support
            };
        }

        // Handle edge case: "arrayField[]" (no nested path)
        const simpleArrayMatch = path.match(/^(.+?)\[\]$/);
        if (simpleArrayMatch) {
            throw new Error(`Array path "${path}" must specify a field within the array elements. Expected format: "arrayField[].nestedField"`);
        }

        throw new Error(`Invalid array path syntax: "${path}". Expected format: "arrayField[].nestedField"`);
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
     * @returns Array of parsed filter objects with array path information
     */
    static parseFilters(filters: MemoryFilter[]): ParsedFilter[] {
        return filters.map(filter => {
            if (typeof filter === 'string') {
                return this.parseFilter(filter);
            }

            // Convert object filter to ParsedFilter format
            const path = filter.path;
            const isArrayPath = path.includes('[]');
            return {
                path: filter.path,
                operator: filter.operator,
                value: filter.value,
                isArrayPath,
                arrayPathInfo: isArrayPath ? this.parseArrayPath(path) : undefined
            };
        });
    }

    /**
     * Legacy method for backward compatibility
     * @deprecated Use parseFilters instead which returns ParsedFilter[]
     */
    static parseFiltersLegacy(filters: MemoryFilter[]): Array<{ path: string; operator: FilterOperator; value: any }> {
        return this.parseFilters(filters).map(pf => ({
            path: pf.path,
            operator: pf.operator,
            value: pf.value
        }));
    }
}

// Export the interfaces for use in other files
export type { ParsedFilter, ArrayPathInfo }; 
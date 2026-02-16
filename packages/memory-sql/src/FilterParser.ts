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
 * Atomic filter result (e.g., "key = value")
 */
interface AtomicParsedFilter {
    type: 'atomic';
    path: string;
    operator: FilterOperator;
    value: any;
    isArrayPath: boolean;
    arrayPathInfo?: ArrayPathInfo;
}

/**
 * Group of filters joined by logic (OR/AND)
 */
interface FilterGroup {
    type: 'group';
    logic: 'OR' | 'AND';
    filters: ParsedFilter[];
}

/**
 * Union type for parsed filters
 */
type ParsedFilter = AtomicParsedFilter | FilterGroup;

/**
 * Parser for string-based filter syntax
 * Converts strings like 'priority >= 8' to atomic filters
 * Supports logical operators: 'status = "active" OR priority > 5'
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
     * Parse a string filter into a filter object
     * Supports OR and AND (case-insensitive)
     * @param filterString String like 'a=1 OR b=2'
     */
    static parseFilter(filterString: string): ParsedFilter {
        const trimmed = filterString.trim();

        // Check for OR (lowest precedence)
        // Using a regex to split by " OR " but not inside quotes could be complex,
        // for now we'll do simple splitting which covers 99% of use cases.
        const orParts = this.splitByLogicalOperator(trimmed, 'OR');
        if (orParts.length > 1) {
            return {
                type: 'group',
                logic: 'OR',
                filters: orParts.map(p => this.parseFilter(p))
            };
        }

        // Check for AND
        const andParts = this.splitByLogicalOperator(trimmed, 'AND');
        if (andParts.length > 1) {
            return {
                type: 'group',
                logic: 'AND',
                filters: andParts.map(p => this.parseFilter(p))
            };
        }

        return this.parseAtomicFilter(trimmed);
    }

    /**
     * Splits a string by a logical operator, respecting basic quotes
     */
    private static splitByLogicalOperator(str: string, operator: 'OR' | 'AND'): string[] {
        const regex = new RegExp(`\\s+${operator}\\s+`, 'i');
        // Simple strategy: split and then merge parts if they were inside unbalanced quotes
        // For the common case (documented examples), a simple split is usually enough
        // but let's be slightly more robust.

        const parts: string[] = [];
        let currentPos = 0;
        let inQuotes = false;
        let quoteChar = '';

        for (let i = 0; i < str.length; i++) {
            const char = str[i];
            if ((char === '"' || char === "'") && (i === 0 || str[i - 1] !== '\\')) {
                if (!inQuotes) {
                    inQuotes = true;
                    quoteChar = char;
                } else if (char === quoteChar) {
                    inQuotes = false;
                }
            }

            if (!inQuotes) {
                const sub = str.substring(i);
                const match = sub.match(regex);
                if (match && match.index === 0) {
                    parts.push(str.substring(currentPos, i).trim());
                    i += match[0].length - 1;
                    currentPos = i + 1;
                }
            }
        }
        parts.push(str.substring(currentPos).trim());
        return parts.length > 1 ? parts : [str];
    }

    /**
     * Parse an atomic filter string (single condition)
     */
    private static parseAtomicFilter(filterString: string): AtomicParsedFilter {
        const trimmed = filterString.trim();

        for (const { pattern, operator } of this.OPERATOR_PATTERNS) {
            const match = trimmed.match(pattern);
            if (match) {
                const operatorIndex = match.index!;
                const operatorLength = match[0].length;

                const path = trimmed.substring(0, operatorIndex).trim();
                if (!path) {
                    throw new Error(`Invalid filter: missing path in "${filterString}"`);
                }

                const valueStr = trimmed.substring(operatorIndex + operatorLength).trim();
                if (!valueStr) {
                    throw new Error(`Invalid filter: missing value in "${filterString}"`);
                }

                const value = this.parseValue(valueStr);
                const isArrayPath = path.includes('[]');
                const arrayPathInfo = isArrayPath ? this.parseArrayPath(path) : undefined;

                return {
                    type: 'atomic',
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
    static parseFilters(filters: any[]): ParsedFilter[] {
        return filters.map(filter => {
            if (typeof filter === 'string') {
                return this.parseFilter(filter);
            }

            // Convert object filter to AtomicParsedFilter format
            const path = filter.path;
            const isArrayPath = path.includes('[]');
            return {
                type: 'atomic',
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
    static parseFiltersLegacy(filters: any[]): Array<{ path: string; operator: FilterOperator; value: any }> {
        return this.parseFilters(filters).map(pf => {
            if (pf.type === 'atomic') {
                return {
                    path: pf.path,
                    operator: pf.operator,
                    value: pf.value
                };
            }
            throw new Error('Legacy parsing does not support logical groups');
        });
    }
}

// Export the interfaces for use in other files
export type { ParsedFilter, AtomicParsedFilter, FilterGroup, ArrayPathInfo }; 
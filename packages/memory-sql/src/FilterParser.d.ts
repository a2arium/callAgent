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
export declare class FilterParser {
    private static readonly OPERATOR_PATTERNS;
    /**
     * Parse a string filter into a filter object with array path support
     * @param filterString String like 'priority >= 8' or 'eventOccurences[].date = "2025-07-24"'
     * @returns Parsed filter object with array path information
     */
    static parseFilter(filterString: string): ParsedFilter;
    /**
     * Parse array path syntax like "eventOccurences[].date" or "events[].venue.name"
     * @param path The array path to parse
     * @returns Array path information
     */
    private static parseArrayPath;
    /**
     * Parse a value string into the appropriate type
     * @param valueStr String representation of the value
     * @returns Parsed value (string, number, boolean, or null)
     */
    private static parseValue;
    /**
     * Parse multiple filters from an array that can contain both strings and objects
     * @param filters Array of string filters and/or MemoryFilter objects
     * @returns Array of parsed filter objects with array path information
     */
    static parseFilters(filters: MemoryFilter[]): ParsedFilter[];
    /**
     * Legacy method for backward compatibility
     * @deprecated Use parseFilters instead which returns ParsedFilter[]
     */
    static parseFiltersLegacy(filters: MemoryFilter[]): Array<{
        path: string;
        operator: FilterOperator;
        value: any;
    }>;
}

// Export the interfaces for use in other files
export type { ParsedFilter, ArrayPathInfo };

import { MemoryFilter, FilterOperator } from '@a2arium/callagent-types';
/**
 * Parser for string-based filter syntax
 * Converts strings like 'priority >= 8' to { path: 'priority', operator: '>=', value: 8 }
 */
export declare class FilterParser {
    private static readonly OPERATOR_PATTERNS;
    /**
     * Parse a string filter into a filter object
     * @param filterString String like 'priority >= 8' or 'name contains "John"'
     * @returns Parsed filter object
     */
    static parseFilter(filterString: string): {
        path: string;
        operator: FilterOperator;
        value: any;
    };
    /**
     * Parse a value string into the appropriate type
     * @param valueStr String representation of the value
     * @returns Parsed value (string, number, boolean, or null)
     */
    private static parseValue;
    /**
     * Parse multiple filters from an array that can contain both strings and objects
     * @param filters Array of string filters and/or MemoryFilter objects
     * @returns Array of parsed filter objects
     */
    static parseFilters(filters: MemoryFilter[]): Array<{
        path: string;
        operator: FilterOperator;
        value: any;
    }>;
}

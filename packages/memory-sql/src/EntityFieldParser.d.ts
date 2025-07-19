import { EntityFieldSpec, ParsedEntityField } from './types.js';
export declare class EntityFieldParser {
    /**
     * Extract entity fields from value object using explicit entities configuration
     * Supports new syntax: 'type:threshold' (e.g., 'person:0.7', 'location:0.65')
     * NEW: Supports array expansion syntax: 'titleAndDescription[].title'
     */
    static parseEntityFields<T>(value: T, entitySpec?: EntityFieldSpec): ParsedEntityField[];
    /**
     * NEW: Expand array field path to multiple explicit paths
     * "titleAndDescription[].title" → ["titleAndDescription[0].title", "titleAndDescription[1].title", ...]
     * Supports nested arrays: "sessions[].speakers[].name"
     */
    private static expandArrayFieldPath;
    /**
     * NEW: Detect array shrinkage for cleanup
     */
    static detectArrayShrinkage<T>(currentValue: T, previousFieldPaths: string[], entitySpec: EntityFieldSpec): string[];
    /**
     * Parse entity type specification that may include threshold
     * Examples: 'person' -> { entityType: 'person', threshold: undefined }
     *          'person:0.7' -> { entityType: 'person', threshold: 0.7 }
     */
    private static parseEntityTypeSpec;
    /**
 * Simple nested value getter - supports basic object navigation and explicit array indexing
 * Examples: "venue.name" → obj.venue.name, "speakers[0].name" → obj.speakers[0].name
 */
    private static getSimpleNestedValue;
    /**
     * Set field value in object, supporting nested paths
     */
    static setFieldValue(obj: any, fieldPath: string, value: any): void;
}

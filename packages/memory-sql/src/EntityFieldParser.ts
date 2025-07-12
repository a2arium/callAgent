import { EntityFieldSpec, ParsedEntityField } from './types.js';

export class EntityFieldParser {
    /**
     * Extract entity fields from value object using explicit entities configuration
     * Supports new syntax: 'type:threshold' (e.g., 'person:0.7', 'location:0.65')
     */
    static parseEntityFields<T>(
        value: T,
        entitySpec?: EntityFieldSpec
    ): ParsedEntityField[] {
        const entityFields: ParsedEntityField[] = [];

        if (!entitySpec) {
            return entityFields;
        }

        // Process explicit entity specifications
        for (const [fieldName, entityTypeSpec] of Object.entries(entitySpec)) {
            const fieldValue = this.getFieldValue(value, fieldName);

            if (fieldValue && typeof fieldValue === 'string') {
                // Parse entity type and optional threshold from 'type:threshold' syntax
                const { entityType, threshold } = this.parseEntityTypeSpec(entityTypeSpec);

                entityFields.push({
                    fieldName,
                    entityType,
                    value: fieldValue,
                    threshold
                });
            }
        }

        return entityFields;
    }

    /**
     * Parse entity type specification that may include threshold
     * Examples: 'person' -> { entityType: 'person', threshold: undefined }
     *          'person:0.7' -> { entityType: 'person', threshold: 0.7 }
     */
    private static parseEntityTypeSpec(spec: string): { entityType: string; threshold?: number } {
        const parts = spec.split(':');

        if (parts.length === 1) {
            // Simple entity type without threshold
            return { entityType: parts[0] };
        } else if (parts.length === 2) {
            // Entity type with threshold
            const entityType = parts[0];
            const thresholdStr = parts[1];
            const threshold = parseFloat(thresholdStr);

            if (isNaN(threshold) || threshold < 0 || threshold > 1) {
                throw new Error(`Invalid threshold '${thresholdStr}' in entity spec '${spec}'. Threshold must be a number between 0 and 1.`);
            }

            return { entityType, threshold };
        } else {
            throw new Error(`Invalid entity type specification '${spec}'. Expected format: 'type' or 'type:threshold'`);
        }
    }

    /**
     * Get field value from object, supporting nested paths with automatic array traversal
     * Examples:
     * - "venue.name" → looks for obj.venue.name
     * - "titleAndDescription.title" → looks for obj.titleAndDescription[*].title (automatic array search)
     * - "sessions.speakers.name" → handles arrays at any level
     */
    private static getFieldValue(obj: any, fieldPath: string): any {
        return this.getFieldValueRecursive(obj, fieldPath.split('.'), 0);
    }

    /**
     * Recursive helper for getFieldValue that handles arrays naturally
     */
    private static getFieldValueRecursive(obj: any, pathParts: string[], partIndex: number): any {
        // Base case: we've processed all path parts
        if (partIndex >= pathParts.length) {
            return obj;
        }

        // Invalid current object
        if (!obj || typeof obj !== 'object') {
            return undefined;
        }

        const currentPart = pathParts[partIndex];
        const remainingParts = pathParts.slice(partIndex + 1);

        // Case 1: Direct property access (standard object navigation)
        if (currentPart in obj) {
            const value = obj[currentPart];

            // If there are more parts to traverse
            if (remainingParts.length > 0) {
                // If the value is an array, search within array elements
                if (Array.isArray(value)) {
                    return this.searchInArray(value, remainingParts);
                }
                // Otherwise continue normal traversal
                return this.getFieldValueRecursive(value, pathParts, partIndex + 1);
            }

            // No more parts, return the value
            return value;
        }

        // Case 2: Current object is an array - search within array elements
        if (Array.isArray(obj)) {
            return this.searchInArray(obj, pathParts.slice(partIndex));
        }

        // Case 3: Property doesn't exist
        return undefined;
    }

    /**
     * Search for a field path within an array of objects
     * Returns the first matching string value found
     */
    private static searchInArray(array: any[], remainingPath: string[]): any {
        for (const item of array) {
            const result = this.getFieldValueRecursive(item, remainingPath, 0);
            if (result !== undefined && typeof result === 'string') {
                return result; // Return first string match found
            }
        }
        return undefined;
    }

    /**
     * Set field value in object, supporting nested paths
     */
    static setFieldValue(obj: any, fieldPath: string, value: any): void {
        const parts = fieldPath.split('.');
        let current = obj;

        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (!(part in current) || typeof current[part] !== 'object') {
                current[part] = {};
            }
            current = current[part];
        }

        current[parts[parts.length - 1]] = value;
    }
} 
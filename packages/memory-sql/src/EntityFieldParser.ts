import { EntityFieldSpec, ParsedEntityField } from './types.js';

export class EntityFieldParser {
    /**
     * Extract entity fields from value object using explicit entities configuration
     * Supports new syntax: 'type:threshold' (e.g., 'person:0.7', 'location:0.65')
     * NEW: Supports array expansion syntax: 'titleAndDescription[].title' 
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
            // NEW: Check if field path contains [] syntax
            if (fieldName.includes('[]')) {
                const expandedFields = this.expandArrayFieldPath(value, fieldName, entityTypeSpec);
                entityFields.push(...expandedFields);
            } else {
                // Direct field access for non-array fields only (simple object navigation)
                const fieldValue = this.getSimpleNestedValue(value, fieldName);

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
        }

        return entityFields;
    }

    /**
     * NEW: Expand array field path to multiple explicit paths
     * "titleAndDescription[].title" → ["titleAndDescription[0].title", "titleAndDescription[1].title", ...]
     * Supports nested arrays: "sessions[].speakers[].name"
     */
    private static expandArrayFieldPath<T>(
        value: T,
        fieldPath: string,
        entityTypeSpec: string
    ): ParsedEntityField[] {
        const expandedFields: ParsedEntityField[] = [];
        const { entityType, threshold } = this.parseEntityTypeSpec(entityTypeSpec);

        // Handle simple case first
        if (!fieldPath.includes('[]')) {
            const fieldValue = this.getSimpleNestedValue(value, fieldPath);
            if (fieldValue && typeof fieldValue === 'string') {
                expandedFields.push({
                    fieldName: fieldPath,
                    entityType,
                    value: fieldValue,
                    threshold
                });
            }
            return expandedFields;
        }

        // Find the first array pattern
        const arrayMatch = fieldPath.match(/^(.+?)\[\](.*)$/);
        if (!arrayMatch) {
            return expandedFields;
        }

        const [, arrayPath, remainingPath] = arrayMatch;

        // Get the array from the object
        const arrayValue = this.getSimpleNestedValue(value, arrayPath);

        if (!Array.isArray(arrayValue)) {
            return expandedFields;
        }

        // Expand to explicit indices
        for (let i = 0; i < arrayValue.length; i++) {
            const expandedPath = `${arrayPath}[${i}]${remainingPath}`;

            // If there are more arrays in the remaining path, recurse
            if (remainingPath.includes('[]')) {
                const nestedFields = this.expandArrayFieldPath(value, expandedPath, entityTypeSpec);
                expandedFields.push(...nestedFields);
            } else {
                // This is the final expansion
                const fieldValue = this.getSimpleNestedValue(value, expandedPath);
                if (fieldValue && typeof fieldValue === 'string') {
                    expandedFields.push({
                        fieldName: expandedPath,
                        entityType,
                        value: fieldValue,
                        threshold
                    });
                }
            }
        }

        return expandedFields;
    }

    /**
     * NEW: Detect array shrinkage for cleanup
     */
    static detectArrayShrinkage<T>(
        currentValue: T,
        previousFieldPaths: string[],
        entitySpec: EntityFieldSpec
    ): string[] {
        const orphanedPaths: string[] = [];

        for (const [fieldPattern, entityTypeSpec] of Object.entries(entitySpec)) {
            if (fieldPattern.includes('[]')) {
                // Find current expanded paths
                const currentExpandedFields = this.expandArrayFieldPath(currentValue, fieldPattern, entityTypeSpec);
                const currentPaths = currentExpandedFields.map(f => f.fieldName);

                // Find orphaned paths from previous
                const arrayPathRegex = new RegExp(
                    '^' + fieldPattern.replace('[]', '\\[\\d+\\]').replace(/\./g, '\\.') + '$'
                );
                const previousArrayPaths = previousFieldPaths.filter(p =>
                    arrayPathRegex.test(p)
                );

                orphanedPaths.push(...previousArrayPaths.filter(p => !currentPaths.includes(p)));
            }
        }

        return orphanedPaths;
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
 * Simple nested value getter - supports basic object navigation and explicit array indexing
 * Examples: "venue.name" → obj.venue.name, "speakers[0].name" → obj.speakers[0].name
 */
    private static getSimpleNestedValue(obj: any, fieldPath: string): any {
        const pathParts = fieldPath.split('.');
        let current = obj;

        for (const part of pathParts) {
            if (!current || typeof current !== 'object') {
                return undefined;
            }

            // Handle explicit array indexing like "speakers[0]"
            const arrayMatch = part.match(/^(.+?)\[(\d+)\]$/);
            if (arrayMatch) {
                const [, arrayName, indexStr] = arrayMatch;
                const index = parseInt(indexStr, 10);

                if (!(arrayName in current) || !Array.isArray(current[arrayName])) {
                    return undefined;
                }

                current = current[arrayName][index];
            } else {
                // Regular object property access
                if (!(part in current)) {
                    return undefined;
                }
                current = current[part];
            }
        }

        return current;
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
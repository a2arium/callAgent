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
     * Get field value from object, supporting nested paths
     */
    private static getFieldValue(obj: any, fieldPath: string): any {
        const parts = fieldPath.split('.');
        let current = obj;

        for (const part of parts) {
            if (current && typeof current === 'object' && part in current) {
                current = current[part];
            } else {
                return undefined;
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
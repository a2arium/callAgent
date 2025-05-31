import { AlignedValue, EntityAlignment } from './types.js';
import { EntityFieldParser } from './EntityFieldParser.js';

export function createAlignedValue(
    originalValue: string,
    alignment: EntityAlignment | null
): AlignedValue | string {
    // If no alignment, return plain string
    if (!alignment) {
        return originalValue;
    }

    const canonicalName = alignment.canonicalName;

    // Create proxy object that behaves like a string but has rich metadata
    return new Proxy({} as AlignedValue, {
        get(target, prop, receiver) {
            switch (prop) {
                case 'toString':
                case 'valueOf':
                    return () => canonicalName;

                case '_entity':
                    return alignment;

                case '_wasAligned':
                    return true;

                case '_original':
                    return alignment.originalValue;

                case '_canonical':
                    return canonicalName;

                case Symbol.toPrimitive:
                    return () => canonicalName;

                case 'length':
                    return canonicalName.length;

                // String methods
                case 'toUpperCase':
                    return () => canonicalName.toUpperCase();
                case 'toLowerCase':
                    return () => canonicalName.toLowerCase();
                case 'trim':
                    return () => canonicalName.trim();
                case 'includes':
                    return (searchString: string) => canonicalName.includes(searchString);
                case 'startsWith':
                    return (searchString: string) => canonicalName.startsWith(searchString);
                case 'endsWith':
                    return (searchString: string) => canonicalName.endsWith(searchString);
                case 'substring':
                    return (start: number, end?: number) => canonicalName.substring(start, end);
                case 'slice':
                    return (start: number, end?: number) => canonicalName.slice(start, end);
                case 'replace':
                    return (searchValue: string | RegExp, replaceValue: string) =>
                        canonicalName.replace(searchValue, replaceValue);
                case 'split':
                    return (separator?: string | RegExp, limit?: number) => {
                        if (separator === undefined) {
                            return [canonicalName];
                        }
                        return canonicalName.split(separator, limit);
                    };
                case 'indexOf':
                    return (searchString: string, position?: number) =>
                        canonicalName.indexOf(searchString, position);
                case 'lastIndexOf':
                    return (searchString: string, position?: number) =>
                        canonicalName.lastIndexOf(searchString, position);
                case 'charAt':
                    return (index: number) => canonicalName.charAt(index);
                case 'charCodeAt':
                    return (index: number) => canonicalName.charCodeAt(index);
                case 'concat':
                    return (...strings: string[]) => canonicalName.concat(...strings);
                case 'match':
                    return (regexp: string | RegExp) => canonicalName.match(regexp);
                case 'search':
                    return (regexp: string | RegExp) => canonicalName.search(regexp);
                case 'toJSON':
                    return () => canonicalName; // For JSON.stringify support

                default:
                    // For any other property, try the canonical name
                    const canonicalProperty = (canonicalName as any)[prop];
                    if (typeof canonicalProperty === 'function') {
                        return canonicalProperty.bind(canonicalName);
                    }
                    return canonicalProperty;
            }
        }
    }) as AlignedValue;
}

/**
 * Get field value from object, supporting nested paths
 */
function getFieldValue(obj: any, fieldPath: string): any {
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
 * Process a retrieved value object and add proxy objects for aligned fields
 */
export function addAlignedProxies<T>(
    value: T,
    alignments: Record<string, EntityAlignment | null>
): T {
    if (!value || typeof value !== 'object') {
        return value;
    }

    const result = { ...value } as any;

    for (const [fieldPath, alignment] of Object.entries(alignments)) {
        if (alignment) {
            const currentValue = getFieldValue(result, fieldPath);
            if (typeof currentValue === 'string') {
                const alignedValue = createAlignedValue(currentValue, alignment);
                EntityFieldParser.setFieldValue(result, fieldPath, alignedValue);
            }
        }
    }

    return result;
} 
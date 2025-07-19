import { AlignedValue, EntityAlignment } from './types.js';
export declare function createAlignedValue(originalValue: string, alignment: EntityAlignment | null): AlignedValue | string;
/**
 * Process a retrieved value object and add proxy objects for aligned fields
 */
export declare function addAlignedProxies<T>(value: T, alignments: Record<string, EntityAlignment | null>): T;

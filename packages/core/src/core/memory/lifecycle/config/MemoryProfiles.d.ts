import { MemoryLifecycleConfig } from './types.js';
/**
 * Memory Profiles provide concrete implementations for different use cases
 */
export declare const MemoryProfiles: Record<string, MemoryLifecycleConfig>;
/**
 * Get a memory profile by name with deep copy to prevent mutation
 */
export declare function getMemoryProfile(profileName: string): MemoryLifecycleConfig | undefined;
/**
 * List all available memory profile names
 */
export declare function getAvailableProfiles(): string[];
/**
 * Check if a profile name is valid
 */
export declare function isValidProfile(profileName: string): boolean;
/**
 * Get profile recommendations based on use case
 */
export declare function getProfileRecommendations(useCase: string): string[];

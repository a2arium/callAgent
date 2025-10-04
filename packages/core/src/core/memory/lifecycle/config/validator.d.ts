import { MemoryLifecycleConfig, ConfigValidationResult } from './types.js';
/**
 * Validate complete MLO configuration
 */
export declare function validateConfig(config: MemoryLifecycleConfig): ConfigValidationResult;
/**
 * Validate configuration and throw if invalid
 */
export declare function validateConfigOrThrow(config: MemoryLifecycleConfig): void;
/**
 * Check if a configuration is compatible with a specific profile
 */
export declare function isCompatibleWithProfile(config: MemoryLifecycleConfig, targetProfile: string): {
    compatible: boolean;
    issues: string[];
};

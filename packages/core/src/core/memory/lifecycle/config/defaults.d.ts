import { MemoryLifecycleConfig, ConcurrencyConfig, ConfigProfile, ProviderConfig } from './types.js';
/**
 * Default configurations for each profile
 */
export declare const DEFAULT_CONFIGS: Record<ConfigProfile, MemoryLifecycleConfig>;
/**
 * Get default configuration for a specific profile
 */
export declare function getDefaultConfig(profile: ConfigProfile): MemoryLifecycleConfig;
/**
 * Get default concurrency configuration for a profile
 */
export declare function getDefaultConcurrency(profile: ConfigProfile): ConcurrencyConfig;
/**
 * Get default provider configuration
 */
export declare function getDefaultProvider(providerName: string): ProviderConfig | undefined;

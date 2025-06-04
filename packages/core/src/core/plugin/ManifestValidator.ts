import { AgentManifest, isAgentManifest } from '@callagent/types';
import { logger } from '@callagent/utils';

const validatorLogger = logger.createLogger({ prefix: 'ManifestValidator' });

/**
 * Result of manifest validation
 */
export interface ValidationResult {
    /** Whether the manifest is valid */
    isValid: boolean;
    /** Array of error messages (validation failures) */
    errors: string[];
    /** Array of warning messages (potential issues) */
    warnings: string[];
}

/**
 * Comprehensive validator for agent manifests
 * Validates both basic structure and enhanced features like dependencies
 */
export class ManifestValidator {
    /**
     * Validate a complete agent manifest
     * @param manifest - The manifest to validate
     * @returns Validation result with errors and warnings
     */
    static validate(manifest: unknown): ValidationResult {
        const result: ValidationResult = {
            isValid: true,
            errors: [],
            warnings: []
        };

        // Check if it's a valid manifest structure
        if (!isAgentManifest(manifest)) {
            result.isValid = false;
            result.errors.push('Invalid manifest structure: must be an object with name and version fields');
            return result; // Early return if basic structure is invalid
        }

        // Validate basic fields
        const basicValidation = this.validateBasicFields(manifest);
        this.mergeResults(result, basicValidation);

        // Validate memory profile if specified
        if (manifest.memory?.profile) {
            const memoryValidation = this.validateMemoryProfile(manifest.memory.profile);
            this.mergeResults(result, memoryValidation);
        }

        // Validate A2A configuration if specified
        if (manifest.a2a) {
            const a2aValidation = this.validateA2AConfig(manifest.a2a);
            this.mergeResults(result, a2aValidation);
        }

        // Validate dependencies if specified
        if (manifest.dependencies?.agents) {
            const depsValidation = this.validateDependencies(manifest.dependencies.agents);
            this.mergeResults(result, depsValidation);
        }

        // Log validation results (manifest is guaranteed to be AgentManifest here)
        const typedManifest = manifest as AgentManifest;
        if (!result.isValid) {
            validatorLogger.warn('Manifest validation failed', {
                manifestName: typedManifest.name,
                errors: result.errors,
                warnings: result.warnings
            });
        } else if (result.warnings.length > 0) {
            validatorLogger.info('Manifest validation passed with warnings', {
                manifestName: typedManifest.name,
                warnings: result.warnings
            });
        } else {
            validatorLogger.debug('Manifest validation passed', {
                manifestName: typedManifest.name
            });
        }

        return result;
    }

    /**
     * Validate basic required and optional fields
     */
    static validateBasicFields(manifest: AgentManifest): ValidationResult {
        const result: ValidationResult = {
            isValid: true,
            errors: [],
            warnings: []
        };

        // Name validation
        if (!manifest.name || manifest.name.trim().length === 0) {
            result.isValid = false;
            result.errors.push('Agent name is required and cannot be empty');
        } else if (manifest.name !== manifest.name.toLowerCase()) {
            result.warnings.push('Agent name should be lowercase for consistency');
        } else if (!/^[a-z0-9-_]+$/.test(manifest.name)) {
            result.warnings.push('Agent name should only contain lowercase letters, numbers, hyphens, and underscores');
        }

        // Version validation
        if (!manifest.version || manifest.version.trim().length === 0) {
            result.isValid = false;
            result.errors.push('Agent version is required and cannot be empty');
        } else if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9-]+)?$/.test(manifest.version)) {
            result.warnings.push('Agent version should follow semver format (e.g., "1.0.0")');
        }

        // Description validation (optional but recommended)
        if (!manifest.description || manifest.description.trim().length === 0) {
            result.warnings.push('Agent description is recommended for better discoverability');
        } else if (manifest.description.length > 500) {
            result.warnings.push('Agent description is quite long, consider keeping it under 500 characters');
        }

        return result;
    }

    /**
     * Validate memory profile configuration
     */
    static validateMemoryProfile(profile: unknown): ValidationResult {
        const result: ValidationResult = {
            isValid: true,
            errors: [],
            warnings: []
        };

        if (typeof profile !== 'string') {
            result.isValid = false;
            result.errors.push('Memory profile must be a string');
            return result;
        }

        const validProfiles = ['basic', 'conversational', 'analytical', 'advanced', 'custom'];
        if (!validProfiles.includes(profile)) {
            result.warnings.push(`Unknown memory profile '${profile}'. Known profiles: ${validProfiles.join(', ')}`);
        }

        return result;
    }

    /**
     * Validate A2A configuration
     */
    static validateA2AConfig(a2aConfig: unknown): ValidationResult {
        const result: ValidationResult = {
            isValid: true,
            errors: [],
            warnings: []
        };

        if (!a2aConfig || typeof a2aConfig !== 'object') {
            result.isValid = false;
            result.errors.push('A2A configuration must be an object');
            return result;
        }

        const config = a2aConfig as Record<string, unknown>;

        // Validate maxConcurrentCalls
        if (config.maxConcurrentCalls !== undefined) {
            if (typeof config.maxConcurrentCalls !== 'number' || config.maxConcurrentCalls < 1) {
                result.errors.push('maxConcurrentCalls must be a positive number');
                result.isValid = false;
            } else if (config.maxConcurrentCalls > 100) {
                result.warnings.push('maxConcurrentCalls is very high, consider if this is intentional');
            }
        }

        // Validate defaultTimeout
        if (config.defaultTimeout !== undefined) {
            if (typeof config.defaultTimeout !== 'number' || config.defaultTimeout < 1000) {
                result.errors.push('defaultTimeout must be a number >= 1000 (milliseconds)');
                result.isValid = false;
            } else if (config.defaultTimeout > 300000) { // 5 minutes
                result.warnings.push('defaultTimeout is very long, consider if this is intentional');
            }
        }

        // Validate allowedTargets
        if (config.allowedTargets !== undefined) {
            if (!Array.isArray(config.allowedTargets)) {
                result.errors.push('allowedTargets must be an array of strings');
                result.isValid = false;
            } else if (!config.allowedTargets.every(target => typeof target === 'string')) {
                result.errors.push('All allowedTargets must be strings');
                result.isValid = false;
            }
        }

        // Validate memoryInheritance
        if (config.memoryInheritance !== undefined) {
            if (!config.memoryInheritance || typeof config.memoryInheritance !== 'object') {
                result.errors.push('memoryInheritance must be an object');
                result.isValid = false;
            } else {
                const inheritance = config.memoryInheritance as Record<string, unknown>;
                const validKeys = ['working', 'semantic', 'episodic'];

                for (const [key, value] of Object.entries(inheritance)) {
                    if (!validKeys.includes(key)) {
                        result.warnings.push(`Unknown memory inheritance key '${key}'. Known keys: ${validKeys.join(', ')}`);
                    }
                    if (typeof value !== 'boolean') {
                        result.errors.push(`Memory inheritance '${key}' must be a boolean`);
                        result.isValid = false;
                    }
                }
            }
        }

        return result;
    }

    /**
     * Validate agent dependencies
     */
    static validateDependencies(dependencies: unknown): ValidationResult {
        const result: ValidationResult = {
            isValid: true,
            errors: [],
            warnings: []
        };

        if (!Array.isArray(dependencies)) {
            result.isValid = false;
            result.errors.push('Dependencies must be an array of agent names');
            return result;
        }

        if (dependencies.length === 0) {
            result.warnings.push('Dependencies array is empty, consider removing the dependencies field');
            return result;
        }

        // Validate each dependency
        for (let i = 0; i < dependencies.length; i++) {
            const dep = dependencies[i];

            if (typeof dep !== 'string') {
                result.isValid = false;
                result.errors.push(`Dependency at index ${i} must be a string (agent name)`);
                continue;
            }

            if (dep.trim().length === 0) {
                result.isValid = false;
                result.errors.push(`Dependency at index ${i} cannot be empty`);
                continue;
            }

            // Check for naming conventions
            if (dep !== dep.toLowerCase()) {
                result.warnings.push(`Dependency '${dep}' should be lowercase for consistency`);
            }

            if (!/^[a-z0-9-_]+$/.test(dep)) {
                result.warnings.push(`Dependency '${dep}' should only contain lowercase letters, numbers, hyphens, and underscores`);
            }
        }

        // Check for duplicates
        const uniqueDeps = new Set(dependencies);
        if (uniqueDeps.size !== dependencies.length) {
            result.warnings.push('Duplicate dependencies found, consider removing duplicates');
        }

        // Check for circular dependencies (basic check - same name)
        // More sophisticated circular dependency detection will be in the resolver
        const hasSelfReference = dependencies.some(dep => typeof dep === 'string' && dep === 'self');
        if (hasSelfReference) {
            result.isValid = false;
            result.errors.push('Agent cannot depend on itself');
        }

        return result;
    }

    /**
     * Helper to merge validation results
     */
    private static mergeResults(target: ValidationResult, source: ValidationResult): void {
        if (!source.isValid) {
            target.isValid = false;
        }
        target.errors.push(...source.errors);
        target.warnings.push(...source.warnings);
    }
} 
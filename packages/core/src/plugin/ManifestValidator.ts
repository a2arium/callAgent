import { AgentManifest, isAgentManifest } from '@a2arium/callagent-types';
import { logger } from '@a2arium/callagent-utils';

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

        // Name validation - supports both traditional and category-based names
        if (!manifest.name || manifest.name.trim().length === 0) {
            result.isValid = false;
            result.errors.push('Agent name is required and cannot be empty');
        } else if (manifest.name !== manifest.name.toLowerCase()) {
            result.warnings.push('Agent name should be lowercase for consistency');
        } else {
            // Validate category-based or traditional naming
            const nameValidation = this.validateAgentName(manifest.name);
            this.mergeResults(result, nameValidation);
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
     * Validate agent name format
     * Supports both traditional names (e.g., 'hello-agent') and category-based names (e.g., 'data-processing/csv-parser')
     * @param name - Agent name to validate
     * @returns Validation result
     */
    private static validateAgentName(name: string): ValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Check if this is a category-based name (contains forward slash)
        if (name.includes('/')) {
            const parts = name.split('/');

            // Must have exactly 2 parts: category/agent-name
            if (parts.length !== 2) {
                errors.push('Category-based agent name must have format "category/agent-name"');
                return { isValid: false, errors, warnings };
            }

            const [category, agentName] = parts;

            // Validate category part
            if (!category || category.trim() === '') {
                errors.push('Category name cannot be empty');
            } else if (!/^[a-z0-9_-]+$/.test(category)) {
                errors.push('Category name should only contain lowercase letters, numbers, hyphens, and underscores');
            }

            // Validate agent name part
            if (!agentName || agentName.trim() === '') {
                errors.push('Agent name cannot be empty');
            } else if (!/^[a-z0-9_-]+$/.test(agentName)) {
                errors.push('Agent name should only contain lowercase letters, numbers, hyphens, and underscores');
            }

            // Check for valid format in both parts (no leading/trailing hyphens or underscores)
            if (category && (/^[-_]|[-_]$/.test(category))) {
                warnings.push('Category name should not start or end with hyphens or underscores');
            }
            if (agentName && (/^[-_]|[-_]$/.test(agentName))) {
                warnings.push('Agent name should not start or end with hyphens or underscores');
            }

            // Check for consecutive special characters in both parts
            if (category && /[-_]{2,}/.test(category)) {
                warnings.push('Category name should not contain consecutive hyphens or underscores');
            }
            if (agentName && /[-_]{2,}/.test(agentName)) {
                warnings.push('Agent name should not contain consecutive hyphens or underscores');
            }
        } else {
            // Traditional single-name validation
            // Check for valid characters (lowercase letters, numbers, hyphens, underscores)
            if (!/^[a-z0-9_-]+$/.test(name)) {
                warnings.push('Agent name should only contain lowercase letters, numbers, hyphens, and underscores');
            }

            // Check for valid format (no leading/trailing hyphens or underscores)
            if (/^[-_]|[-_]$/.test(name)) {
                warnings.push('Agent name should not start or end with hyphens or underscores');
            }

            // Check for consecutive special characters
            if (/[-_]{2,}/.test(name)) {
                warnings.push('Agent name should not contain consecutive hyphens or underscores');
            }
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings
        };
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

            // Check for naming conventions - supports category-based names
            if (dep !== dep.toLowerCase()) {
                result.isValid = false;
                result.errors.push(`Dependency '${dep}' must be lowercase for consistency. Use '${dep.toLowerCase()}' instead.`);
            }

            // Validate dependency name format (supports category-based names)
            const depValidation = this.validateAgentName(dep);
            if (!depValidation.isValid) {
                result.isValid = false;
                result.errors.push(...depValidation.errors.map(err => `Dependency '${dep}': ${err}`));
            } else {
                // Additional check for invalid characters that might not be caught by category validation
                // This handles cases like 'image@summary' which contains invalid characters
                // For backward compatibility, use the original error message format
                if (!/^[a-z0-9_/-]+$/.test(dep)) {
                    result.isValid = false;
                    result.errors.push(`Dependency '${dep}' must only contain lowercase letters, numbers, hyphens, and underscores`);
                }
            }
            result.warnings.push(...depValidation.warnings.map(warn => `Dependency '${dep}': ${warn}`));
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
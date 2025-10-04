import { AgentManifest } from '@a2arium/callagent-types';
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
export declare class ManifestValidator {
    /**
     * Validate a complete agent manifest
     * @param manifest - The manifest to validate
     * @returns Validation result with errors and warnings
     */
    static validate(manifest: unknown): ValidationResult;
    /**
     * Validate basic required and optional fields
     */
    static validateBasicFields(manifest: AgentManifest): ValidationResult;
    /**
     * Validate agent name format
     * Supports both traditional names (e.g., 'hello-agent') and category-based names (e.g., 'data-processing/csv-parser')
     * @param name - Agent name to validate
     * @returns Validation result
     */
    private static validateAgentName;
    /**
     * Validate memory profile configuration
     */
    static validateMemoryProfile(profile: unknown): ValidationResult;
    /**
     * Validate A2A configuration
     */
    static validateA2AConfig(a2aConfig: unknown): ValidationResult;
    /**
     * Validate agent dependencies
     */
    static validateDependencies(dependencies: unknown): ValidationResult;
    /**
     * Helper to merge validation results
     */
    private static mergeResults;
}

/**
 * Custom error types for the AI Agents Framework
 * Provides specific error classes for different error scenarios
 */
/**
 * Base error class for all framework errors
 */
export declare class FrameworkError extends Error {
    details?: Record<string, unknown> | undefined;
    /**
     * Create a new FrameworkError
     * @param message - Error message
     * @param details - Additional error details
     */
    constructor(message: string, details?: Record<string, unknown> | undefined);
}
/**
 * Error thrown when there are issues with plugin loading or manifest parsing
 */
export declare class PluginError extends FrameworkError {
    /**
     * Create a new PluginError
     * @param message - Error message
     * @param details - Additional error details
     */
    constructor(message: string, details?: Record<string, unknown>);
}
/**
 * Error thrown when a manifest is invalid or missing required fields
 */
export declare class ManifestError extends PluginError {
    /**
     * Create a new ManifestError
     * @param message - Error message
     * @param details - Additional error details
     */
    constructor(message: string, details?: Record<string, unknown>);
}
/**
 * Error thrown during task execution
 */
export declare class TaskExecutionError extends FrameworkError {
    /**
     * Create a new TaskExecutionError
     * @param message - Error message
     * @param details - Additional error details
     */
    constructor(message: string, details?: Record<string, unknown>);
}
/**
 * Error thrown when an agent implementation throws an error
 */
export declare class AgentError extends FrameworkError {
    agentName: string;
    /**
     * Create a new AgentError
     * @param message - Error message
     * @param agentName - Name of the agent that caused the error
     * @param details - Additional error details
     */
    constructor(message: string, agentName: string, details?: Record<string, unknown>);
}
/**
 * Error thrown when a configuration is invalid
 */
export declare class ConfigurationError extends FrameworkError {
    /**
     * Create a new ConfigurationError
     * @param message - Error message
     * @param details - Additional error details
     */
    constructor(message: string, details?: Record<string, unknown>);
}
/**
 * Helper to determine if an unknown object is a specific error type
 * @param error - Error to check
 * @param errorType - Error constructor to check against
 * @returns True if error is an instance of errorType
 */
export declare function isErrorType<T extends Error>(error: unknown, errorType: new (...args: unknown[]) => T): error is T;

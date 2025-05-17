/**
 * Custom error types for the AI Agents Framework
 * Provides specific error classes for different error scenarios
 */

/**
 * Base error class for all framework errors
 */
export class FrameworkError extends Error {
    /**
     * Create a new FrameworkError
     * @param message - Error message
     * @param details - Additional error details
     */
    constructor(message: string, public details?: Record<string, unknown>) {
        super(message);
        this.name = this.constructor.name;
        // Ensure prototype chain works correctly in ES5
        Object.setPrototypeOf(this, FrameworkError.prototype);
    }
}

/**
 * Error thrown when there are issues with plugin loading or manifest parsing
 */
export class PluginError extends FrameworkError {
    /**
     * Create a new PluginError
     * @param message - Error message
     * @param details - Additional error details
     */
    constructor(message: string, details?: Record<string, unknown>) {
        super(message, details);
        Object.setPrototypeOf(this, PluginError.prototype);
    }
}

/**
 * Error thrown when a manifest is invalid or missing required fields
 */
export class ManifestError extends PluginError {
    /**
     * Create a new ManifestError
     * @param message - Error message
     * @param details - Additional error details
     */
    constructor(message: string, details?: Record<string, unknown>) {
        super(message, details);
        Object.setPrototypeOf(this, ManifestError.prototype);
    }
}

/**
 * Error thrown during task execution
 */
export class TaskExecutionError extends FrameworkError {
    /**
     * Create a new TaskExecutionError
     * @param message - Error message
     * @param details - Additional error details
     */
    constructor(message: string, details?: Record<string, unknown>) {
        super(message, details);
        Object.setPrototypeOf(this, TaskExecutionError.prototype);
    }
}

/**
 * Error thrown when an agent implementation throws an error
 */
export class AgentError extends FrameworkError {
    /**
     * Create a new AgentError
     * @param message - Error message
     * @param agentName - Name of the agent that caused the error
     * @param details - Additional error details
     */
    constructor(message: string, public agentName: string, details?: Record<string, unknown>) {
        super(message, { agentName, ...details });
        Object.setPrototypeOf(this, AgentError.prototype);
    }
}

/**
 * Error thrown when a configuration is invalid
 */
export class ConfigurationError extends FrameworkError {
    /**
     * Create a new ConfigurationError
     * @param message - Error message
     * @param details - Additional error details
     */
    constructor(message: string, details?: Record<string, unknown>) {
        super(message, details);
        Object.setPrototypeOf(this, ConfigurationError.prototype);
    }
}

/**
 * Helper to determine if an unknown object is a specific error type
 * @param error - Error to check
 * @param errorType - Error constructor to check against
 * @returns True if error is an instance of errorType
 */
export function isErrorType<T extends Error>(
    error: unknown,
    errorType: new (...args: unknown[]) => T
): error is T {
    return error instanceof errorType;
} 
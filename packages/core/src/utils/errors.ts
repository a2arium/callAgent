import { BaseError } from '../shared/errors/BaseError.js';

/**
 * Base error class for all framework errors
 */
export class FrameworkError extends BaseError {

    /**
     * Create a new FrameworkError
     * @param message - Error message
     * @param details - Additional error details
     */
    constructor(message: string, public details?: Record<string, unknown>) {
        super('FRAMEWORK_ERROR', message, details);
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

import { ManifestErrorDetail } from '@a2arium/callagent-types';

/**
 * Error thrown when a manifest is invalid or missing required fields
 */
export class ManifestError extends PluginError {
    /**
     * Create a new ManifestError
     * @param message - Error message
     * @param detail - Typed manifest error detail
     */
    constructor(message: string, public detail?: ManifestErrorDetail) {
        super(message, detail ? { ...detail } : undefined);
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

import { InvariantErrorPayload } from '../types/invariantError.js';

/**
 * Error thrown when a framework invariant is violated
 */
export class InvariantError extends FrameworkError {
    public readonly invariant: InvariantErrorPayload;
    public readonly code: string;
    public readonly detail: Record<string, unknown>;

    /**
     * Create a new InvariantError
     * @param invariant - Structured invariant error payload
     */
    constructor(invariant: InvariantErrorPayload) {
        super(invariant.message, { code: invariant.code, ...invariant.detail });
        this.invariant = invariant;
        this.code = invariant.code;
        this.detail = invariant.detail as unknown as Record<string, unknown>;
        Object.setPrototypeOf(this, InvariantError.prototype);
    }

}


/**
 * Valid module identifiers for ModuleExecutionError (closed enum)
 */
export const FrameworkModule = {
    Attention: 'attention',
    Perception: 'perception',
    Learning: 'learning',
    Policy: 'policy',
    Shield: 'shield',
    Execution: 'execution',
    Transition: 'transition'
} as const;

export type FrameworkModule = typeof FrameworkModule[keyof typeof FrameworkModule];


/**
 * Error thrown when a core module fails during execution
 */
export class ModuleExecutionError extends FrameworkError {
    public readonly code = 'MODULE_EXECUTION_ERROR';

    /**
     * Create a new ModuleExecutionError
     * @param module - The module that failed
     * @param originalMessage - The original error message
     * @param cause - The original error object
     */
    constructor(
        public module: FrameworkModule,
        public originalMessage: string,
        public cause?: Error
    ) {
        super(`${module} module failed: ${originalMessage}`, { module, originalMessage, cause: cause instanceof Error ? cause.message : String(cause) });
        Object.setPrototypeOf(this, ModuleExecutionError.prototype);
    }


    public toString(): string {
        return `${this.module} module failed: ${this.originalMessage}`;
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
 
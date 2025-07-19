/**
 * Base error class for the framework
 * All framework-specific errors should extend this class
 */
export declare class BaseError extends Error {
    /**
     * Error code used for programmatic identification
     */
    readonly code: string;
    /**
     * Optional additional information about the error
     */
    readonly details?: any;
    /**
     * @param code Error code identifier
     * @param message Human-readable error message
     * @param details Additional contextual information (optional)
     */
    constructor(code: string, message: string, details?: any);
}

/**
 * Base error class for the framework
 * All framework-specific errors should extend this class
 */
export class BaseError extends Error {
    /**
     * Error code used for programmatic identification
     */
    public readonly code: string;

    /**
     * Optional additional information about the error
     */
    public readonly details?: any;

    /**
     * @param code Error code identifier
     * @param message Human-readable error message
     * @param details Additional contextual information (optional)
     */
    constructor(code: string, message: string, details?: any) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.details = details;

        // Capture stack trace in V8 environments
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
} 
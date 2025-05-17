import { BaseError } from './BaseError.js';

/**
 * Error class for memory-related operations
 * Used by MemorySQLAdapter and potentially other memory adapters
 */
export class MemoryError extends BaseError {
    /**
     * Creates a new MemoryError
     * @param message Human-readable error message
     * @param details Additional context about the error (optional)
     */
    constructor(message: string, details?: any) {
        super('MEMORY_ERROR', message, details);
    }
} 
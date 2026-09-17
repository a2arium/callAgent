import { BaseError } from './BaseError.js';

export type SemanticAtomicErrorCode =
    | 'SEMANTIC_ATOMIC_INVALID_VERSION'
    | 'SEMANTIC_ATOMIC_VALUE_UNSUPPORTED'
    | 'SEMANTIC_ATOMIC_OPTION_UNSUPPORTED';

/**
 * Programmatically identifiable failures for optional semantic atomic operations.
 */
export class SemanticAtomicError extends BaseError {
    constructor(code: SemanticAtomicErrorCode, message: string, details?: unknown) {
        super(code, message, details);
    }
}

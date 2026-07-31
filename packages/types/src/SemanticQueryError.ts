import { BaseError } from './BaseError.js';

export type SemanticQueryErrorCode =
    | 'SEMANTIC_BACKEND_NOT_FOUND'
    | 'SEMANTIC_BACKEND_METHOD_UNAVAILABLE'
    | 'SEMANTIC_TAG_QUERY_UNSUPPORTED'
    | 'SEMANTIC_PREDICATE_REMOVE_UNSUPPORTED'
    | 'SEMANTIC_TAG_INVALID_TYPE'
    | 'SEMANTIC_TAG_EMPTY'
    | 'SEMANTIC_TAG_TOO_LONG'
    | 'SEMANTIC_TAG_COUNT_EXCEEDED'
    | 'SEMANTIC_QUERY_LIMIT_INVALID'
    | 'SEMANTIC_QUERY_INVALID_COMBINATION'
    | 'SEMANTIC_QUERY_SCAN_BUDGET_EXCEEDED'
    | 'SEMANTIC_QUERY_ENVELOPE_MUTATED'
    | 'SEMANTIC_QUERY_COMBINATION_UNSUPPORTED'
    | 'SEMANTIC_CURSOR_INVALID'
    | 'SEMANTIC_CURSOR_QUERY_MISMATCH'
    | 'SEMANTIC_REMOVE_CONTENTION';

export type SemanticQueryErrorDetails = Readonly<Record<string, string | number | boolean | null | undefined>>;

export class SemanticQueryError extends BaseError {
    public readonly retryable: boolean;
    public readonly cause?: unknown;

    constructor(
        code: SemanticQueryErrorCode,
        message: string,
        options: {
            retryable?: boolean;
            details?: SemanticQueryErrorDetails;
            cause?: unknown;
        } = {}
    ) {
        super(code, message, options.details);
        this.retryable = options.retryable ?? false;
        this.cause = options.cause;
    }
}

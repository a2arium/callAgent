import { SemanticQueryError } from '@a2arium/callagent-types';

function hasOwn(input: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(input, key);
}

/**
 * Fail-closed runtime validation for the stable semantic page traversal shape.
 * TypeScript excludes exact-id and random selectors, but JavaScript callers and
 * persisted JSON can still supply them at runtime.
 */
export function validateSemanticReadPageInput(input: unknown): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new SemanticQueryError(
            'SEMANTIC_QUERY_INVALID_COMBINATION',
            'Semantic-memory page input must be an object',
        );
    }

    const record = input as Record<string, unknown>;
    if (hasOwn(record, 'id') || hasOwn(record, 'random')) {
        throw new SemanticQueryError(
            'SEMANTIC_QUERY_INVALID_COMBINATION',
            'Semantic-memory pagination does not support exact-id or random selectors',
        );
    }

    if (hasOwn(record, 'cursor') && record.cursor !== undefined) {
        if (typeof record.cursor !== 'string' || record.cursor.trim().length === 0) {
            throw new SemanticQueryError(
                'SEMANTIC_CURSOR_INVALID',
                'Semantic-memory pagination cursor is invalid',
            );
        }
    }
}

import { InvariantError } from './errors.js';
import {
    InvariantErrorCode,
    InvariantErrorContext,
    InvariantErrorDetail,
    InvariantErrorPayload
} from '../types/invariantError.js';

export type { InvariantErrorContext } from '../types/invariantError.js';

/**
 * Centrally throws a structured InvariantError.
 *
 * This factory ensures that every invariant violation in the framework
 * follows the APLRET contract and provides programmatically inspectable details.
 *
 * @param code - Machine-readable error code (Rule 4: closed enum)
 * @param message - Human-readable description
 * @param detail - Discriminated union of context-specific details
 * @param context - Optional technical context (correlationId, turnId, stage)
 */
export function throwInvariantError(
    code: InvariantErrorCode,
    message: string,
    detail: InvariantErrorDetail,
    context?: InvariantErrorContext
): never {
    const payload: InvariantErrorPayload = {
        code,
        message,
        detail,
        stage: context?.stage,
        correlationId: context?.correlationId,
        turnId: context?.turnId
    };

    throw new InvariantError(payload);

}

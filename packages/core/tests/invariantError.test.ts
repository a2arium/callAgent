import { InvariantErrorCodeSchema, InvariantErrorDetailSchema, InvariantErrorPayloadSchema } from '../src/types/invariantError.js';
import { InvariantError, ModuleExecutionError } from '../src/utils/errors.js';
import { throwInvariantError } from '../src/utils/invariantError.js';

describe('InvariantError schemas', () => {
    it('validates a stage_invariant detail', () => {
        const detail = {
            type: 'stage_invariant',
            stage: 'perception',
            required: ['key1'],
            forbidden: ['key2']
        };
        expect(InvariantErrorDetailSchema.parse(detail)).toEqual(detail);
    });

    it('validates a token_validation detail (input)', () => {
        const detail = {
            type: 'token_validation',
            category: 'input',
            token: 't1',
            reason: 'expired'
        };
        expect(InvariantErrorDetailSchema.parse(detail)).toEqual(detail);
    });

    it('validates an observation_validation detail', () => {
        const detail = {
            type: 'observation_validation',
            source: 'user',
            reason: 'missing_payload',
            validation: { failed: true, errors: [{ message: 'error' }] }
        };
        expect(InvariantErrorDetailSchema.parse(detail)).toEqual(detail);
    });

    it('validates a transition_invariant detail', () => {
        const detail = {
            type: 'transition_invariant',
            transitionKind: 'continue',
            reason: 'empty_observations'
        };
        expect(InvariantErrorDetailSchema.parse(detail)).toEqual(detail);
    });

    it('validates a budget_exceeded detail', () => {
        const detail = {
            type: 'budget_exceeded',
            budget: 'turns',
            limit: 10,
            actual: 11
        };
        expect(InvariantErrorDetailSchema.parse(detail)).toEqual(detail);
    });

    it('validates a goal_invariant detail', () => {
        const detail = {
            type: 'goal_invariant',
            goalId: 'g1',
            reason: 'goal_not_found'
        };
        expect(InvariantErrorDetailSchema.parse(detail)).toEqual(detail);
    });

    it('validates a session_config detail', () => {
        const detailSession = {
            type: 'session_config',
            reason: 'session_not_found',
            taskId: 'task-1'
        };
        expect(InvariantErrorDetailSchema.parse(detailSession)).toEqual(detailSession);
        const detailLimit = {
            type: 'session_config',
            reason: 'limit_max_prompts_exceeded',
            limit: 100,
            actual: 100
        };
        expect(InvariantErrorDetailSchema.parse(detailLimit)).toEqual(detailLimit);
    });

    it('rejects an invalid discriminated union member', () => {
        const detail = {
            type: 'invalid_type',
            someField: 'value'
        };
        expect(() => InvariantErrorDetailSchema.parse(detail)).toThrow();
    });

    it('validates full payload', () => {
        const payload = {
            code: 'STAGE_REQUIRES_KEY',
            message: 'Stage requires key',
            stage: 'perception',
            detail: {
                type: 'stage_invariant',
                stage: 'perception',
                required: ['key1']
            }
        };
        expect(InvariantErrorPayloadSchema.parse(payload)).toEqual(payload);
    });
});

describe('InvariantError Classes', () => {
    it('InvariantError correctly captures payload', () => {
        const payload = {
            code: 'GOAL_NOT_FOUND',
            message: 'Goal g1 not found',
            detail: {
                type: 'goal_invariant',
                goalId: 'g1',
                reason: 'goal_not_found'
            }
        } as any;
        const err = new InvariantError(payload);
        expect(err.message).toBe('Goal g1 not found');
        expect(err.code).toBe('GOAL_NOT_FOUND');
        expect(err.detail).toEqual(payload.detail);
        expect(err.name).toBe('InvariantError');
    });

    it('ModuleExecutionError correctly captures payload', () => {
        const inner = new Error('inner failure');
        const err = new ModuleExecutionError(
            'attention',
            'attention module failure',
            inner
        );
        expect(err.message).toBe('attention module failed: attention module failure');
        expect(err.module).toBe('attention');
        expect(err.cause).toBe(inner);
        expect(err.name).toBe('ModuleExecutionError');
    });
});

describe('throwInvariantError factory', () => {
    it('throws InvariantError with correct payload', () => {
        expect(() => {
            throwInvariantError(
                'TOKEN_MISMATCH',
                'Token mismatch detected',
                { type: 'token_validation', category: 'tool', reason: 'mismatch', token: 'got', expectedToken: 'want' }
            );
        }).toThrow(InvariantError);

        try {
            throwInvariantError(
                'TOKEN_MISMATCH',
                'Token mismatch detected',
                { type: 'token_validation', category: 'tool', reason: 'mismatch', token: 'got', expectedToken: 'want' }
            );
        } catch (e: any) {
            expect(e.code).toBe('TOKEN_MISMATCH');
            expect(e.detail.type).toBe('token_validation');
            expect(e.detail.reason).toBe('mismatch');
        }
    });
});

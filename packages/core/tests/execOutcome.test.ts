import { describe, expect, it } from '@jest/globals';
import { ExecOutcomeSchema, ExecResultSchema, type ExecResult } from '../src/types/execOutcome.js';
import { ExecutableAction } from '../src/types/intent.js';

describe('execOutcome schemas', () => {
    it('parses valid ExecResult', () => {
        const parsed = ExecResultSchema.parse({
            status: 'ok',
            data: { message: 'done' },
            toolId: 'language',
        });
        expect(parsed.status).toBe('ok');
        expect(parsed.toolId).toBe('language');
    });

    it('parses valid ExecOutcome', () => {
        const action: ExecutableAction = { kind: 'internal', done: true };
        const parsed = ExecOutcomeSchema.parse({
            action,
            result: { status: 'ok', data: { finished: true } },
        });
        expect(parsed.action.kind).toBe('internal');
    });

    it('keeps generic type structurally compatible with schema', () => {
        const result: ExecResult<{ foo: string }> = {
            status: 'ok',
            data: { foo: 'bar' },
        };
        const parsed = ExecResultSchema.safeParse(result);
        expect(parsed.success).toBe(true);
    });
});

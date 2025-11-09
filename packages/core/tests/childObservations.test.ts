import { extractChildResult, findChildCompletion, isChildCompletedObservation } from '../src/helpers/childObservations.js';
import type { Observation } from '../src/loop/oneTurn.js';
import type { ChildCompletedPayload } from '../src/shared/types/observation.js';

type ChildReturn = {
    ok: boolean;
    data?: {
        html?: string;
        url?: string;
    };
};

const buildObservation = (overrides: Partial<ChildCompletedPayload<ChildReturn>> = {}): Observation<ChildCompletedPayload<ChildReturn>> => ({
    source: 'child',
    kind: 'child.completed',
    payload: {
        token: 'child-token',
        childTaskId: 'child-task',
        agentId: 'child-agent',
        result: {
            id: 'child-task',
            input: { url: 'https://example.com' },
            status: {
                state: 'completed',
                timestamp: new Date().toISOString(),
                metadata: {
                    result: {
                        ok: true,
                        data: {
                            html: '<html></html>',
                            url: 'https://example.com'
                        }
                    }
                }
            }
        }
    },
    provenance: {
        ts: Date.now(),
        turn: 2,
        correlationId: 'child-token'
    }
});

describe('childObservations helpers', () => {
    it('identifies child.completed observations', () => {
        const observation = buildObservation();
        expect(isChildCompletedObservation(observation)).toBe(true);
        expect(isChildCompletedObservation({ kind: 'other', source: 'child', payload: {} })).toBe(false);
    });

    it('extracts nested child results from metadata', () => {
        const observation = buildObservation();
        const result = extractChildResult(observation);
        expect(result).toEqual({
            ok: true,
            data: {
                html: '<html></html>',
                url: 'https://example.com'
            }
        });
    });

    it('finds completion by token and returns typed result', () => {
        const observation = buildObservation();
        const details = findChildCompletion<ChildReturn>([observation], 'child-token');
        expect(details).toBeDefined();
        expect(details?.payload.token).toBe('child-token');
        expect(details?.result?.data?.html).toBe('<html></html>');
    });

    it('returns undefined when no matching token is found', () => {
        const observation = buildObservation();
        const details = findChildCompletion([observation], 'other-token');
        expect(details).toBeUndefined();
    });
});




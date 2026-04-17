import { resolveTopicSelector, type TopicMemberRow } from '../src/internal/conversation/TopicSelector.js';

describe('topic multiplicity rotation', () => {
    it('restarts from first active member when cursor points to missing member', () => {
        const members: TopicMemberRow[] = [
            {
                memberId: 'a#1',
                agentId: 'a',
                role: 'owner',
                registeredAt: '2020-01-01T00:00:00.000Z',
                sessionId: 's-a1',
            },
            {
                memberId: 'a#2',
                agentId: 'a',
                role: 'participant',
                registeredAt: '2020-01-01T00:00:01.000Z',
                sessionId: 's-a2',
            },
            {
                memberId: 'b',
                agentId: 'b',
                role: 'participant',
                registeredAt: '2020-01-01T00:00:02.000Z',
                sessionId: 's-b',
            },
        ];

        const resolved = resolveTopicSelector({ kind: 'round_robin' }, 'a#1', members, 'missing-seat');
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) {
            return;
        }
        expect(resolved.recipients[0]?.memberId).toBe('a#2');
        expect(resolved.nextRotationCursor).toBe('a#2');
    });
});


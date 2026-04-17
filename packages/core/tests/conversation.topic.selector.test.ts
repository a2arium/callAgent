import { resolveTopicSelector } from '../src/internal/conversation/TopicSelector.js';
import type { TopicMemberRow } from '../src/internal/conversation/TopicSelector.js';
import { memberId } from '../src/public-types/conversation/index.js';

describe('TopicSelector', () => {
    const owner: TopicMemberRow = {
        memberId: 'owner',
        agentId: 'owner',
        role: 'owner',
        registeredAt: '2020-01-01T00:00:00.000Z',
        sessionId: 's-owner',
    };
    const p1: TopicMemberRow = {
        memberId: 'p1',
        agentId: 'p1',
        role: 'participant',
        registeredAt: '2020-01-01T00:00:01.000Z',
        sessionId: 's-p1',
    };
    const p2: TopicMemberRow = {
        memberId: 'p2',
        agentId: 'p2',
        role: 'participant',
        registeredAt: '2020-01-01T00:00:02.000Z',
        sessionId: 's-p2',
    };

    it('broadcast orders by role, registeredAt, memberId', () => {
        const members = [p2, owner, p1];
        const r = resolveTopicSelector({ kind: 'broadcast' }, 'owner', members, null);
        expect(r.ok).toBe(true);
        if (!r.ok) {
            return;
        }
        expect(r.recipients.map((x) => x.memberId)).toEqual(['p1', 'p2']);
        expect(r.nextRotationCursor).toBe(null);
    });

    it('round_robin advances cursor and rotates deterministically', () => {
        const members = [owner, p1, p2];
        const a = resolveTopicSelector({ kind: 'round_robin' }, 'owner', members, null);
        expect(a.ok).toBe(true);
        if (!a.ok) {
            return;
        }
        expect(a.recipients).toHaveLength(1);
        expect(a.nextRotationCursor).toBe('p1');
        const b = resolveTopicSelector({ kind: 'round_robin' }, 'owner', members, a.nextRotationCursor);
        expect(b.ok).toBe(true);
        if (!b.ok) {
            return;
        }
        expect(b.recipients[0]!.memberId).not.toBe(a.recipients[0]!.memberId);
        expect(b.nextRotationCursor).toBe('p2');
    });

    it('explicit_recipient returns not member when not a member', () => {
        const members = [owner, p1];
        const r = resolveTopicSelector(
            { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: 'ghost' } },
            'owner',
            members,
            null
        );
        expect(r.ok).toBe(false);
        if (r.ok) {
            return;
        }
        expect(r.error).toBe('RecipientNotMember');
    });

    it('explicit_recipient targets one member', () => {
        const members = [owner, p1, p2];
        const r = resolveTopicSelector(
            { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: 'p2' } },
            'owner',
            members,
            null
        );
        expect(r.ok).toBe(true);
        if (!r.ok) {
            return;
        }
        expect(r.recipients.map((x) => x.memberId)).toEqual(['p2']);
    });

    it('explicit_recipient by memberId', () => {
        const members = [owner, p1, p2];
        const r = resolveTopicSelector(
            { kind: 'explicit_recipient', recipient: { by: 'memberId', memberId: memberId('p2') } },
            'owner',
            members,
            null
        );
        expect(r.ok).toBe(true);
        if (!r.ok) {
            return;
        }
        expect(r.recipients[0]!.memberId).toBe('p2');
    });
});

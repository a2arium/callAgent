import { describe, it, expect } from '@jest/globals';
import { createStopPolicyRegistry } from '../src/internal/conversation/StopPolicyRegistry.js';
import { createTopicSelectorPolicyRegistry } from '../src/internal/conversation/TopicSelectorPolicyRegistry.js';
import { wrapStopPolicyRegistry, wrapTopicSelectorPolicyRegistry } from '../src/testing/policyPurityHarness.js';
import { memberId } from '../src/public-types/conversation/index.js';

describe('policyPurityHarness', () => {
    it('wrapTopicSelectorPolicyRegistry rejects Date.now in strict mode', () => {
        const inner = createTopicSelectorPolicyRegistry();
        const reg = wrapTopicSelectorPolicyRegistry(inner, true);
        reg.register({
            policyId: 'impure',
            select: () => {
                Date.now();
                return { kind: 'selected', recipients: [], nextRotationCursor: null };
            },
        });
        const p = inner.resolve('impure');
        expect(p).toBeDefined();
        expect(() =>
            p!.select({
                tenantId: 't',
                topicId: 'topic',
                senderMemberId: memberId('m1'),
                members: [{ memberId: memberId('m1'), agentId: 'a1', role: 'owner', sessionId: 's' }],
                rotationCursor: null,
                sequenceNumber: 1,
                nowIso: '2020-01-01T00:00:00.000Z',
            })
        ).toThrow(/TopicSelectorPolicy\(impure\)/);
    });

    it('wrapStopPolicyRegistry rejects Math.random in strict mode', () => {
        const inner = createStopPolicyRegistry();
        const reg = wrapStopPolicyRegistry(inner, true);
        reg.register({
            policyId: 'impure-stop',
            evaluate: () => {
                Math.random();
                return { kind: 'continue' as const };
            },
        });
        const p = inner.resolve('impure-stop');
        expect(p).toBeDefined();
        expect(() =>
            p!.evaluate({
                tenantId: 't',
                topicId: 'topic',
                topicCreatedAtIso: '2020-01-01T00:00:00.000Z',
                nowIso: '2020-01-01T00:00:00.000Z',
                sequenceNumber: 1,
                totalMessages: 1,
                totalRounds: 1,
                lastMessage: {
                    senderMemberId: memberId('m1'),
                    speechAct: 'inform',
                    sequenceNumber: 1,
                },
                members: [{ memberId: memberId('m1'), agentId: 'a1', role: 'owner', sessionId: 's' }],
            })
        ).toThrow(/StopPolicy\(impure-stop\)/);
    });

    it('passes through when strict is false', () => {
        const inner = createStopPolicyRegistry();
        const reg = wrapStopPolicyRegistry(inner, false);
        reg.register({
            policyId: 'ok',
            evaluate: () => {
                Date.now();
                return { kind: 'continue' as const };
            },
        });
        const p = inner.resolve('ok');
        expect(
            p!.evaluate({
                tenantId: 't',
                topicId: 'topic',
                topicCreatedAtIso: '2020-01-01T00:00:00.000Z',
                nowIso: '2020-01-01T00:00:00.000Z',
                sequenceNumber: 1,
                totalMessages: 1,
                totalRounds: 1,
                lastMessage: {
                    senderMemberId: memberId('m1'),
                    speechAct: 'inform',
                    sequenceNumber: 1,
                },
                members: [{ memberId: memberId('m1'), agentId: 'a1', role: 'owner', sessionId: 's' }],
            })
        ).toEqual({ kind: 'continue' });
    });
});

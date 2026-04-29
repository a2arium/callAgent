import { runLoop } from '../src/loop/loopRunner.js';
import { initialM } from '../src/loop/init.js';

describe('runLoop conversation delivery checkpointing', () => {
    it('checkpoints consumed conversation deliveries before continuing to the next turn', async () => {
        const ctx: any = {
            reply: async () => undefined,
            task: { id: 'conversation-checkpoint-task', input: {} },
        };
        const M: any = initialM(ctx);
        const conversationObservation: any = {
            source: 'conversation',
            kind: 'topic.message.received',
            payload: {
                kind: 'topic.message.received',
                message: {
                    id: 'msg-checkpoint',
                    conversation: { id: 'topic-checkpoint', kind: 'topic' },
                    senderAgentId: 'sender-agent',
                    senderMemberId: 'sender',
                    recipientAgentId: 'recipient-agent',
                    recipientMemberId: 'recipient',
                    speechAct: 'task',
                    content: { body: { phase: 'suite_agent_contribution', phaseId: 'independent_response' } },
                    sequenceNumber: 1,
                    ts: new Date().toISOString(),
                },
                topic: { id: 'topic-checkpoint', kind: 'topic' },
                selector: { kind: 'broadcast' },
                recipient: { agentId: 'recipient-agent', memberId: 'recipient' },
            },
        };
        const env: any = {
            time: new Date().toISOString(),
            sessionId: 'conversation-checkpoint-task',
            turn: 1,
            budget: { maxTurns: 5, latencyMs: Infinity },
            pending: { inputs: {}, children: {}, tools: {}, groups: {} },
            inbox: { current: [conversationObservation], all: [conversationObservation] },
        };
        let transitionCount = 0;
        const checkpoints: any[] = [];

        const result = await runLoop(
            ctx,
            M,
            env,
            {
                attention: () => ({}),
                perception: (e: any) => e.inbox.current[0],
                learning: (prev: any, _prevAction: any, obs: any) => ({
                    ...prev,
                    learnedMessageId: obs?.payload?.message?.id ?? prev.learnedMessageId,
                }),
                policy: () => ({ kind: 'internal', checkpoint: true } as any),
                shield: (_m: any, intent: any) => ({ action: 'pass', intent }),
                execution: async (action: any) => ({
                    action,
                    result: { status: 'ok', data: {} },
                }),
                transition: () => {
                    transitionCount += 1;
                    if (transitionCount === 1) {
                        return {
                            kind: 'continue',
                            observations: [
                                {
                                    source: 'internal',
                                    kind: 'state.noted',
                                    payload: { turn: 'after-conversation' },
                                },
                            ],
                        } as any;
                    }
                    return { kind: 'complete', result: { ok: true } } as any;
                },
            } as any,
            {
                maxTurns: 3,
                onTurnCheckpoint: async (state) => {
                    checkpoints.push({
                        consumed: Array.from(state.consumedConversationMessageKeys),
                        learnedMessageId: (state.M as any).learnedMessageId,
                        currentKinds: state.env.inbox.current.map((obs: any) => obs.kind),
                    });
                },
            }
        );

        expect(result.outcome.kind).toBe('complete');
        expect(checkpoints).toEqual([
            {
                consumed: [
                    'topic.message.received|msg-checkpoint|topic-checkpoint|topic|recipient',
                ],
                learnedMessageId: 'msg-checkpoint',
                currentKinds: ['state.noted'],
            },
        ]);
    });
});

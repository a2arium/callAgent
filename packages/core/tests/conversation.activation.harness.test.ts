import { jest } from '@jest/globals';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { TaskEngine } from '../src/orchestration/taskEngine.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { PluginManager } from '../src/plugin/pluginManager.js';
import { globalAgentRegistry } from '../src/plugin/AgentRegistry.js';
import type { AgentPlugin } from '../src/plugin/types.js';
import { normalizeObservationInbox } from '../src/loop/types.js';
import type { MentalState } from '../src/loop/types.js';

function clearAgentRegistry(): void {
    const registry = globalAgentRegistry as unknown as { agents: Map<string, unknown>; aliases: Map<string, string> };
    registry.agents.clear();
    registry.aliases.clear();
}

function minimalRecipientPlugin(name: string): AgentPlugin {
    return {
        resolved: {
            agentCard: {
                name,
                version: '1.0.0',
                description: 'activation test recipient',
                supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'http://localhost' }],
                capabilities: {},
                defaultInputModes: ['text/plain'],
                defaultOutputModes: ['text/plain'],
                skills: [{ id: 's1', name: 's1', description: 's1' }],
            },
            runtimeManifest: {
                name,
                version: '1.0.0',
                runMode: 'loop',
            } as AgentPlugin['resolved']['runtimeManifest'],
            agentCardHash: 'h1',
            runtimeManifestHash: 'h2',
            agentCardSource: 'inline',
            runtimeManifestSource: 'inline',
        },
        tenantId: 't-act',
        loop: {
            modules: {
                attention: () => undefined,
                perception: () => ({ kind: 'idle' }),
                learning: (prev: MentalState) => prev,
                policy: () => ({ kind: 'complete', result: { done: true } }),
                shield: () => ({ allowed: true }),
                execution: async () => ({
                    action: { kind: 'internal', done: true },
                    result: { status: 'ok', data: {} },
                }),
                transition: () => ({ kind: 'complete', result: {} }),
            },
        },
    };
}

describe('Conversation recipient activation (TaskEngine)', () => {
    const tenantId = 't-act';
    const senderAgentId = 'sender-id';
    const recipientAgentId = 'recipient-id';
    const threadId = 'thread-act-1';
    const bootstrapSessionId = 'bootstrap-sess';

    beforeEach(() => {
        clearAgentRegistry();
        EngineLocator.setEngine(null as unknown as TaskEngine);
    });

    afterEach(() => {
        clearAgentRegistry();
        EngineLocator.setEngine(null as unknown as TaskEngine);
    });

    it('runs TurnRunner with trigger conversation on the thread-bound recipient session after send', async () => {
        const store = new InMemorySessionManager();
        const engine = new TaskEngine({ sessionStore: store });
        EngineLocator.setEngine(engine);
        PluginManager.registerAgent(minimalRecipientPlugin(recipientAgentId));

        const sessionManager = (engine as unknown as { sessionManager: SessionManager }).sessionManager;
        const conversationService = (engine as unknown as {
            conversationService: {
                startThread: (
                    t: string,
                    sid: string,
                    aid: string,
                    opts: {
                        targetAgentId: string;
                        conversationId: string;
                        message: {
                            senderAgentId: string;
                            speechAct: 'request';
                            content: Record<string, unknown>;
                        };
                    }
                ) => ReturnType<import('../src/internal/conversation/ConversationService.js').ConversationService['startThread']>;
            };
        }).conversationService;

        const turnRunner = (engine as unknown as { turnRunner: { runTurn: (...args: unknown[]) => Promise<unknown> } })
            .turnRunner;
        const runTurnSpy = jest.spyOn(turnRunner, 'runTurn');

        await conversationService.startThread(tenantId, bootstrapSessionId, senderAgentId, {
            targetAgentId: recipientAgentId,
            conversationId: threadId,
            message: {
                senderAgentId,
                speechAct: 'request',
                content: { step: 'open' },
            },
        });

        const recipientRoutingSessionId = `${threadId}:${recipientAgentId}`;
        expect(runTurnSpy).toHaveBeenCalled();
        const convCall = runTurnSpy.mock.calls.find(
            (c) =>
                (c[1] as { trigger?: string; sessionId?: string }).trigger === 'conversation' &&
                (c[1] as { sessionId?: string }).sessionId === recipientRoutingSessionId
        );
        expect(convCall).toBeDefined();
    });

    it('routes delivery.failed to sender thread-bound session when recipient plugin is missing', async () => {
        const store = new InMemorySessionManager();
        const engine = new TaskEngine({ sessionStore: store });
        EngineLocator.setEngine(engine);

        const sessionManager = (engine as unknown as { sessionManager: SessionManager }).sessionManager;
        const conversationService = (engine as unknown as {
            conversationService: import('../src/internal/conversation/ConversationService.js').ConversationService;
        }).conversationService;

        await sessionManager.createConversationThread({
            tenantId,
            conversationId: threadId,
            ownerAgentId: senderAgentId,
            participantAgentId: 'not-registered-recipient',
        });

        const thread = { kind: 'thread' as const, id: threadId };
        await conversationService.send(tenantId, bootstrapSessionId, thread, {
            senderAgentId,
            recipientAgentId: 'not-registered-recipient',
            speechAct: 'inform',
            content: { ping: true },
        });

        const senderBound = await sessionManager.load(tenantId, `${threadId}:${senderAgentId}`);
        const inbox = normalizeObservationInbox(
            (senderBound?.snapshot as { inbox?: unknown } | undefined)?.inbox ?? { current: [], all: [] }
        );
        const failed = inbox.current.find(
            (o) => o.source === 'conversation' && o.kind === 'delivery.failed'
        );
        expect(failed).toBeDefined();
        expect((failed?.payload as { kind?: string; error?: { type?: string } })?.kind).toBe('delivery.failed');
        expect((failed?.payload as { error?: { type?: string } })?.error?.type).toBe('PluginMissing');
    });

    it('does not run a second activation when send is deduplicated by idempotency key', async () => {
        const store = new InMemorySessionManager();
        const engine = new TaskEngine({ sessionStore: store });
        EngineLocator.setEngine(engine);
        PluginManager.registerAgent(minimalRecipientPlugin(recipientAgentId));

        const conversationService = (engine as unknown as {
            conversationService: import('../src/internal/conversation/ConversationService.js').ConversationService;
        }).conversationService;

        const turnRunner = (engine as unknown as { turnRunner: { runTurn: (...args: unknown[]) => Promise<unknown> } })
            .turnRunner;
        const runTurnSpy = jest.spyOn(turnRunner, 'runTurn');

        const started = await conversationService.startThread(tenantId, bootstrapSessionId, senderAgentId, {
            targetAgentId: recipientAgentId,
            conversationId: threadId,
            message: {
                senderAgentId,
                speechAct: 'request',
                content: { step: 'open' },
            },
            idempotencyKey: 'idem-open-only',
        });

        const firstTurnCalls = runTurnSpy.mock.calls.length;
        expect(firstTurnCalls).toBeGreaterThanOrEqual(1);

        runTurnSpy.mockClear();

        const thread = started.thread;
        const replay = await conversationService.send(
            tenantId,
            bootstrapSessionId,
            thread,
            {
                senderAgentId,
                recipientAgentId,
                speechAct: 'request',
                content: { step: 'open' },
            },
            { idempotencyKey: 'idem-open-only' }
        );

        expect(replay.status).toBe('accepted');
        if (replay.status === 'accepted') {
            expect(replay.dedupeHit).toBe(true);
        }
        expect(runTurnSpy).not.toHaveBeenCalled();
    });
});

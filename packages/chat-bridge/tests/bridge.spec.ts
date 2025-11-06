import { InMemorySessionStore } from '../src/internal/stores/inMemorySessionStore.js';
import { createBridge } from '../src/internal/bridge.js';
import type {
    BridgeTaskInput,
    BridgeOptions,
    ChatRoute,
    MessageNormalized,
    ResultPayload
} from '../src/types.js';

describe('chat bridge route propagation', () => {
    function buildMessage(overrides: Partial<MessageNormalized> = {}): MessageNormalized {
        return {
            network: 'web',
            conversationId: 'conv-1',
            userId: 'user-1',
            messageId: 'msg-1',
            text: 'hello bridge',
            attachments: [],
            ...overrides
        };
    }

    function createBridgeHarness(overrides: Partial<BridgeOptions> = {}): {
        options: BridgeOptions;
        sessionStore: InMemorySessionStore;
        chatSender: BridgeOptions['chatSender'];
        invoker: BridgeOptions['invoker'];
    } {
        const sessionStore = new InMemorySessionStore();
        const chatSender = {
            sendMessage: jest.fn(async () => { }),
            sendTyping: jest.fn(async () => { }),
            sendMedia: jest.fn(async () => { }),
            sendMarkup: jest.fn(async () => { })
        };

        const invoker = {
            start: jest.fn(async (params: { id: string; input: BridgeTaskInput; agentId: string; tenantId?: string; route: ChatRoute }): Promise<ResultPayload> => ({
                id: params.id,
                status: 'completed',
                output: ''
            })),
            resume: jest.fn(async (params: { id: string; token: string; input: BridgeTaskInput; tenantId?: string; route: ChatRoute }): Promise<ResultPayload> => ({
                id: params.id,
                status: 'completed',
                output: ''
            }))
        };

        const options: BridgeOptions = {
            sessionStore,
            agentSelector: async () => 'agent-1',
            chatSender,
            invoker,
            realtime: undefined,
            timeouts: undefined,
            tenantIdResolver: undefined,
            logger: undefined,
            metrics: undefined,
            ...overrides
        };

        return { options, sessionStore, chatSender, invoker };
    }

    test('start flow includes route in task input', async () => {
        const { options, invoker } = createBridgeHarness();
        const bridge = createBridge(options);
        const msg = buildMessage();

        await bridge.handleIncomingMessage(msg);

        const startMock = invoker.start as jest.Mock;
        expect(startMock).toHaveBeenCalledTimes(1);

        const call = startMock.mock.calls[0][0];
        expect(call.input.route).toEqual({
            network: msg.network,
            conversationId: msg.conversationId,
            userId: msg.userId
        });
        expect(call.input.text).toBe(msg.text);
    });

    test('resume flow includes route in task input', async () => {
        const { options, sessionStore, invoker } = createBridgeHarness();
        const bridge = createBridge(options);
        const msg = buildMessage({ messageId: 'msg-2', text: 'second' });
        const sessionKey = `${msg.network}:${msg.conversationId}`;
        await sessionStore.upsert({
            key: sessionKey,
            agentId: 'agent-1',
            taskId: 'task-123',
            state: 'waitingInput',
            token: 'token-123',
            lastActivityAt: Date.now()
        });

        await bridge.handleIncomingMessage(msg);

        const resumeMock = invoker.resume as jest.Mock;
        const startMock = invoker.start as jest.Mock;
        expect(resumeMock).toHaveBeenCalledTimes(1);
        expect(startMock).not.toHaveBeenCalled();
        const call = resumeMock.mock.calls[0][0];
        expect(call.input.route).toEqual({
            network: msg.network,
            conversationId: msg.conversationId,
            userId: msg.userId
        });
        expect(call.input.text).toBe(msg.text);
    });
});


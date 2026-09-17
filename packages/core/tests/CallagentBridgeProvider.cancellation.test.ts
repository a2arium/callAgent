import { afterEach, describe, expect, it } from '@jest/globals';
import { telemetry } from '../src/telemetry/TelemetryCollector.js';
import { CallagentBridgeProvider } from '../src/telemetry/providers/CallagentBridgeProvider.js';

afterEach(() => {
    telemetry.clearProviders();
});

describe('CallagentBridgeProvider terminal telemetry', () => {
    it('marks a timed-out call conversation as failed with a stable terminal reason', () => {
        const bridge = new CallagentBridgeProvider('root');
        bridge.startConversation({
            conversationId: 'conversation-timeout',
            type: 'call',
            startedAt: 100,
        });

        bridge.endConversation({
            conversationId: 'conversation-timeout',
            type: 'call',
            startedAt: 100,
        }, {
            callId: 'call-timeout',
            terminalAt: 150,
            terminalReason: 'timeout',
            success: false,
            errorCount: 1,
        });

        const node = telemetry.getNode('conversation-timeout');
        expect(node).toMatchObject({
            status: 'failure',
            endTime: 150,
            providerData: {
                callId: 'call-timeout',
                terminalReason: 'timeout',
                terminalAt: 150,
            },
        });
        expect(node?.error).toMatchObject({ code: 'LLM_TIMEOUT' });
    });

    it('keeps a completed call conversation successful', () => {
        const bridge = new CallagentBridgeProvider('root');
        bridge.startConversation({
            conversationId: 'conversation-completed',
            type: 'call',
            startedAt: 100,
        });

        bridge.endConversation({
            conversationId: 'conversation-completed',
            type: 'call',
            startedAt: 100,
        }, {
            callId: 'call-completed',
            terminalAt: 125,
            terminalReason: 'completed',
            success: true,
            errorCount: 0,
        });

        expect(telemetry.getNode('conversation-completed')).toMatchObject({
            status: 'success',
            endTime: 125,
            providerData: { terminalReason: 'completed' },
        });
    });
});

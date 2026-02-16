import { ProgrammaticInvoker } from '@a2arium/callagent-chat-bridge';
import { PluginManager } from '@a2arium/callagent-core';
import EchoButton from './echo-button-v2.js';
import * as readline from 'readline';

console.log('DEBUG: Imported EchoButton:', JSON.stringify(EchoButton, null, 2));
console.log('DEBUG: EchoButton.handleTask type:', typeof (EchoButton as any).handleTask);

// Register agent directly since we are in dev/test environment
PluginManager.registerAgent(EchoButton);

// Mock chat sender
const mockSender = {
    sendMessage: async (route: any, text: string) => {
        console.log(`\n🤖 [BOT]: ${text}`);
    },
    sendMedia: async (route: any, media: any) => {
        console.log(`\n🤖 [BOT MEDIA]:`, media);
    },
    sendMarkup: async (route: any, markup: any) => {
        console.log(`\n🤖 [BOT MARKUP]:`, markup);
        if (markup.buttons) {
            console.log('   (Found buttons! Payload "hello_from_button" is key)');
        }
    },
    sendTyping: async () => { }
};

// Simulate separate requests/invocations
async function handleMessage(text: string, payload?: string, taskId: string = 'test-task-1') {
    console.log(`\n👤 [USER]: ${text} ${payload ? `(payload: ${payload})` : ''}`);

    // 🔥 CRITICAL: New Invoker instance per request to test persistence
    const invoker = new ProgrammaticInvoker({ chatSender: mockSender as any });

    if (payload) {
        // RESUME
        console.log('⚡️ Resuming task:', taskId);
        await invoker.resume({
            id: taskId,
            // In a real bridge, token is retrieved from state or passed in payload.
            // For this test, we rely on invoker's internal recovery mechanism (listEventsSince)
            // or we'd need to capture it from previous output.
            token: '',
            input: { text: payload, route: { network: 'telegram', conversationId: 'user1' } },
            route: { network: 'telegram', conversationId: 'user1' }
        });
    } else {
        // START
        console.log('⚡️ Starting task:', taskId);
        await invoker.start({
            id: taskId,
            agentId: 'echo-button-persistent-test',
            input: { text, route: { network: 'telegram', conversationId: 'user1' } },
            route: { network: 'telegram', conversationId: 'user1' }
        });
    }
}

async function run() {
    console.log('🧪 Starting Reproduction Test for Persistent Invoker');
    const taskId = `task-${Date.now()}`;

    // 1. Start Conversation
    await handleMessage('/start', undefined, taskId);

    // Wait a bit
    await new Promise(r => setTimeout(r, 2000));

    // 2. Click Button (Resume)
    // We expect the bot to say "✅ Button click received! Payload: hello_from_button"
    // If bug exists, it will say "👋 Hello! Click the button below..." again (re-run start)
    await handleMessage('🔘 Click Me', 'hello_from_button', taskId);

    console.log('\n✅ Test sequence finished. Check output above.');
    process.exit(0);
}

run().catch(console.error);

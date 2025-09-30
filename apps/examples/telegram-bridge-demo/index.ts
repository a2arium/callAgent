import { createCallMessenger } from '@callmessenger/core';
import {
    createBridge,
    PrismaSessionStore,
    getChatPrismaClient,
    createCallMessengerChatSender,
    ProgrammaticInvoker
} from '@a2arium/callagent-chat-bridge';
import { normalizeFromCallMessengerEvent } from '@a2arium/callagent-chat-bridge';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PluginManager } from '@a2arium/callagent-core';

// Example: Telegram + Bridge wiring with real callMessenger
async function main() {
    const port = Number(process.env.CM_TG_WEBHOOK_PORT) || 88;
    const cm = createCallMessenger({
        https: { enabled: true, port, tls: { selfSigned: true } },
        telegram: {
            enabled: true,
            botToken: process.env.CM_TG_BOT_TOKEN!,
            webhook: {}
            // Webhook public URL is auto-registered by callMessenger if supported.
        },
        web: { enabled: false }
    });

    const chatSender = createCallMessengerChatSender(cm);

    // Resolve local agent path relative to this file to avoid duplicated cwd segments
    const here = dirname(fileURLToPath(import.meta.url));
    const localAgentPath = resolve(here, 'AgentModule.ts');

    // Preload the local agent once so subsequent messages don't attempt to reload it
    await PluginManager.loadAgentWithDependencies(localAgentPath).catch(() => null);

    const bridge = createBridge({
        sessionStore: new PrismaSessionStore(getChatPrismaClient()),
        agentSelector: async () => 'telegram-bridge-demo-agent',
        chatSender,
        invoker: new ProgrammaticInvoker({ chatSender }),
        timeouts: { inputWaitMs: 15 * 60 * 1000 },
        tenantIdResolver: () => 'default',
        logger: {
            debug: (msg: string, meta?: Record<string, unknown>) => console.debug(`[bridge] ${msg}`, meta || {}),
            info: (msg: string, meta?: Record<string, unknown>) => console.info(`[bridge] ${msg}`, meta || {}),
            warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`[bridge] ${msg}`, meta || {}),
            error: (msg: string, meta?: Record<string, unknown>) => console.error(`[bridge] ${msg}`, meta || {})
        }
    });

    cm.on('message.received', async (e) => {
        const m = normalizeFromCallMessengerEvent(e);
        console.log('message.received', m);
        if (m) await bridge.handleIncomingMessage(m);
    });
    cm.on('button.clicked', async (e) => {
        const m = normalizeFromCallMessengerEvent(e);
        if (m) await bridge.handleIncomingMessage(m);
    });

    await cm.listen();
    console.log('Telegram bridge demo running on port', port);
}

main().catch(err => { console.error(err); process.exit(1); });



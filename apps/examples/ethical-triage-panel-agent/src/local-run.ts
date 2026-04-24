import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
    ConversationService,
    InMemorySessionManager,
    SessionManager,
    createDbMessageLog,
} from '@a2arium/callagent-core/unstable';
import { registerEthicalTriageTopicProjection } from './composition.js';
import { runEthicalTriageDeliberation, type TranscriptSink } from './deliberation-driver.js';

function createDemoConversationService(): ConversationService {
    const store = new InMemorySessionManager();
    const sessionManager = new SessionManager(store);
    return new ConversationService(sessionManager, {
        routeTargetForThread: ({
            threadId,
            recipientAgentId: recipient,
        }: {
            threadId: string;
            recipientAgentId: string;
        }) => ({
            tenantId: 'ethical-triage-demo',
            sessionId: `${threadId}:${recipient}`,
            agentId: recipient,
        }),
        activateConversationRecipient: async () => ({ ok: true }),
        messageLog: createDbMessageLog(sessionManager),
        resolveThreadTtlMs: () => null,
    });
}

function createFileTranscriptSink(filePath: string): TranscriptSink & { flush: () => void } {
    const lines: string[] = [];
    const push = (s: string) => {
        lines.push(s);
    };
    return {
        appendBlock(title, blockLines) {
            push('');
            push('═'.repeat(76));
            push(` ${title}`);
            push('─'.repeat(76));
            for (const ln of blockLines) {
                push(` ${ln}`);
            }
        },
        flush() {
            const header = [
                'Ethical ICU Triage Panel — conversation transcript',
                `Generated: ${new Date().toISOString()}`,
                'All in-topic natural language: Russian (payload field names: English).',
                '',
            ];
            mkdirSync(path.dirname(filePath), { recursive: true });
            writeFileSync(filePath, [...header, ...lines].join('\n'), 'utf8');
        },
    };
}

export async function runLocalTranscriptDemo(outPath?: string): Promise<string> {
    registerEthicalTriageTopicProjection();
    const service = createDemoConversationService();
    const tenantId = 'ethical-triage-demo';
    const sessionId = 'sess-demo';
    const topicId = `topic-ethical-triage-${Date.now()}`;
    const resolvedPath =
        outPath ??
        path.resolve(process.cwd(), 'ethical-triage-transcript.txt');

    const sink = createFileTranscriptSink(resolvedPath);

    await runEthicalTriageDeliberation({
        service,
        tenantId,
        sessionId,
        topicId,
        transcript: sink,
    });

    sink.flush();
    return resolvedPath;
}

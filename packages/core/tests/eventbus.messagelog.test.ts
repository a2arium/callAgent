import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { createDbMessageLog } from '../src/eventbus/dbMessageLog.js';
import { MemberIdSchema } from '../src/public-types/conversation/schemas.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const coreSrc = join(__dirname, '../src');

function walkTsFiles(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) {
            walkTsFiles(p, acc);
        } else if (name.isFile() && name.name.endsWith('.ts')) {
            acc.push(p);
        }
    }
    return acc;
}

describe('DbMessageLog', () => {
    const tenantId = 't-ml';
    const conversationId = 'conv-ml-1';

    it('append + findByIdempotency + read replay shape', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const log = createDbMessageLog(sessionManager);

        const first = await log.append({
            tenantId,
            conversationId,
            conversationKind: 'thread',
            speechAct: 'inform',
            senderAgentId: 'a1',
            senderMemberId: MemberIdSchema.parse('a1'),
            payload: { content: { x: 1 } },
            idempotencyKey: 'idem-ml-1',
            deliveries: [
                {
                    recipientAgentId: 'a2',
                    recipientMemberId: MemberIdSchema.parse('a2'),
                    sessionId: 's2',
                },
            ],
        });
        expect(first.kind).toBe('appended');

        const second = await log.append({
            tenantId,
            conversationId,
            conversationKind: 'thread',
            speechAct: 'inform',
            senderAgentId: 'a1',
            senderMemberId: MemberIdSchema.parse('a1'),
            payload: { content: { x: 1 } },
            idempotencyKey: 'idem-ml-1',
            deliveries: [
                {
                    recipientAgentId: 'a2',
                    recipientMemberId: MemberIdSchema.parse('a2'),
                    sessionId: 's2',
                },
            ],
        });
        expect(second.kind).toBe('dedupeHit');
        if (first.kind === 'appended' && second.kind === 'dedupeHit') {
            expect(second.messageId).toBe(first.messageId);
            expect(second.sequenceNumber).toBe(first.sequenceNumber);
        }

        const found = await log.findByIdempotency({
            tenantId,
            conversationId,
            senderMemberId: MemberIdSchema.parse('a1'),
            idempotencyKey: 'idem-ml-1',
        });
        expect(found?.messageId).toBe(first.kind === 'appended' ? first.messageId : undefined);

        const page = await log.read({ tenantId, conversationId, fromSequence: 0 });
        expect(page.length).toBeGreaterThanOrEqual(1);
    });

    it('guards: appendConversationMessage only in dbMessageLog + store implementations', () => {
        const allowedSubstrings = ['dbMessageLog.ts', 'SessionManager.ts', 'InMemorySessionManager.ts'];
        const files = walkTsFiles(coreSrc);
        const offenders: string[] = [];
        for (const f of files) {
            if (allowedSubstrings.some((s) => f.endsWith(s))) {
                continue;
            }
            const text = readFileSync(f, 'utf8');
            if (text.includes('appendConversationMessage')) {
                offenders.push(f);
            }
        }
        expect(offenders).toEqual([]);
    });
});

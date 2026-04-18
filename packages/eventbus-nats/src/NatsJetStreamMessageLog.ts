import { createHash } from 'node:crypto';
import type { JetStreamClient, JetStreamManager, NatsConnection } from 'nats';
import { DiscardPolicy, JSONCodec, RetentionPolicy, StorageType } from 'nats';
import { v7 as uuidv7 } from 'uuid';
import { MessageLogRecordSchema } from '@a2arium/callagent-core';
import type {
    MessageLog,
    MessageLogAppendParams,
    MessageLogAppendResult,
    MessageLogFindByIdempotencyParams,
    MessageLogReadParams,
    MessageLogRecord,
} from '@a2arium/callagent-core';
import { encodeSegment, msgLogSubject } from './subjectTokens.js';

const jc = JSONCodec<MessageLogRecord>();

const DEFAULT_STREAM = 'CALLAGENT_MSGLOG';
const DEFAULT_SUBJECT_PREFIX = 'callagent.msglog';
const DEFAULT_KV_IDEMP = 'CALLAGENT_MSGLOG_IDEMP';

function idempotencyKvKey(p: MessageLogFindByIdempotencyParams): string {
    const h = createHash('sha256')
        .update(`${p.tenantId}\0${p.conversationId}\0${p.senderMemberId}\0${p.idempotencyKey}`, 'utf8')
        .digest('base64url');
    return `idem.${h}`;
}

function idempotencyMsgId(p: MessageLogAppendParams): string | undefined {
    if (!p.idempotencyKey) {
        return undefined;
    }
    return createHash('sha256')
        .update(`${p.tenantId}\0${p.conversationId}\0${p.senderMemberId}\0${p.idempotencyKey}`, 'utf8')
        .digest('hex')
        .slice(0, 32);
}

export type NatsJetStreamMessageLogOptions = {
    connection: NatsConnection;
    jetstream: JetStreamClient;
    jetstreamManager: JetStreamManager;
    streamName?: string;
    subjectPrefix?: string;
    idempotencyKvBucket?: string;
};

export class NatsJetStreamMessageLog implements MessageLog {
    private readonly streamName: string;
    private readonly subjectPrefix: string;
    private readonly idempotencyBucket: string;
    private ensured = false;

    constructor(private readonly opts: NatsJetStreamMessageLogOptions) {
        this.streamName = opts.streamName ?? DEFAULT_STREAM;
        this.subjectPrefix = opts.subjectPrefix ?? DEFAULT_SUBJECT_PREFIX;
        this.idempotencyBucket = opts.idempotencyKvBucket ?? DEFAULT_KV_IDEMP;
    }

    private async ensureInfrastructure(): Promise<void> {
        if (this.ensured) {
            return;
        }
        const jsm = this.opts.jetstreamManager;
        try {
            await jsm.streams.info(this.streamName);
        } catch {
            await jsm.streams.add({
                name: this.streamName,
                subjects: [`${this.subjectPrefix}.>`],
                retention: RetentionPolicy.Limits,
                storage: StorageType.File,
                discard: DiscardPolicy.Old,
            });
        }
        const kvStream = `KV_${this.idempotencyBucket}`;
        try {
            await jsm.streams.info(kvStream);
        } catch {
            await jsm.streams.add({
                name: kvStream,
                subjects: [`$KV.${this.idempotencyBucket}.>`],
                retention: RetentionPolicy.Limits,
                storage: StorageType.File,
                discard: DiscardPolicy.Old,
            });
        }
        this.ensured = true;
    }

    private subjectFor(p: { tenantId: string; conversationId: string }): string {
        return msgLogSubject(this.subjectPrefix, p.tenantId, p.conversationId);
    }

    async append(params: MessageLogAppendParams): Promise<MessageLogAppendResult> {
        await this.ensureInfrastructure();
        const kv = await this.opts.jetstream.views.kv(this.idempotencyBucket);

        if (params.idempotencyKey) {
            const idemKey = params.idempotencyKey;
            const existingRaw = await kv.get(
                idempotencyKvKey({
                    tenantId: params.tenantId,
                    conversationId: params.conversationId,
                    senderMemberId: params.senderMemberId,
                    idempotencyKey: idemKey,
                })
            );
            if (existingRaw?.value?.length) {
                const parsed = JSON.parse(new TextDecoder().decode(existingRaw.value)) as {
                    messageId: string;
                    sequenceNumber: number;
                    createdAt: string;
                };
                return {
                    kind: 'dedupeHit',
                    messageId: parsed.messageId,
                    sequenceNumber: parsed.sequenceNumber,
                    createdAt: parsed.createdAt,
                };
            }
        }

        const messageId = `msg-${uuidv7()}`;
        const payloadRecord: Record<string, unknown> =
            typeof params.payload === 'object' && params.payload !== null && !Array.isArray(params.payload)
                ? (params.payload as Record<string, unknown>)
                : { content: params.payload };

        const headKey = `seq.${encodeSegment(params.tenantId)}.${encodeSegment(params.conversationId)}`;
        let sequenceNumber = 1;
        for (let attempt = 0; attempt < 12; attempt++) {
            const cur = await kv.get(headKey);
            const parsedPrev =
                cur?.value && cur.value.length > 0
                    ? Number.parseInt(new TextDecoder().decode(cur.value), 10)
                    : 0;
            const next = Number.isFinite(parsedPrev) ? parsedPrev + 1 : 1;
            sequenceNumber = next;
            try {
                if (cur?.revision !== undefined) {
                    await kv.update(headKey, String(sequenceNumber), cur.revision);
                } else {
                    await kv.create(headKey, String(sequenceNumber));
                }
                break;
            } catch {
                /* CAS conflict */
            }
        }

        const createdAt = new Date().toISOString();
        const record: MessageLogRecord = {
            messageId,
            sequenceNumber,
            conversationKind: params.conversationKind,
            senderAgentId: params.senderAgentId,
            senderMemberId: params.senderMemberId,
            selectorKind: params.selectorKind,
            selectorPolicyId: params.selectorPolicyId,
            speechAct: params.speechAct,
            payload: payloadRecord,
            correlationId: params.correlationId,
            idempotencyKey: params.idempotencyKey,
            createdAt,
        };
        MessageLogRecordSchema.parse(record);

        const subj = this.subjectFor(params);
        const msgId = idempotencyMsgId(params);
        try {
            const pa = await this.opts.jetstream.publish(subj, jc.encode(record), msgId ? { msgID: msgId } : {});
            if (pa.duplicate && params.idempotencyKey) {
                const again = await kv.get(
                    idempotencyKvKey({
                        tenantId: params.tenantId,
                        conversationId: params.conversationId,
                        senderMemberId: params.senderMemberId,
                        idempotencyKey: params.idempotencyKey,
                    })
                );
                if (again?.value?.length) {
                    const parsed = JSON.parse(new TextDecoder().decode(again.value)) as {
                        messageId: string;
                        sequenceNumber: number;
                        createdAt: string;
                    };
                    return {
                        kind: 'dedupeHit',
                        messageId: parsed.messageId,
                        sequenceNumber: parsed.sequenceNumber,
                        createdAt: parsed.createdAt,
                    };
                }
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.toLowerCase().includes('duplicate') && params.idempotencyKey) {
                const again = await kv.get(
                    idempotencyKvKey({
                        tenantId: params.tenantId,
                        conversationId: params.conversationId,
                        senderMemberId: params.senderMemberId,
                        idempotencyKey: params.idempotencyKey,
                    })
                );
                if (again?.value?.length) {
                    const parsed = JSON.parse(new TextDecoder().decode(again.value)) as {
                        messageId: string;
                        sequenceNumber: number;
                        createdAt: string;
                    };
                    return {
                        kind: 'dedupeHit',
                        messageId: parsed.messageId,
                        sequenceNumber: parsed.sequenceNumber,
                        createdAt: parsed.createdAt,
                    };
                }
            }
            throw e;
        }

        if (params.idempotencyKey) {
            await kv.put(
                idempotencyKvKey({
                    tenantId: params.tenantId,
                    conversationId: params.conversationId,
                    senderMemberId: params.senderMemberId,
                    idempotencyKey: params.idempotencyKey,
                }),
                JSON.stringify({
                    messageId,
                    sequenceNumber,
                    createdAt,
                })
            );
        }

        return { kind: 'appended', messageId, sequenceNumber, createdAt };
    }

    async read(params: MessageLogReadParams): Promise<ReadonlyArray<MessageLogRecord>> {
        await this.ensureInfrastructure();
        const jsm = this.opts.jetstreamManager;
        const info = await jsm.streams.info(this.streamName);
        const lastSeq = info.state.last_seq;
        const wantSubj = this.subjectFor(params);
        const fromSeq = params.fromSequence ?? 0;
        const limit = params.limit ?? 500;
        const out: MessageLogRecord[] = [];
        for (let seq = 1; seq <= lastSeq && out.length < limit; seq++) {
            try {
                const sm = await jsm.streams.getMessage(this.streamName, { seq });
                if (sm.subject !== wantSubj) {
                    continue;
                }
                const rec = jc.decode(sm.data);
                const parsed = MessageLogRecordSchema.safeParse(rec);
                if (!parsed.success) {
                    continue;
                }
                if (parsed.data.sequenceNumber >= fromSeq) {
                    out.push(parsed.data);
                }
            } catch {
                /* missing seq */
            }
        }
        return out;
    }

    async *replay(params: MessageLogReadParams): AsyncIterable<MessageLogRecord> {
        const rows = await this.read({ ...params, limit: params.limit ?? 500 });
        for (const r of rows) {
            yield r;
        }
    }

    async findByIdempotency(params: MessageLogFindByIdempotencyParams): Promise<MessageLogRecord | null> {
        await this.ensureInfrastructure();
        const kv = await this.opts.jetstream.views.kv(this.idempotencyBucket);
        const ent = await kv.get(idempotencyKvKey(params));
        if (!ent?.value?.length) {
            return null;
        }
        const meta = JSON.parse(new TextDecoder().decode(ent.value)) as {
            messageId: string;
            sequenceNumber: number;
            createdAt: string;
        };
        const rows = await this.read({
            tenantId: params.tenantId,
            conversationId: params.conversationId,
            fromSequence: meta.sequenceNumber,
            limit: 1,
        });
        return rows[0] ?? null;
    }
}

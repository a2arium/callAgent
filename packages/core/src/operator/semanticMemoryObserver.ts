export type SemanticMemoryListParams = {
    tenantId: string;
    key?: string;
    tag?: string;
    entity?: string;
    entityType?: string;
    agentId?: string;
    taskId?: string;
    since?: string;
    until?: string;
    hasBlob?: boolean;
    hasAlignment?: boolean;
    limit: number;
    cursor?: string;
};

export type SemanticMemoryItem = {
    key: string;
    valuePreview: unknown;
    tags: string[];
    createdAt: string;
    updatedAt: string;
    hasBlob: boolean;
    blobMetadata?: unknown;
    alignmentCount: number;
    entities: Array<{ entityId: string; entityType?: string; canonicalName?: string; fieldPath: string; originalValue?: string; confidence?: string }>;
    activity: {
        reads: number;
        writes: number;
        deletes: number;
        lastReadAt?: string;
        lastWriteAt?: string;
        lastDeleteAt?: string;
    };
    flags: string[];
};

export type SemanticMemoryPage = {
    items: SemanticMemoryItem[];
    pageInfo: { nextCursor?: string; hasMore: boolean; limit: number };
    summary: {
        totalOnPage: number;
        withBlob: number;
        withAlignment: number;
        noTags: number;
        recentlyRead: number;
        recentlyWritten: number;
    };
};

export type SemanticMemoryActivityItem = {
    id: string;
    taskId: string;
    seq: number;
    timestamp: string;
    op: 'read' | 'write' | 'delete';
    keys: string[];
    keyCount: number;
    resultKeys: string[];
    resultCount?: number;
    query?: unknown;
    status?: string;
    backend?: string;
    source?: string;
    turnSeq?: number;
    agentId?: string;
    traceId?: string;
    spanId?: string;
};

export type SemanticMemoryActivityPage = {
    items: SemanticMemoryActivityItem[];
    pageInfo: { nextCursor?: string; hasMore: boolean; limit: number };
};

export type SemanticEntityItem = {
    id: string;
    entityType: string;
    canonicalName: string;
    aliases: string[];
    confidence: number;
    metadata?: unknown;
    createdAt: string;
    updatedAt: string;
    alignmentCount: number;
    memoryKeys: string[];
};

export type SemanticEntityPage = {
    items: SemanticEntityItem[];
    pageInfo: { nextCursor?: string; hasMore: boolean; limit: number };
};

export type SemanticProbeParams = {
    tenantId: string;
    pattern?: string;
    tag?: string;
    filters?: Array<{ path: string; operator: string; value: unknown }>;
    limit: number;
    random?: boolean;
    expectedKey?: string;
};

export type SemanticProbeResult = {
    query: Omit<SemanticProbeParams, 'tenantId'>;
    resultKeys: string[];
    items: SemanticMemoryItem[];
    expected?: { key: string; present: boolean; rank?: number };
    notes: string[];
};

type DateLike = Date | string;

type MemoryRow = {
    key: string;
    value: unknown;
    tags?: string[];
    blobData?: unknown;
    blobMetadata?: unknown;
    createdAt?: DateLike;
    updatedAt?: DateLike;
};

type EntityRow = {
    id: string;
    entityType: string;
    canonicalName: string;
    aliases?: string[];
    confidence?: number;
    metadata?: unknown;
    createdAt?: DateLike;
    updatedAt?: DateLike;
};

type AlignmentRow = {
    id?: string;
    memoryKey: string;
    fieldPath: string;
    entityId: string;
    originalValue?: string;
    confidence?: string;
    alignedAt?: DateLike;
    entity?: Partial<EntityRow>;
};

type WMEventRow = {
    eventId: string;
    sessionId: string;
    seq: number;
    type: string;
    payload: Record<string, unknown>;
    createdAt: DateLike;
};

type Delegate<T> = {
    findMany?: (args: Record<string, unknown>) => Promise<T[]>;
    findUnique?: (args: Record<string, unknown>) => Promise<T | null>;
    update?: (args: Record<string, unknown>) => Promise<T>;
    updateMany?: (args: Record<string, unknown>) => Promise<unknown>;
    delete?: (args: Record<string, unknown>) => Promise<T>;
    deleteMany?: (args: Record<string, unknown>) => Promise<unknown>;
    count?: (args: Record<string, unknown>) => Promise<number>;
};

export type SemanticMemoryPrisma = {
    agentMemoryStore?: Delegate<MemoryRow>;
    entityStore?: Delegate<EntityRow>;
    entityAlignment?: Delegate<AlignmentRow>;
    wMEvent?: Delegate<WMEventRow>;
    $transaction?: <T>(callback: (tx: SemanticMemoryPrisma) => Promise<T>) => Promise<T>;
};

export class SemanticMemoryObserverRepository {
    constructor(private readonly prisma: SemanticMemoryPrisma | undefined) {}

    isAvailable(): boolean {
        return typeof this.prisma?.agentMemoryStore?.findMany === 'function';
    }

    async list(params: SemanticMemoryListParams): Promise<SemanticMemoryPage> {
        this.assertMemoryAvailable();
        const limit = clampLimit(params.limit);
        const offset = decodeOffset(params.cursor);
        const [entityKeys, activityKeys] = await Promise.all([
            this.keysForEntityFilter(params),
            this.keysForActivityFilter(params),
        ]);
        const where = this.buildMemoryWhere(params, intersectOptionalKeys(entityKeys, activityKeys));
        const rows = await this.prisma!.agentMemoryStore!.findMany!({
            where,
            orderBy: [{ updatedAt: 'desc' }, { key: 'asc' }],
            skip: offset,
            take: limit + 1,
        });
        const pageRows = rows.slice(0, limit);
        const items = await this.decorateMemoryRows(params.tenantId, pageRows);
        const summary = summarizeItems(items);
        return {
            items,
            pageInfo: {
                ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
                hasMore: rows.length > limit,
                limit,
            },
            summary,
        };
    }

    async detail(params: { tenantId: string; key: string }): Promise<SemanticMemoryItem & { value: unknown } | null> {
        this.assertMemoryAvailable();
        const row = await this.prisma!.agentMemoryStore!.findUnique?.({
            where: { tenantId_key: { tenantId: params.tenantId, key: params.key } },
        }) ?? null;
        if (!row) return null;
        const [item] = await this.decorateMemoryRows(params.tenantId, [row]);
        return item ? { ...item, value: row.value } : null;
    }

    async activity(params: {
        tenantId: string;
        key?: string;
        taskId?: string;
        agentId?: string;
        op?: 'read' | 'write' | 'delete';
        since?: string;
        until?: string;
        limit: number;
        cursor?: string;
    }): Promise<SemanticMemoryActivityPage> {
        if (typeof this.prisma?.wMEvent?.findMany !== 'function') {
            return { items: [], pageInfo: { hasMore: false, limit: clampLimit(params.limit) } };
        }
        const limit = clampLimit(params.limit);
        const offset = decodeOffset(params.cursor);
        const where: Record<string, unknown> = {
            tenantId: params.tenantId,
            type: { in: params.op ? [`memory.${params.op}`] : ['memory.read', 'memory.write', 'memory.delete'] },
            ...(params.taskId ? { sessionId: params.taskId } : {}),
            ...createdAtRange(params.since, params.until),
        };
        const filtered: SemanticMemoryActivityItem[] = [];
        let scanned = 0;
        let exhausted = false;
        const batchSize = Math.max(200, limit + 1);
        while (filtered.length <= limit && !exhausted) {
            const rows = await this.prisma.wMEvent.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
                skip: offset + scanned,
                take: batchSize,
            });
            exhausted = rows.length < batchSize;
            for (const row of rows) {
                scanned++;
                const item = toActivityItem(row);
                if (!item) continue;
                if (params.key && !item.keys.includes(params.key) && !item.resultKeys.includes(params.key)) continue;
                if (params.agentId && item.agentId !== params.agentId) continue;
                filtered.push(item);
                if (filtered.length > limit) break;
            }
        }
        const hasMore = filtered.length > limit || !exhausted;
        return {
            items: filtered.slice(0, limit),
            pageInfo: {
                ...(hasMore ? { nextCursor: String(offset + scanned) } : {}),
                hasMore,
                limit,
            },
        };
    }

    async entities(params: {
        tenantId: string;
        search?: string;
        entityType?: string;
        limit: number;
        cursor?: string;
    }): Promise<SemanticEntityPage> {
        if (typeof this.prisma?.entityStore?.findMany !== 'function') {
            return { items: [], pageInfo: { hasMore: false, limit: clampLimit(params.limit) } };
        }
        const limit = clampLimit(params.limit);
        const offset = decodeOffset(params.cursor);
        const where: Record<string, unknown> = {
            tenantId: params.tenantId,
            ...(params.entityType ? { entityType: params.entityType } : {}),
            ...(params.search ? {
                OR: [
                    { canonicalName: { contains: params.search, mode: 'insensitive' } },
                    { aliases: { has: params.search } },
                ],
            } : {}),
        };
        const rows = await this.prisma.entityStore.findMany({
            where,
            orderBy: [{ updatedAt: 'desc' }, { canonicalName: 'asc' }],
            skip: offset,
            take: limit + 1,
        });
        const pageRows = rows.slice(0, limit);
        const alignmentRows = await this.alignmentsForEntityIds(params.tenantId, pageRows.map((row) => row.id));
        const byEntity = groupBy(alignmentRows, (row) => row.entityId);
        return {
            items: pageRows.map((row) => {
                const alignments = byEntity.get(row.id) ?? [];
                return {
                    id: row.id,
                    entityType: row.entityType,
                    canonicalName: row.canonicalName,
                    aliases: row.aliases ?? [],
                    confidence: row.confidence ?? 0,
                    metadata: row.metadata,
                    createdAt: iso(row.createdAt),
                    updatedAt: iso(row.updatedAt),
                    alignmentCount: alignments.length,
                    memoryKeys: [...new Set(alignments.map((alignment) => alignment.memoryKey))].slice(0, 50),
                };
            }),
            pageInfo: {
                ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
                hasMore: rows.length > limit,
                limit,
            },
        };
    }

    async probe(params: SemanticProbeParams): Promise<SemanticProbeResult> {
        this.assertMemoryAvailable();
        const limit = clampLimit(params.limit);
        const where = this.buildMemoryWhere({ tenantId: params.tenantId, key: params.pattern, tag: params.tag, limit }, undefined);
        const filterConditions = params.filters?.map(buildProbeFilterCondition) ?? [];
        if (filterConditions.length > 0) {
            const existingAnd = Array.isArray(where.AND) ? where.AND as Array<Record<string, unknown>> : [];
            where.AND = [...existingAnd, ...filterConditions];
        }
        const rows = await this.prisma!.agentMemoryStore!.findMany!({
            where,
            orderBy: [{ updatedAt: 'desc' }, { key: 'asc' }],
            take: limit,
        });
        let selectedRows = rows;
        if (params.random) {
            selectedRows = [...selectedRows].sort(() => Math.random() - 0.5);
        }
        const items = await this.decorateMemoryRows(params.tenantId, selectedRows);
        const resultKeys = items.map((item) => item.key);
        const rank = params.expectedKey ? resultKeys.indexOf(params.expectedKey) : -1;
        return {
            query: {
                ...(params.pattern ? { pattern: params.pattern } : {}),
                ...(params.tag ? { tag: params.tag } : {}),
                ...(params.filters ? { filters: params.filters } : {}),
                limit: params.limit,
                ...(params.random ? { random: true } : {}),
                ...(params.expectedKey ? { expectedKey: params.expectedKey } : {}),
            },
            resultKeys,
            items,
            ...(params.expectedKey ? { expected: { key: params.expectedKey, present: rank >= 0, ...(rank >= 0 ? { rank: rank + 1 } : {}) } } : {}),
            notes: ['Vector similarity search is not available in this operator probe.'],
        };
    }

    async retag(params: { tenantId: string; key: string; tags: string[] }): Promise<SemanticMemoryItem & { value: unknown }> {
        this.assertMemoryAvailable();
        await this.prisma!.agentMemoryStore!.update?.({
            where: { tenantId_key: { tenantId: params.tenantId, key: params.key } },
            data: { tags: normalizeTags(params.tags), updatedAt: new Date() },
        });
        const detail = await this.detail(params);
        if (!detail) throw new Error('Memory item not found after retag');
        return detail;
    }

    async update(params: { tenantId: string; key: string; nextKey?: string; value?: unknown }): Promise<SemanticMemoryItem & { value: unknown }> {
        this.assertMemoryAvailable();
        const nextKey = params.nextKey?.trim();
        const targetKey = nextKey && nextKey !== params.key ? nextKey : params.key;
        const data: Record<string, unknown> = { updatedAt: new Date() };
        if (targetKey !== params.key) data.key = targetKey;
        if (Object.prototype.hasOwnProperty.call(params, 'value')) data.value = params.value;
        if (targetKey !== params.key && typeof this.prisma?.entityAlignment?.updateMany === 'function') {
            if (typeof this.prisma.$transaction !== 'function') throw new Error('Transactional semantic memory updates are not available');
            await this.prisma.$transaction(async (tx) => {
                await tx.agentMemoryStore!.update!({
                    where: { tenantId_key: { tenantId: params.tenantId, key: params.key } },
                    data,
                });
                await tx.entityAlignment!.updateMany!({
                    where: { tenantId: params.tenantId, memoryKey: params.key },
                    data: { memoryKey: targetKey },
                });
            });
        } else {
            await this.prisma!.agentMemoryStore!.update?.({
                where: { tenantId_key: { tenantId: params.tenantId, key: params.key } },
                data,
            });
        }
        const detail = await this.detail({ tenantId: params.tenantId, key: targetKey });
        if (!detail) throw new Error('Memory item not found after update');
        return detail;
    }

    async delete(params: { tenantId: string; key: string }): Promise<{ deleted: true; key: string }> {
        this.assertMemoryAvailable();
        if (typeof this.prisma?.entityAlignment?.deleteMany === 'function') {
            if (typeof this.prisma.$transaction !== 'function') throw new Error('Transactional semantic memory deletes are not available');
            await this.prisma.$transaction(async (tx) => {
                await tx.entityAlignment!.deleteMany!({ where: { tenantId: params.tenantId, memoryKey: params.key } });
                await tx.agentMemoryStore!.delete!({ where: { tenantId_key: { tenantId: params.tenantId, key: params.key } } });
            });
        } else {
            await this.prisma!.agentMemoryStore!.delete?.({
                where: { tenantId_key: { tenantId: params.tenantId, key: params.key } },
            });
        }
        return { deleted: true, key: params.key };
    }

    private assertMemoryAvailable(): void {
        if (!this.isAvailable()) {
            throw new Error('Semantic memory store is not available');
        }
    }

    private buildMemoryWhere(params: SemanticMemoryListParams, entityKeys: string[] | undefined): Record<string, unknown> {
        const and: Array<Record<string, unknown>> = [];
        if (params.key) and.push({ key: { contains: params.key, mode: 'insensitive' } });
        if (entityKeys) and.push({ key: { in: entityKeys } });
        return {
            tenantId: params.tenantId,
            ...(params.tag ? { tags: { has: params.tag } } : {}),
            ...(params.hasBlob ? { blobData: { not: null } } : {}),
            ...(and.length > 0 ? { AND: and } : {}),
            ...createdAtRange(undefined, undefined, 'updatedAt', params.since, params.until),
        };
    }

    private async keysForEntityFilter(params: SemanticMemoryListParams): Promise<string[] | undefined> {
        if (!params.entity && !params.entityType && !params.hasAlignment) return undefined;
        const entityIds = params.entity || params.entityType
            ? await this.entityIdsForFilter(params)
            : undefined;
        if ((params.entity || params.entityType) && entityIds?.length === 0) return [];
        const alignments = await this.alignmentsForEntityIds(params.tenantId, entityIds);
        return [...new Set(alignments.map((row) => row.memoryKey))];
    }

    private async keysForActivityFilter(params: SemanticMemoryListParams): Promise<string[] | undefined> {
        if (!params.agentId && !params.taskId) return undefined;
        if (typeof this.prisma?.wMEvent?.findMany !== 'function') return [];
        const rows = await this.prisma.wMEvent.findMany({
            where: {
                tenantId: params.tenantId,
                type: { in: ['memory.read', 'memory.write', 'memory.delete'] },
                ...(params.taskId ? { sessionId: params.taskId } : {}),
            },
            orderBy: [{ createdAt: 'desc' }],
            take: 2000,
        });
        const keys = rows
            .map(toActivityItem)
            .filter((item): item is SemanticMemoryActivityItem => item !== undefined && (!params.agentId || item.agentId === params.agentId))
            .flatMap((item) => [...item.keys, ...item.resultKeys]);
        return [...new Set(keys)];
    }

    private async entityIdsForFilter(params: SemanticMemoryListParams): Promise<string[]> {
        if (typeof this.prisma?.entityStore?.findMany !== 'function') return [];
        const rows = await this.prisma.entityStore.findMany({
            where: {
                tenantId: params.tenantId,
                ...(params.entityType ? { entityType: params.entityType } : {}),
                ...(params.entity ? {
                    OR: [
                        { canonicalName: { contains: params.entity, mode: 'insensitive' } },
                        { aliases: { has: params.entity } },
                    ],
                } : {}),
            },
            take: 500,
        });
        return rows.map((row) => row.id);
    }

    private async decorateMemoryRows(tenantId: string, rows: MemoryRow[]): Promise<SemanticMemoryItem[]> {
        const keys = rows.map((row) => row.key);
        const [alignmentRows, activity] = await Promise.all([
            this.alignmentsForMemoryKeys(tenantId, keys),
            this.activityForKeys(tenantId, keys),
        ]);
        const alignmentsByKey = groupBy(alignmentRows, (row) => row.memoryKey);
        return rows.map((row) => {
            const alignments = alignmentsByKey.get(row.key) ?? [];
            const activitySummary = activity.get(row.key) ?? { reads: 0, writes: 0, deletes: 0 };
            const flags = flagsForMemory(row, alignments, activitySummary);
            return {
                key: row.key,
                valuePreview: previewValue(row.value),
                tags: row.tags ?? [],
                createdAt: iso(row.createdAt),
                updatedAt: iso(row.updatedAt),
                hasBlob: row.blobData !== null && row.blobData !== undefined,
                ...(row.blobMetadata !== null && row.blobMetadata !== undefined ? { blobMetadata: row.blobMetadata } : {}),
                alignmentCount: alignments.length,
                entities: alignments.map((alignment) => ({
                    entityId: alignment.entityId,
                    entityType: alignment.entity?.entityType,
                    canonicalName: alignment.entity?.canonicalName,
                    fieldPath: alignment.fieldPath,
                    originalValue: alignment.originalValue,
                    confidence: alignment.confidence,
                })),
                activity: activitySummary,
                flags,
            };
        });
    }

    private async alignmentsForMemoryKeys(tenantId: string, keys: string[]): Promise<AlignmentRow[]> {
        if (keys.length === 0 || typeof this.prisma?.entityAlignment?.findMany !== 'function') return [];
        return this.prisma.entityAlignment.findMany({
            where: { tenantId, memoryKey: { in: keys } },
            include: { entity: true },
            take: Math.max(500, keys.length * 20),
        });
    }

    private async alignmentsForEntityIds(tenantId: string, entityIds?: string[]): Promise<AlignmentRow[]> {
        if (typeof this.prisma?.entityAlignment?.findMany !== 'function') return [];
        return this.prisma.entityAlignment.findMany({
            where: {
                tenantId,
                ...(entityIds ? { entityId: { in: entityIds } } : {}),
            },
            include: { entity: true },
            take: 2000,
        });
    }

    private async activityForKeys(tenantId: string, keys: string[]): Promise<Map<string, SemanticMemoryItem['activity']>> {
        const result = new Map<string, SemanticMemoryItem['activity']>();
        if (keys.length === 0 || typeof this.prisma?.wMEvent?.findMany !== 'function') return result;
        const rows = await this.prisma.wMEvent.findMany({
            where: { tenantId, type: { in: ['memory.read', 'memory.write', 'memory.delete'] } },
            orderBy: [{ createdAt: 'desc' }],
            take: 2000,
        });
        const keySet = new Set(keys);
        for (const event of rows) {
            const item = toActivityItem(event);
            if (!item) continue;
            for (const key of [...item.keys, ...item.resultKeys]) {
                if (!keySet.has(key)) continue;
                const current = result.get(key) ?? { reads: 0, writes: 0, deletes: 0 };
                if (item.op === 'read') {
                    current.reads++;
                    current.lastReadAt = current.lastReadAt ?? item.timestamp;
                } else if (item.op === 'write') {
                    current.writes++;
                    current.lastWriteAt = current.lastWriteAt ?? item.timestamp;
                } else {
                    current.deletes++;
                    current.lastDeleteAt = current.lastDeleteAt ?? item.timestamp;
                }
                result.set(key, current);
            }
        }
        return result;
    }
}

function toActivityItem(event: WMEventRow): SemanticMemoryActivityItem | undefined {
    const op = event.type === 'memory.write' ? 'write' : event.type === 'memory.delete' ? 'delete' : event.type === 'memory.read' ? 'read' : undefined;
    if (!op) return undefined;
    const payload = event.payload ?? {};
    return {
        id: event.eventId,
        taskId: stringValue(payload.taskId) ?? event.sessionId,
        seq: event.seq,
        timestamp: iso(event.createdAt),
        op,
        keys: stringArray(payload.keys),
        keyCount: numberValue(payload.keyCount) ?? stringArray(payload.keys).length,
        resultKeys: stringArray(payload.resultKeys),
        ...(numberValue(payload.resultCount) !== undefined ? { resultCount: numberValue(payload.resultCount) } : {}),
        ...(payload.query !== undefined ? { query: payload.query } : {}),
        ...(stringValue(payload.status) ? { status: stringValue(payload.status) } : {}),
        ...(stringValue(payload.backend) ? { backend: stringValue(payload.backend) } : {}),
        ...(stringValue(payload.source) ? { source: stringValue(payload.source) } : {}),
        ...(numberValue(payload.turnSeq) !== undefined ? { turnSeq: numberValue(payload.turnSeq) } : {}),
        ...(stringValue(payload.agentId) ? { agentId: stringValue(payload.agentId) } : {}),
        ...(stringValue(payload.traceId) ? { traceId: stringValue(payload.traceId) } : {}),
        ...(stringValue(payload.spanId) ? { spanId: stringValue(payload.spanId) } : {}),
    };
}

function createdAtRange(since?: string, until?: string, field = 'createdAt', fieldSince = since, fieldUntil = until): Record<string, unknown> {
    const range: Record<string, Date> = {};
    if (fieldSince) range.gte = new Date(fieldSince);
    if (fieldUntil) range.lte = new Date(fieldUntil);
    return Object.keys(range).length > 0 ? { [field]: range } : {};
}

function previewValue(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return { type: 'array', length: value.length, preview: value.slice(0, 3) };
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 6);
    return Object.fromEntries(entries);
}

function flagsForMemory(row: MemoryRow, alignments: AlignmentRow[], activity: SemanticMemoryItem['activity']): string[] {
    const flags: string[] = [];
    if (!row.tags || row.tags.length === 0) flags.push('no-tags');
    if (row.blobData !== null && row.blobData !== undefined) flags.push('blob');
    if (alignments.length > 0) flags.push('aligned');
    if (activity.reads === 0) flags.push('never-read');
    return flags;
}

function summarizeItems(items: SemanticMemoryItem[]): SemanticMemoryPage['summary'] {
    return {
        totalOnPage: items.length,
        withBlob: items.filter((item) => item.hasBlob).length,
        withAlignment: items.filter((item) => item.alignmentCount > 0).length,
        noTags: items.filter((item) => item.tags.length === 0).length,
        recentlyRead: items.filter((item) => item.activity.lastReadAt).length,
        recentlyWritten: items.filter((item) => item.activity.lastWriteAt).length,
    };
}

function buildProbeFilterCondition(filter: { path: string; operator: string; value: unknown }): Record<string, unknown> {
    const path = filter.path.split('.');
    switch (filter.operator) {
        case '=':
            return { value: { path, equals: filter.value } };
        case '!=':
            return { NOT: { value: { path, equals: filter.value } } };
        case 'CONTAINS':
            return { value: { path, string_contains: String(filter.value ?? ''), mode: 'insensitive' } };
        case 'STARTS_WITH':
            return { value: { path, string_starts_with: String(filter.value ?? ''), mode: 'insensitive' } };
        case 'ENDS_WITH':
            return { value: { path, string_ends_with: String(filter.value ?? ''), mode: 'insensitive' } };
        default:
            throw new Error(`Unsupported probe filter operator: ${filter.operator}`);
    }
}

function intersectOptionalKeys(left: string[] | undefined, right: string[] | undefined): string[] | undefined {
    if (left === undefined) return right;
    if (right === undefined) return left;
    const rightSet = new Set(right);
    return left.filter((key) => rightSet.has(key));
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const item of items) {
        const key = keyFn(item);
        const existing = map.get(key) ?? [];
        existing.push(item);
        map.set(key, existing);
    }
    return map;
}

function normalizeTags(tags: string[]): string[] {
    return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function clampLimit(limit: number | undefined): number {
    return Math.max(1, Math.min(Number.isFinite(limit ?? NaN) ? limit! : 50, 200));
}

function decodeOffset(cursor: string | undefined): number {
    const parsed = Number.parseInt(cursor ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function iso(value: DateLike | undefined): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    return new Date(0).toISOString();
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

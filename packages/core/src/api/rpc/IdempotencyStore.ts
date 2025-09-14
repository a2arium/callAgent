type Key = string;

class TTLMap<V> {
    private store = new Map<Key, { value: V; expiresAt: number }>();
    constructor(private readonly ttlMs: number) { }
    get(key: Key): V | undefined {
        const e = this.store.get(key);
        if (!e) return undefined;
        if (Date.now() > e.expiresAt) {
            this.store.delete(key);
            return undefined;
        }
        return e.value;
    }
    set(key: Key, value: V): void {
        this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    }
}

export type IdempotencyResult = { jsonrpc: '2.0'; id: string | number | null; result: unknown };

const DEFAULT_TTL_MS = 10 * 60_000; // 10 minutes
const store = new TTLMap<IdempotencyResult>(DEFAULT_TTL_MS);

function buildKey(tenantId: string, taskId: string, token: string, idempotencyKey: string): string {
    return `${tenantId}::${taskId}::${token}::${idempotencyKey}`;
}

export function getIdempotent(tenantId: string, taskId: string, token: string, idempotencyKey?: string): IdempotencyResult | undefined {
    if (!idempotencyKey) return undefined;
    return store.get(buildKey(tenantId, taskId, token, idempotencyKey));
}

export function setIdempotent(tenantId: string, taskId: string, token: string, idempotencyKey: string, result: IdempotencyResult): void {
    store.set(buildKey(tenantId, taskId, token, idempotencyKey), result);
}



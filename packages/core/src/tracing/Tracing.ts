// Minimal W3C Trace Context helpers

function randomHex(bytes: number): string {
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function createTraceparent(): string {
    const version = '00';
    const traceId = randomHex(16);
    const spanId = randomHex(8);
    const flags = '01';
    return `${version}-${traceId}-${spanId}-${flags}`;
}

export function childTraceparent(parent: string | undefined): string {
    if (!parent) return createTraceparent();
    const parts = parent.split('-');
    if (parts.length !== 4) return createTraceparent();
    const version = parts[0] || '00';
    const traceId = parts[1] && parts[1].length === 32 ? parts[1] : randomHex(16);
    const spanId = randomHex(8);
    const flags = parts[3] || '01';
    return `${version}-${traceId}-${spanId}-${flags}`;
}

export function parseTraceparent(tp: string | undefined): { traceId?: string; spanId?: string; flags?: string } {
    if (!tp) return {};
    const parts = tp.split('-');
    if (parts.length !== 4) return {};
    return { traceId: parts[1], spanId: parts[2], flags: parts[3] };
}



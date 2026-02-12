import * as uuid from 'uuid';
const uuidv4 = uuid.v4;
import { EngineLocator } from './EngineLocator.js';
import type { SessionManager } from './SessionManager.js';
import { logger } from '@a2arium/callagent-utils';

const log = logger.createLogger({ prefix: 'Handles' });

type PendingInputs = Record<string, { handlerName?: string; expiredHandlerName?: string; schema?: unknown; expiresAt?: string }>;
type PendingTasks = Record<string, {
    target?: string;
    input?: unknown;
    handlers?: { completed?: string; failed?: string; inputRequired?: string };
    pendingInput?: { prompt: string; schema?: unknown };
    pendingCompletion?: unknown;
    deliveredInput?: boolean;
    deliveredCompletion?: boolean;
    options?: { setToken?: boolean; tokenPath?: string; autoClearToken?: boolean; setStage?: string };
}>;
type PendingGroups = Record<string, { childTokens: string[]; results: Record<string, unknown>; handlers?: { allCompleted?: string; anyFailed?: string }; cancelRemaining?: boolean; timeoutMs?: number }>;

function getPendingInputs(snapshot: Record<string, unknown>): PendingInputs {
    const pending = (snapshot as any).pending?.inputs || {};
    return { ...pending } as PendingInputs;
}

function setPendingInputs(snapshot: Record<string, unknown>, inputs: PendingInputs): Record<string, unknown> {
    const s: any = { ...snapshot };
    s.pending = { ...(s.pending || {}) };
    s.pending.inputs = inputs;
    return s as Record<string, unknown>;
}

export function getPendingTasks(snapshot: Record<string, unknown>): PendingTasks {
    const pending = (snapshot as any).pending?.tasks || {};
    return { ...pending } as PendingTasks;
}

export function setPendingTasks(snapshot: Record<string, unknown>, tasks: PendingTasks): Record<string, unknown> {
    const s: any = { ...snapshot };
    s.pending = { ...(s.pending || {}) };
    s.pending.tasks = tasks;
    return s as Record<string, unknown>;
}

export function getPendingGroups(snapshot: Record<string, unknown>): PendingGroups {
    const pending = (snapshot as any).pending?.groups || {};
    return { ...pending } as PendingGroups;
}

export function setPendingGroups(snapshot: Record<string, unknown>, groups: PendingGroups): Record<string, unknown> {
    const s: any = { ...snapshot };
    s.pending = { ...(s.pending || {}) };
    s.pending.groups = groups;
    return s as Record<string, unknown>;
}

export class InputHandle {
    constructor(
        private readonly session: SessionManager,
        private readonly tenantId: string,
        private readonly sessionId: string,
        public readonly token: string
    ) { }

    async onProvided(handlerName: string): Promise<this> {
        const snap = await this.session.load(this.tenantId, this.sessionId);
        const base = (snap?.snapshot as Record<string, unknown>) || {};
        const inputs = getPendingInputs(base);
        inputs[this.token] = { ...(inputs[this.token] || {}), handlerName };
        const next = setPendingInputs(base, inputs);
        const expected = snap?.wmVersion ?? BigInt(0);
        const parentAgentId = (snap as any)?.agentId || (base as any)?.meta?.agentId || 'default';
        await this.session.saveSnapshot({ tenantId: this.tenantId, sessionId: this.sessionId, agentId: parentAgentId, expectedWmVersion: expected, snapshot: next });
        return this;
    }

    async onExpired(handlerName: string): Promise<this> {
        const snap = await this.session.load(this.tenantId, this.sessionId);
        const base = (snap?.snapshot as Record<string, unknown>) || {};
        const inputs = getPendingInputs(base);
        inputs[this.token] = { ...(inputs[this.token] || {}), expiredHandlerName: handlerName };
        const next = setPendingInputs(base, inputs);
        const expected = snap?.wmVersion ?? BigInt(0);
        const parentAgentId = (snap as any)?.agentId || (base as any)?.meta?.agentId || 'default';
        await this.session.saveSnapshot({ tenantId: this.tenantId, sessionId: this.sessionId, agentId: parentAgentId, expectedWmVersion: expected, snapshot: next });
        return this;
    }
}

export class TaskHandle {
    constructor(
        private readonly session: SessionManager,
        private readonly tenantId: string,
        private readonly sessionId: string,
        private readonly childToken: string
    ) { }

    // Public getter for token to allow agents to access it
    get token(): string {
        return this.childToken;
    }

    // Dispatcher will be injected by the engine; fallback logic exists if missing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private dispatcher?: (opts?: { awaitCompletion?: boolean; streaming?: boolean }) => Promise<unknown | void>;

    // Allow engine to inject dispatcher without changing public API
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public __injectDispatcher(fn: (opts?: { awaitCompletion?: boolean; streaming?: boolean }) => Promise<unknown | void>): void {
        this.dispatcher = fn;
    }

    private async setHandler(kind: 'completed' | 'failed' | 'inputRequired', handlerName: string): Promise<this> {
        const snap = await this.session.load(this.tenantId, this.sessionId);
        const base = (snap?.snapshot as Record<string, unknown>) || {};
        const tasks = getPendingTasks(base);
        const existing = tasks[this.childToken] || { handlers: {} } as any;
        const pendingInput = (existing as any).pendingInput as { prompt: string; schema?: unknown } | undefined;
        const pendingCompletion = (existing as any).pendingCompletion as unknown;
        existing.handlers = existing.handlers || {};
        (existing.handlers as any)[kind] = handlerName;
        tasks[this.childToken] = existing;
        const next = setPendingTasks(base, tasks);
        const expected = snap?.wmVersion ?? BigInt(0);
        const parentAgentId = (snap as any)?.agentId || (base as any)?.meta?.agentId || 'default';
        await this.session.saveSnapshot({ tenantId: this.tenantId, sessionId: this.sessionId, agentId: parentAgentId, expectedWmVersion: expected, snapshot: next });
        // If an inputRequired handler is being set after a pending input was recorded, trigger routing now
        if (kind === 'inputRequired' && pendingInput) {
            try { log.debug('Routing pending input to newly registered handler', { handlerName, token: this.childToken }); } catch { }
            const engine = EngineLocator.getEngine();
            if (engine) {
                await engine.handleChildInputRequired({ tenantId: this.tenantId, parentTaskId: this.sessionId, childToken: this.childToken, prompt: pendingInput.prompt, schema: pendingInput.schema });
                try { log.info('Pending input routed to parent handler', { handlerName, token: this.childToken }); } catch { }
            } else {
                log.warn('TaskEngine not registered; unable to route pending input');
            }
        }
        // If a completed handler is set after a pending completion was recorded, deliver it now
        if (kind === 'completed' && typeof pendingCompletion !== 'undefined') {
            const engine = EngineLocator.getEngine();
            if (engine) {
                await engine.handleChildCompleted({ tenantId: this.tenantId, parentTaskId: this.sessionId, childToken: this.childToken, result: pendingCompletion });
            } else {
                console.warn('[Handles] TaskEngine not registered; unable to deliver pending completion');
            }
        }
        return this;
    }

    async onCompleted(handlerName: string): Promise<this> { return this.setHandler('completed', handlerName); }
    async onFailed(handlerName: string): Promise<this> { return this.setHandler('failed', handlerName); }
    async onInputRequired(handlerName: string): Promise<this> { return this.setHandler('inputRequired', handlerName); }

    async run(opts?: { awaitCompletion?: boolean; streaming?: boolean; cache?: { enabled?: boolean; ttlSeconds?: number; excludePaths?: string[] } }): Promise<unknown | void> {
        if (this.dispatcher) {
            return this.dispatcher(opts);
        }
        // Fallback dispatch path if engine did not inject a dispatcher
        const snap = await this.session.load(this.tenantId, this.sessionId);
        const base = (snap?.snapshot as Record<string, unknown>) || {};
        const tasks = getPendingTasks(base) as any;
        const entry = tasks[this.childToken];
        if (!entry || !entry.target) {
            return; // nothing to dispatch
        }
        const target = entry.target as string;
        const input = entry.input as unknown;
        // Determine await behavior: default to true if no completed handler registered
        const hasCompleted = !!entry.handlers?.completed;
        const awaitCompletion = opts?.awaitCompletion ?? (!hasCompleted);
        try {
            const { globalA2AService } = await import('./A2AService.js');
            const engine = EngineLocator.getEngine();
            const result = await globalA2AService.sendTaskToAgent({} as any, target, input as any, {
                parentTenantId: this.tenantId,
                parentTaskId: this.sessionId,
                parentChildToken: this.childToken,
                streaming: opts?.streaming === true,
                cache: opts?.cache
            } as any);
            if (awaitCompletion && engine) {
                await engine.handleChildCompleted({ tenantId: this.tenantId, parentTaskId: this.sessionId, childToken: this.childToken, result });
                return result;
            }
        } catch { /* swallow fallback errors */ }
        return;
    }
}

export async function createTaskHandle(
    session: SessionManager,
    tenantId: string,
    sessionId: string,
    target?: string,
    input?: unknown
): Promise<{ handle: TaskHandle; token: string }> {
    const childToken = uuidv4();
    let snap: any;
    let base: any;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        attempts++;
        snap = await session.load(tenantId, sessionId);
        base = (snap?.snapshot as Record<string, unknown>) || {};

        // Integrity Check
        const hasMeta = !!(base as any).meta;
        const hasM = !!(base as any).M;
        const expectedVer = snap?.wmVersion ?? BigInt(0);
        const isVersionZero = expectedVer === BigInt(0);

        // If valid or fresh, break loop
        if (hasMeta || hasM || isVersionZero) {
            break;
        }

        // If corrupted/missing but version > 0
        if (attempts < maxAttempts) {
            console.warn(`[Handles] createTaskHandle loaded empty/partial snapshot (attempt ${attempts}/${maxAttempts}). Retrying...`, { sessionId, version: expectedVer });
            await new Promise(resolve => setTimeout(resolve, 200 * attempts));
        }
    }

    // ✅ FIX: Verify snapshot integrity before writing!
    // Re-verify after loop
    const hasMeta = !!(base as any).meta;
    const hasM = !!(base as any).M;
    const expectedVer = snap?.wmVersion ?? BigInt(0);
    const isEstablished = expectedVer >= BigInt(3);

    // Only enforce strict integrity for established sessions (>= 3)
    // Allow early sessions to have minimal structure for initialization
    if (!hasMeta && !hasM && isEstablished) {
        console.error('CRITICAL: createTaskHandle attempted to update invalid/empty snapshot!', { sessionId, version: expectedVer });
        throw new Error('SNAPSHOT_INTEGRITY_CHECK_FAILED: Parent snapshot corrupt or missing.');
    }

    const tasks = getPendingTasks(base);
    tasks[childToken] = { target, input, handlers: {} } as any;
    const next = setPendingTasks(base, tasks);
    const expected = snap?.wmVersion ?? BigInt(0);
    const parentAgentId = (snap as any)?.agentId || (base as any)?.meta?.agentId || 'default';
    await session.saveSnapshot({ tenantId, sessionId, agentId: parentAgentId, expectedWmVersion: expected, snapshot: next });
    return { handle: new TaskHandle(session, tenantId, sessionId, childToken), token: childToken };
}


export class GroupHandle {
    constructor(
        private readonly session: SessionManager,
        private readonly tenantId: string,
        private readonly sessionId: string,
        private readonly groupToken: string
    ) { }

    private async setHandler(kind: 'allCompleted' | 'anyFailed', handlerName: string): Promise<this> {
        const snap = await this.session.load(this.tenantId, this.sessionId);
        const base = (snap?.snapshot as Record<string, unknown>) || {};
        const groups = getPendingGroups(base);
        const existing = groups[this.groupToken] || { childTokens: [], results: {}, handlers: {} };
        existing.handlers = existing.handlers || {};
        (existing.handlers as any)[kind] = handlerName;
        groups[this.groupToken] = existing;
        const next = setPendingGroups(base, groups);
        const expected = snap?.wmVersion ?? BigInt(0);
        const parentAgentId = (snap as any)?.agentId || (base as any)?.meta?.agentId || 'default';
        await this.session.saveSnapshot({ tenantId: this.tenantId, sessionId: this.sessionId, agentId: parentAgentId, expectedWmVersion: expected, snapshot: next });
        return this;
    }

    async onAllCompleted(handlerName: string): Promise<this> { return this.setHandler('allCompleted', handlerName); }
    async onAnyFailed(handlerName: string): Promise<this> { return this.setHandler('anyFailed', handlerName); }

    async cancelRemaining(cancel: boolean = true): Promise<this> {
        const snap = await this.session.load(this.tenantId, this.sessionId);
        const base = (snap?.snapshot as Record<string, unknown>) || {};
        const groups = getPendingGroups(base);
        const existing = groups[this.groupToken] || { childTokens: [], results: {}, handlers: {} };
        existing.cancelRemaining = cancel;
        groups[this.groupToken] = existing;
        const next = setPendingGroups(base, groups);
        const expected = snap?.wmVersion ?? BigInt(0);
        await this.session.saveSnapshot({ tenantId: this.tenantId, sessionId: this.sessionId, agentId: (base as any)?.meta?.agentId || 'default', expectedWmVersion: expected, snapshot: next });
        return this;
    }
}

export async function createGroupHandle(
    session: SessionManager,
    tenantId: string,
    sessionId: string,
    childTokens: string[]
): Promise<{ handle: GroupHandle; groupToken: string }> {
    const groupToken = uuidv4();
    const snap = await session.load(tenantId, sessionId);
    const base = (snap?.snapshot as Record<string, unknown>) || {};
    const groups = getPendingGroups(base);
    groups[groupToken] = { childTokens, results: {}, handlers: {} };
    const next = setPendingGroups(base, groups);
    const expected = snap?.wmVersion ?? BigInt(0);
    const parentAgentId2 = (snap as any)?.agentId || (base as any)?.meta?.agentId || 'default';
    await session.saveSnapshot({ tenantId, sessionId, agentId: parentAgentId2, expectedWmVersion: expected, snapshot: next });
    return { handle: new GroupHandle(session, tenantId, sessionId, groupToken), groupToken };
}



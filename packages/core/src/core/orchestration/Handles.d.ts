import type { SessionManager } from './SessionManager.js';
type PendingTasks = Record<string, {
    target?: string;
    input?: unknown;
    handlers?: {
        completed?: string;
        failed?: string;
        inputRequired?: string;
    };
    pendingInput?: {
        prompt: string;
        schema?: unknown;
    };
    pendingCompletion?: unknown;
    deliveredInput?: boolean;
    deliveredCompletion?: boolean;
}>;
type PendingGroups = Record<string, {
    childTokens: string[];
    results: Record<string, unknown>;
    handlers?: {
        allCompleted?: string;
        anyFailed?: string;
    };
    cancelRemaining?: boolean;
    timeoutMs?: number;
}>;
export declare function getPendingTasks(snapshot: Record<string, unknown>): PendingTasks;
export declare function setPendingTasks(snapshot: Record<string, unknown>, tasks: PendingTasks): Record<string, unknown>;
export declare function getPendingGroups(snapshot: Record<string, unknown>): PendingGroups;
export declare function setPendingGroups(snapshot: Record<string, unknown>, groups: PendingGroups): Record<string, unknown>;
export declare class InputHandle {
    private readonly session;
    private readonly tenantId;
    private readonly sessionId;
    private readonly token;
    constructor(session: SessionManager, tenantId: string, sessionId: string, token: string);
    onProvided(handlerName: string): Promise<this>;
    onExpired(handlerName: string): Promise<this>;
}
export declare class TaskHandle {
    private readonly session;
    private readonly tenantId;
    private readonly sessionId;
    private readonly childToken;
    constructor(session: SessionManager, tenantId: string, sessionId: string, childToken: string);
    private dispatcher?;
    __injectDispatcher(fn: (opts?: {
        awaitCompletion?: boolean;
        streaming?: boolean;
    }) => Promise<unknown | void>): void;
    private setHandler;
    onCompleted(handlerName: string): Promise<this>;
    onFailed(handlerName: string): Promise<this>;
    onInputRequired(handlerName: string): Promise<this>;
    run(opts?: {
        awaitCompletion?: boolean;
        streaming?: boolean;
    }): Promise<unknown | void>;
}
export declare function createTaskHandle(session: SessionManager, tenantId: string, sessionId: string, target?: string, input?: unknown): Promise<{
    handle: TaskHandle;
    token: string;
}>;
export declare class GroupHandle {
    private readonly session;
    private readonly tenantId;
    private readonly sessionId;
    private readonly groupToken;
    constructor(session: SessionManager, tenantId: string, sessionId: string, groupToken: string);
    private setHandler;
    onAllCompleted(handlerName: string): Promise<this>;
    onAnyFailed(handlerName: string): Promise<this>;
    cancelRemaining(cancel?: boolean): Promise<this>;
}
export declare function createGroupHandle(session: SessionManager, tenantId: string, sessionId: string, childTokens: string[]): Promise<{
    handle: GroupHandle;
    groupToken: string;
}>;
export {};

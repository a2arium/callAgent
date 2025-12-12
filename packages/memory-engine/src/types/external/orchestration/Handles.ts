// Stub for Handles.ts to satisfy type dependencies in memory-engine
// Removes dependencies on EngineLocator, SessionManager, A2AService

export class InputHandle {
    constructor(
        private readonly session: any,
        private readonly tenantId: string,
        private readonly sessionId: string,
        public readonly token: string
    ) { }

    async onProvided(handlerName: string): Promise<this> { return this; }
    async onExpired(handlerName: string): Promise<this> { return this; }
}

export class TaskHandle {
    constructor(
        private readonly session: any,
        private readonly tenantId: string,
        private readonly sessionId: string,
        private readonly childToken: string
    ) { }

    get token(): string { return this.childToken; }
    public __injectDispatcher(fn: any): void { }
    async onCompleted(handlerName: string): Promise<this> { return this; }
    async onFailed(handlerName: string): Promise<this> { return this; }
    async onInputRequired(handlerName: string): Promise<this> { return this; }
    async run(opts?: any): Promise<unknown | void> { return; }
}

export class GroupHandle {
    constructor(
        private readonly session: any,
        private readonly tenantId: string,
        private readonly sessionId: string,
        private readonly groupToken: string
    ) { }

    async onAllCompleted(handlerName: string): Promise<this> { return this; }
    async onAnyFailed(handlerName: string): Promise<this> { return this; }
    async cancelRemaining(cancel: boolean = true): Promise<this> { return this; }
}

export async function createTaskHandle(
    session: any,
    tenantId: string,
    sessionId: string,
    target?: string,
    input?: unknown
): Promise<{ handle: TaskHandle; token: string }> {
    return { handle: new TaskHandle(session, tenantId, sessionId, 'stub'), token: 'stub' };
}

export async function createGroupHandle(
    session: any,
    tenantId: string,
    sessionId: string,
    childTokens: string[]
): Promise<{ handle: GroupHandle; groupToken: string }> {
    return { handle: new GroupHandle(session, tenantId, sessionId, 'stub'), groupToken: 'stub' };
}

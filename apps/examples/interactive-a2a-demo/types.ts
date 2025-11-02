export type TextPart = { type: 'text'; text: string };

export type ChildCompletionInput = {
    kind: 'child';
    token: string;
    childTaskId?: string;
    result: unknown;
    agentId?: string;
};

export type OrchestratorEnv = {
    input?: ChildCompletionInput | Record<string, unknown>;
    sessionId?: string;
    turn?: number;
};

export type ProposedAction =
    | { kind: 'internal'; intent?: 'run'; done?: boolean }
    | { kind: 'language'; content: string };

export type ExecutableAction =
    | { kind: 'internal'; done?: boolean }
    | { kind: 'language'; echoed?: boolean };

export type OrchestratorVars = {
    done: boolean;
    analysis?: unknown;
    analysisOrigin?: string;
    workflow?: string;
    extract?: unknown;
};

export type OrchestratorMentalState = { vars: OrchestratorVars };

export type AgentCtx = {
    reply(parts: string | TextPart[] | TextPart): Promise<void>;
    vars: { set<T>(key: string, value: T): void };
    task: { id: string; input: unknown };
    sendTaskToAgent?: (
        agentId: string,
        input: unknown,
        options?: { awaitCompletion?: boolean; onInputRequired?: string }
    ) => Promise<unknown>;
    complete(pct?: number, status?: string): void;
};

// Extractor
export type ExtractorInput = { source: string; limit?: number };
export type ExtractorRow = { id: number; value: number };
export type ExtractorResult = ExtractorRow[];

// Analyzer
export type AnalyzerInput = { method: string };
export type AnalyzerResult = number;



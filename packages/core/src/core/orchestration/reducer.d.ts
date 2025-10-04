export type FlowEvent = {
    t: 'task.started';
} | {
    t: 'input.provided';
    token: string;
    input: unknown;
} | {
    t: 'child.completed';
    childTaskId: string;
    result: unknown;
} | {
    t: 'error';
    code: string;
    details?: unknown;
};
export type NextAction = {
    do: 'request_input';
    prompt: string;
    ttlMs?: number;
} | {
    do: 'spawn_child';
    agent: string;
    input: unknown;
} | {
    do: 'complete';
    output: unknown;
} | {
    do: 'none';
};
export declare function decide(workingState: Record<string, unknown>, ev: FlowEvent): {
    wm: Record<string, unknown>;
    action: NextAction;
};

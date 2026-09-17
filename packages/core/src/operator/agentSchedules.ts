import type { OperatorRequestContext } from './operatorAuth.js';

export type AgentScheduleKind = 'once' | 'cron';
export type AgentScheduleState = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'enabled' | 'paused' | 'degraded';

export type AgentSchedule = {
    id: string;
    providerId: string;
    revision: number;
    kind: AgentScheduleKind;
    displayName: string;
    agentId: string;
    agentAvailable: boolean;
    state: AgentScheduleState;
    createdAt: string;
    updatedAt: string;
    triggerAt?: string;
    cronExpression?: string;
    payloadKeys: string[];
    maxTurns?: number;
    cleanupRequired?: { providerIds: string[] };
};

export type AgentSchedulePayload = { scheduleId: string; input: unknown };
export type AgentScheduleListPage = { items: AgentSchedule[]; nextCursor?: string };

export type CreateAgentScheduleInput = {
    kind: AgentScheduleKind;
    displayName: string;
    agentId: string;
    input: unknown;
    triggerAt?: string;
    cronExpression?: string;
    maxTurns?: number;
};

export type ReplaceAgentCronInput = {
    expectedRevision: number;
    displayName: string;
    agentId: string;
    input: unknown;
    cronExpression: string;
    maxTurns?: number;
};

export type AgentScheduleQuery = {
    cursor?: string;
    limit?: number;
    agentId?: string;
    kind?: AgentScheduleKind;
    state?: string;
};

export interface AgentScheduleService {
    list(context: OperatorRequestContext, query?: AgentScheduleQuery): Promise<AgentScheduleListPage>;
    get(context: OperatorRequestContext, scheduleId: string): Promise<AgentSchedule>;
    getPayload(context: OperatorRequestContext, scheduleId: string): Promise<AgentSchedulePayload>;
    create(context: OperatorRequestContext, input: CreateAgentScheduleInput): Promise<AgentSchedule>;
    runNow(context: OperatorRequestContext, scheduleId: string): Promise<{ providerRunId: string }>;
    pause(context: OperatorRequestContext, scheduleId: string): Promise<AgentSchedule>;
    resume(context: OperatorRequestContext, scheduleId: string): Promise<AgentSchedule>;
    reschedule(context: OperatorRequestContext, scheduleId: string, triggerAt: string): Promise<AgentSchedule>;
    replaceCron(context: OperatorRequestContext, scheduleId: string, input: ReplaceAgentCronInput): Promise<AgentSchedule>;
    delete(context: OperatorRequestContext, scheduleId: string): Promise<{ deleted: true }>;
}

export type AgentScheduleErrorCode =
    | 'SCHEDULE_INVALID'
    | 'SCHEDULE_NOT_FOUND'
    | 'SCHEDULE_CONFLICT'
    | 'SCHEDULE_CORRUPT'
    | 'SCHEDULE_AGENT_UNAVAILABLE'
    | 'SCHEDULE_OPERATION_UNSUPPORTED'
    | 'SCHEDULE_REPLACEMENT_ROLLBACK_FAILED'
    | 'SCHEDULE_REPLACEMENT_STATE_UNKNOWN'
    | 'SCHEDULE_PROVIDER_UNAVAILABLE';

export class AgentScheduleError extends Error {
    constructor(readonly code: AgentScheduleErrorCode, message: string, readonly status: number, readonly details?: Record<string, unknown>) {
        super(`${code}: ${message}`);
        this.name = 'AgentScheduleError';
    }
}

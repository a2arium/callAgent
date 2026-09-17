
import { v7 as uuidv7 } from 'uuid';

export type NodeType = 'agent' | 'turn' | 'module' | 'tool' | 'llm' | 'workflow' | 'child';
export type NodeStatus = 'pending' | 'active' | 'success' | 'failure';

export interface PricingInfo {
    cost: number;
    currency: string;
}

export interface UsageInfo {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    custom?: Record<string, number>;
}

export abstract class TelemetryNode {
    public readonly id: string;
    public readonly parentId?: string;
    public readonly traceId?: string; // Root trace ID
    public readonly type: NodeType;
    public name?: string;
    public status: NodeStatus = 'pending';

    public startTime?: number;
    public endTime?: number;

    public input?: unknown;
    public output?: unknown;
    public error?: Error;

    public usage: UsageInfo = {};
    public pricing: PricingInfo = { cost: 0, currency: 'USD' };

    // For storing provider-specific handles (e.g. OpenTelemetry Span)
    public readonly providerData: Record<string, unknown> = {};

    constructor(type: NodeType, parentId?: string, id?: string, traceId?: string) {
        this.id = id || uuidv7();
        this.parentId = parentId;
        this.traceId = traceId;
        this.type = type;
    }

    start(input?: unknown): void {
        this.startTime = Date.now();
        this.status = 'active';
        this.input = input;
    }

    end(output?: unknown, status: NodeStatus = 'success'): void {
        this.endTime = Date.now();
        this.output = output;
        this.status = status;
    }

    fail(error: Error): void {
        this.endTime = Date.now();
        this.error = error;
        this.status = 'failure';
    }

    addUsage(usage: UsageInfo, cost?: number): void {
        this.usage.inputTokens = (this.usage.inputTokens || 0) + (usage.inputTokens || 0);
        this.usage.outputTokens = (this.usage.outputTokens || 0) + (usage.outputTokens || 0);
        this.usage.totalTokens = (this.usage.totalTokens || 0) + (usage.totalTokens || 0);

        if (cost) {
            this.pricing.cost += cost;
        }
    }
}

import type { TelemetryProvider } from '../Provider.js';
import { TelemetryNode } from '../nodes/TelemetryNode.js';
import { logger } from '@a2arium/callagent-utils';
import { AgentNode } from '../nodes/AgentNode.js';
import { TurnNode } from '../nodes/TurnNode.js';
import { ToolNode } from '../nodes/ToolNode.js';
import { LLMNode } from '../nodes/LLMNode.js';
import { ChildCallNode } from '../nodes/ChildCallNode.js';
import type { TurnTrace } from '../../types/turnTrace.js';
import { v7 as uuidv7 } from 'uuid';

type OpikTracePayload = {
    id: string;
    name: string;
    metadata?: Record<string, unknown>;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    startTime?: Date;
    endTime?: Date;
};

type OpikSpanPayload = {
    id: string;
    name: string;
    type: 'general' | 'tool' | 'llm' | 'child';
    startTime: Date;
    endTime: Date;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    parentSpanId?: string;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    totalEstimatedCost?: number;
    model?: string;
    provider?: string;
};

type OpikTrace = {
    span(payload: OpikSpanPayload): OpikSpan;
    update(payload: Partial<OpikTracePayload>): void;
    end(): void;
};

type OpikSpan = {
    end(): void;
};

type OpikClient = {
    trace(payload: OpikTracePayload): OpikTrace;
};

export class OpikProvider implements TelemetryProvider {
    public readonly name = 'opik';
    private enabled = false;
    private client: OpikClient | undefined;

    private traces = new Map<string, OpikTrace>();
    private traceIdToTrace = new Map<string, OpikTrace>();
    private nodeToOpikId = new Map<string, string>();
    private currentTurnNode: TurnNode | null = null;

    constructor() {
        this.init().catch((err) =>
            logger.warn('Opik initialization failed', { error: err })
        );
    }

    private async init(): Promise<void> {
        if (
            process.env.CALLAGENT_OPIK_ENABLED !== 'true' &&
            !process.env.OPIK_API_KEY
        ) {
            return;
        }
        try {
            const opikModule = await import('opik');
            const OpikClientClass = opikModule.Opik as new () => OpikClient;
            this.client = new OpikClientClass();
            this.enabled = true;
            logger.info('Opik provider initialized');
        } catch {
            logger.debug('Opik SDK not found, skipping Opik provider');
        }
    }

    onNodeStart(node: TelemetryNode): void {
        if (!this.enabled || !this.client) return;
        try {
            if (node instanceof AgentNode) {
                this.startTrace(node);
            } else if (node instanceof TurnNode) {
                this.currentTurnNode = node;
            }
        } catch (error) {
            logger.error('Opik onNodeStart error', { error, nodeId: node.id });
        }
    }

    onNodeEnd(node: TelemetryNode): void {
        if (!this.enabled || !this.client) return;
        try {
            if (node instanceof AgentNode) {
                this.endTrace(node);
            } else if (node instanceof TurnNode) {
                this.currentTurnNode = null;
            } else {
                this.endSpan(node);
            }
        } catch (error) {
            logger.error('Opik onNodeEnd error', { error, nodeId: node.id });
        }
    }

    onTurnTrace(trace: TurnTrace): void {
        if (!this.enabled || !this.client || !this.currentTurnNode) return;
        try {
            const traceId = trace.traceId;
            const opikTrace = traceId
                ? this.traceIdToTrace.get(traceId)
                : undefined;
            if (!opikTrace) return;

            const turnNode = this.currentTurnNode;
            const startTime = turnNode.startTime
                ? new Date(turnNode.startTime)
                : new Date();
            const endTime = turnNode.endTime
                ? new Date(turnNode.endTime)
                : new Date();

            const spanPayload: OpikSpanPayload = {
                id: this.getOpikId(turnNode.id),
                name: `Turn ${trace.turn}`,
                type: 'general',
                startTime,
                endTime,
                input: { inboxSummary: trace.inboxCurrent },
                output: {
                    transition: trace.transition?.kind,
                    intent: trace.intent?.kind,
                },
                metadata: {
                    nodeId: turnNode.id,
                    nodeType: 'turn',
                    turn: trace.turn,
                    turnId: trace.turnId,
                    stageBefore: trace.stageBefore,
                    stageAfter: trace.stageAfter,
                    timings: trace.timings,
                    usage: trace.usage,
                    intent: trace.intent,
                    shield: trace.shield,
                    pendingAfter: trace.pendingAfter,
                },
            };
            const span = opikTrace.span(spanPayload);
            span.end();
            this.currentTurnNode = null;
        } catch (error) {
            logger.error('Opik onTurnTrace error', { error });
        }
    }

    onNodeFailure(node: TelemetryNode, error: Error): void {
        if (!this.enabled || !this.client) return;
        try {
            const span = this.traces.get(node.id);
            if (span) {
                span.update({
                    output: { error: error.message, stack: error.stack },
                });
            }
        } catch (err) {
            logger.warn('Opik onNodeFailure error', { error: err });
        }
    }

    onUsageUpdate(_node: TelemetryNode): void {
        // Usage is finalized on end for Opik
    }

    private safeInput(input: unknown): Record<string, unknown> | undefined {
        if (input === undefined || input === null) return undefined;
        return typeof input === 'object' ? (input as Record<string, unknown>) : { value: input };
    }

    private safeOutput(output: unknown): Record<string, unknown> | undefined {
        if (output === undefined || output === null) return undefined;
        return typeof output === 'object' ? (output as Record<string, unknown>) : { value: output };
    }

    private getOpikId(nodeId: string): string {
        const existing = this.nodeToOpikId.get(nodeId);
        if (existing) return existing;
        const opikId = uuidv7();
        this.nodeToOpikId.set(nodeId, opikId);
        return opikId;
    }

    private startTrace(node: AgentNode): void {
        const trace = this.client!.trace({
            id: this.getOpikId(node.id),
            name: `agent:${node.agentName}`,
            metadata: { agentId: node.id, ...node.providerData },
            input: this.safeInput(node.input),
        });
        this.traces.set(node.id, trace);
        if (node.traceId) {
            this.traceIdToTrace.set(node.traceId, trace);
        }
    }

    private endTrace(node: AgentNode): void {
        const trace = this.traces.get(node.id);
        if (!trace) return;
        trace.update({
            output: this.safeOutput(node.output),
            endTime: new Date(),
            metadata: {
                status: node.status,
                cost: node.pricing?.cost,
                tokens: node.usage?.totalTokens,
            },
        });
        trace.end();
        this.traces.delete(node.id);
        if (node.traceId) {
            this.traceIdToTrace.delete(node.traceId);
        }
    }

    private endSpan(node: TelemetryNode): void {
        const parentId = node.parentId;
        const traceId = node.traceId;
        const trace = traceId ? this.traceIdToTrace.get(traceId) : undefined;

        if (!trace) {
            if (traceId) {
                logger.warn('OpikProvider: Could not find trace for node', {
                    nodeId: node.id,
                    traceId,
                });
            }
            return;
        }

        const spanType = this.getOpikSpanType(node);
        const name = this.getSpanName(node);
        const endTime = node.endTime ? new Date(node.endTime) : new Date();
        const startTime = node.startTime ? new Date(node.startTime) : new Date();

        const spanPayload: OpikSpanPayload = {
            id: this.getOpikId(node.id),
            name,
            type: spanType,
            startTime,
            endTime,
            input: this.safeInput(node.input),
            output: this.safeOutput(node.output),
            metadata: { nodeId: node.id, nodeType: node.type },
        };

        if (parentId) {
            spanPayload.parentSpanId = this.getOpikId(parentId);
        }

        if (node instanceof LLMNode) {
            spanPayload.usage = {
                prompt_tokens: node.usage?.inputTokens,
                completion_tokens: node.usage?.outputTokens,
                total_tokens: node.usage?.totalTokens,
            };
            if (node.pricing?.cost) {
                spanPayload.totalEstimatedCost = node.pricing.cost;
            }
            spanPayload.model = node.model;
            spanPayload.provider = (node.providerData?.provider as string) ?? undefined;
        }

        const span = trace.span(spanPayload);
        span.end();
    }

    private getOpikSpanType(
        node: TelemetryNode
    ): 'general' | 'tool' | 'llm' | 'child' {
        if (node instanceof LLMNode) return 'llm';
        if (node instanceof ToolNode) return 'tool';
        if (node instanceof ChildCallNode) return 'child';
        return 'general';
    }

    private getSpanName(node: TelemetryNode): string {
        if (node.name) return node.name;
        if (node instanceof TurnNode) return `Turn ${node.turnIndex}`;
        if (node instanceof ToolNode) return `Tool: ${node.toolName}`;
        if (node instanceof LLMNode) {
            const provider =
                (node.providerData?.provider as string)?.toLowerCase() ?? 'llm';
            return `${provider}.chat.completions`;
        }
        if (node instanceof ChildCallNode) {
            return `Child: ${node.childToken}`;
        }
        return node.type;
    }
}

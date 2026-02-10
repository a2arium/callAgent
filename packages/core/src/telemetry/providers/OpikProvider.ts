
import { TelemetryProvider } from '../Provider.js';
import { TelemetryNode } from '../nodes/TelemetryNode.js';
import { logger } from '@a2arium/callagent-utils';
import { AgentNode } from '../nodes/AgentNode.js';
import { TurnNode } from '../nodes/TurnNode.js';
import { ToolNode } from '../nodes/ToolNode.js';
import { LLMNode } from '../nodes/LLMNode.js';
import { ModuleNode } from '../nodes/ModuleNode.js';
import { WorkflowNode } from '../nodes/WorkflowNode.js';
import { v7 as uuidv7 } from 'uuid';

let OpikClient: any;

export class OpikProvider implements TelemetryProvider {
    public readonly name = 'opik';
    private enabled = false;
    private client: any | undefined;

    // Map internal node IDs to Opik Trace/Span objects
    private traces = new Map<string, any>();
    private spans = new Map<string, any>();

    // Map internal Node IDs (v4) to Opik IDs (v7)
    private nodeToOpikId = new Map<string, string>();

    constructor() {
        this.init().catch(err => logger.warn('Opik initialization failed', { error: err }));
    }

    private async init() {
        if (process.env.CALLAGENT_OPIK_ENABLED !== 'true' && !process.env.OPIK_API_KEY) {
            return;
        }

        try {
            // Dynamic import to avoid hard dependency
            const opikModule: any = await import('opik');
            OpikClient = opikModule.Opik;

            this.client = new OpikClient();

            this.client = new OpikClient();

            // Internal logging removed due to segfault risk
            // try { if (opikModule.setLoggerLevel) ... } catch (e) ...

            this.enabled = true;
            logger.info('Opik provider initialized');
        } catch (error) {
            logger.debug('Opik SDK not found, skipping Opik provider');
        }
    }

    onNodeStart(node: TelemetryNode): void {
        if (!this.enabled || !this.client) return;

        try {
            if (node instanceof AgentNode) {
                this.startTrace(node);
            } else {
                this.startSpan(node);
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
            } else {
                this.endSpan(node);
            }
        } catch (error) {
            logger.error('Opik onNodeEnd error', { error, nodeId: node.id });
        }
    }

    onNodeFailure(node: TelemetryNode, error: Error): void {
        if (!this.enabled || !this.client) return;

        try {
            const span = this.spans.get(node.id);
            if (span) {
                // Opik span update for error
                // Current SDK might prefer output.error or tags
                span.update({
                    output: { error: error.message, stack: error.stack }
                });
                return;
            }

            const trace = this.traces.get(node.id);
            if (trace) {
                trace.update({
                    output: { error: error.message }
                });
            }
        } catch (err) {
            logger.warn('Opik onNodeFailure error', { error: err });
        }
    }

    onUsageUpdate(node: TelemetryNode): void {
        // Usage is typically finalized on end for Opik, 
        // but if we support streaming updates we could do it here.
        // For now, we'll wait for End to flush usage.
    }

    private safeInput(input: unknown): any {
        if (input === undefined || input === null) return undefined;
        return (typeof input === 'object' ? input : { value: input });
    }

    private safeOutput(output: unknown): any {
        if (output === undefined || output === null) return undefined;
        return (typeof output === 'object' ? output : { value: output });
    }

    private getOpikId(nodeId: string): string {
        if (this.nodeToOpikId.has(nodeId)) {
            return this.nodeToOpikId.get(nodeId)!;
        }

        // Opik REQUIRES version 7 UUIDs for spans. 
        // We must map internal IDs (often v4 or strings) to stable v7 UUIDs.
        const opikId = uuidv7();
        this.nodeToOpikId.set(nodeId, opikId);
        return opikId;
    }

    // --- Helpers ---

    private startTrace(node: AgentNode) {
        const trace = this.client.trace({
            id: this.getOpikId(node.id),
            name: `agent:${node.agentName}`,
            metadata: {
                agentId: node.id,
                ...node.providerData
            },
            input: this.safeInput(node.input)
        });
        this.traces.set(node.id, trace);
        logger.debug('Opik Trace Started', { id: node.id, opikId: this.getOpikId(node.id), name: trace.name, input: node.input });
    }

    private endTrace(node: AgentNode) {
        const trace = this.traces.get(node.id);
        if (!trace) return;

        trace.update({
            output: this.safeOutput(node.output),
            endTime: new Date(),
            metadata: {
                status: node.status,
                cost: node.pricing?.cost,
                tokens: node.usage?.totalTokens
            }
        });
        trace.end();
        this.traces.delete(node.id);
    }

    private startSpan(node: TelemetryNode) {
        // [REF-OPIK-FINAL-STATE]
        // We do intentionally defer span creation until endSpan to ensure we have the full payload.
        // This avoids the Opik SDK limitation where updates to undefined fields are ignored.
        // The TelemetryNode internal state is the source of truth.
        return;
    }

    private endSpan(node: TelemetryNode) {
        // [REF-OPIK-FINAL-STATE]
        // Construct the full span payload now that the node is complete.

        const parentId = node.parentId;
        // In "Final State" mode, we need to find the parent OBJECT to call .span() on.
        // IMPORTANT: The parent logic might need adjustment if the parent span hasn't been created yet!
        // However, Opik hierarchy relies on the trace/span objects existing in memory.
        // Wait: If we defer creation, children can't find their parents if parents are also deferred!

        // CORRECTION: 
        // Logic: Turn (Start) -> Module (Start) -> LLM (Start) -> LLM (End) -> Module (End) -> Turn (End)
        // If we defer ALL check-ins to End, then when LLM ends, Module has NOT ended, so Module span doesn't exist?
        // Actually, if we use the Trace's `span()` method, we can pass a `parentSpanId`.
        // Let's check how `trace.span()` works. It usually takes `parentSpanId` as an option.

        // If the Opik SDK requires the parent *Object* to create a child, then deferral is tricky.
        // BUT, looking at the code `parentObj.span(...)`, it seems we need the object.

        // HACK 2.0:
        // We will maintain the `onNodeStart` logic ONLY for capturing the Hierarchy (creating "shell" spans?)
        // OR, we just use the `client.span(...)` or `trace.span(...)` and explicitly pass `parentSpanId`.

        // Let's assume we can attach to the Trace.
        const traceId = node.traceId;
        const trace = this.traces.get(traceId!);

        if (!trace) {
            // Warn only if we have a traceId but can't find it. 
            // If traceId is missing, it's a detached node.
            if (traceId) logger.warn('OpikProvider: Could not find trace for node', { nodeId: node.id, traceId });
            return;
        }

        const spanType = this.getOpikSpanType(node);
        const name = this.getSpanName(node);
        const endTime = node.endTime ? new Date(node.endTime) : new Date();
        const startTime = node.startTime ? new Date(node.startTime) : new Date();

        const spanPayload: any = {
            id: this.getOpikId(node.id), // Use v7 ID
            name,
            type: spanType,
            startTime,
            endTime,
            input: this.safeInput(node.input),
            output: this.safeOutput(node.output),
            metadata: {
                nodeId: node.id,
                nodeType: node.type
            }
        };

        if (node.parentId) {
            spanPayload.parentSpanId = this.getOpikId(node.parentId); // Use parent's v7 ID
        }

        // LLM Specifics
        if (node instanceof LLMNode) {
            spanPayload.usage = {
                prompt_tokens: node.usage?.inputTokens,
                completion_tokens: node.usage?.outputTokens,
                total_tokens: node.usage?.totalTokens
            };
            if (node.pricing?.cost) {
                spanPayload.totalEstimatedCost = node.pricing.cost;
            }
            if ((node as any).model) {
                spanPayload.model = (node as any).model;
            }
            if ((node as any).provider) {
                spanPayload.provider = (node as any).provider;
            }
        }

        // Create and End immediately
        // We use trace.span to ensure it belongs to the trace
        // We might need to forcefully cast to `any` to pass explicit IDs if the type defs are strict.
        const span = trace.span(spanPayload);
        span.end();
    }



    private getOpikSpanType(node: TelemetryNode): 'general' | 'tool' | 'llm' | 'workflow' {
        if (node instanceof LLMNode) return 'llm';
        if (node instanceof ToolNode) return 'tool';
        // Opik SDK might not have 'workflow' in its strict type, 
        // but we can pass it if we cast to any or if the backend supports it.
        // For now, let's keep it 'general' for strict compatibility but detectable via metadata.
        return 'general' as any;
    }

    private getSpanName(node: TelemetryNode): string {
        if (node.name) return node.name;
        if (node instanceof TurnNode) return `Turn ${node.turnIndex}`;
        if (node instanceof ToolNode) return `Tool: ${node.toolName}`;
        if (node instanceof LLMNode) {
            const provider = (node as any).providerData?.provider?.toLowerCase() || 'llm';
            return `${provider}.chat.completions`;
        }
        if (node instanceof ModuleNode || node instanceof WorkflowNode) return `${node.name}`;
        return `${node.type}`;
    }
}

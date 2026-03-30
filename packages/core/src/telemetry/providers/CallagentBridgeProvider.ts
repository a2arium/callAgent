/**
 * CallagentBridgeProvider: Bridges callLLM telemetry events into callagent's telemetry system.
 * 
 * This provider implements callLLM's TelemetryProvider interface and converts
 * callLLM events (startLLM, endLLM, startTool, endTool, etc.) into callagent
 * telemetry nodes (LLMNode, ToolNode), allowing rich LLM telemetry data to
 * flow into callagent's trace hierarchy.
 * 
 * Usage:
 *   const bridge = CallagentBridgeProvider.create(parentModuleId);
 *   const caller = new LLMCaller(provider, model, systemPrompt, {
 *     telemetryCollector: bridge.getCollector()
 *   });
 */

import { telemetry } from '../TelemetryCollector.js';
import { LLMNode } from '../nodes/LLMNode.js';
import { ToolNode } from '../nodes/ToolNode.js';
import { WorkflowNode } from '../nodes/WorkflowNode.js';
import { TelemetryNode } from '../nodes/TelemetryNode.js';
import type { InternalTaskContext } from '../../loop/internalContext.js';
import type {
    TelemetryProvider as CallLLMTelemetryProvider,
    ProviderInit,
    ConversationContext,
    ConversationSummary,
    ConversationInputOutput,
    LLMCallContext,
    ToolCallContext,
    PromptMessage,
    ChoiceEvent,
    Usage
} from 'callllm';

/** Minimal usage shape we read from callllm (avoids any). */
type UsageLike = {
    tokens?: {
        input?: number | { total?: number };
        output?: number | { total?: number };
        total?: number;
    };
    costs?: { total?: number; currency?: string };
};

function tokensIn(u: UsageLike | undefined): number {
    if (!u?.tokens) return 0;
    const i = u.tokens.input;
    return typeof i === 'number' ? i : (i?.total ?? 0);
}

function tokensOut(u: UsageLike | undefined): number {
    if (!u?.tokens) return 0;
    const o = u.tokens.output;
    return typeof o === 'number' ? o : (o?.total ?? 0);
}

function tokensTotal(u: UsageLike | undefined, inVal: number, outVal: number): number {
    if (u?.tokens && typeof u.tokens.total === 'number') return u.tokens.total;
    return inVal + outVal;
}

/** Follow parent chain until a node carries traceId (callllm children often only get parent id). */
function resolveTraceIdFromParentId(parentId: string): string | undefined {
    let pid: string | undefined = parentId;
    const seen = new Set<string>();
    while (pid && pid !== 'root' && !seen.has(pid)) {
        seen.add(pid);
        const p = telemetry.getNode(pid);
        if (p?.traceId) return p.traceId;
        pid = p?.parentId;
    }
    return undefined;
}

/**
 * Bridge provider that converts callLLM telemetry events into callagent telemetry nodes.
 */
export class CallagentBridgeProvider implements CallLLMTelemetryProvider {
    name = 'callagent-bridge';

    private parentNodeId: string;
    /** Optional ref to current task context for __currentModule and __turnLlmCalls/__turnToolCalls. */
    private contextRef: InternalTaskContext | null = null;
    private llmNodes: Map<string, LLMNode> = new Map();
    private toolNodes: Map<string, ToolNode> = new Map();
    private llmPrompts: Map<string, PromptMessage[]> = new Map();
    private llmChoices: Map<string, ChoiceEvent[]> = new Map();
    private conversationNodes: Map<string, WorkflowNode> = new Map();

    // Track the active node stack per conversation for automatic nesting
    private nodeStack: Map<string, string[]> = new Map();

    constructor(parentNodeId: string) {
        this.parentNodeId = parentNodeId;
    }

    /**
     * Set the current task context so the bridge can stamp module and accumulate turn summaries.
     * Call before LLM/tool calls (e.g. when setting parent node id).
     */
    setContextRef(ctx: InternalTaskContext | null): void {
        this.contextRef = ctx;
    }

    async init(_config: ProviderInit): Promise<void> {

        // Nothing to initialize
    }

    private getActiveParent(conversationId: string, nodeType?: 'llm' | 'tool'): string {
        const stack = this.nodeStack.get(conversationId);
        if (stack && stack.length > 0) {
            if (nodeType === 'tool') {
                // For tools, skip any sibling tool nodes to find the LLM or Agent node
                for (let i = stack.length - 1; i >= 0; i--) {
                    const nodeId = stack[i];
                    // Special case: if we found an LLM node or the conversation node, that's our parent
                    if (this.llmNodes.has(nodeId) || this.conversationNodes.has(nodeId) || nodeId === this.parentNodeId) {
                        return nodeId;
                    }
                    // Also check if it's the root parent
                    if (nodeId === this.parentNodeId) return nodeId;
                }
            }
            return stack[stack.length - 1];
        }
        return this.parentNodeId;
    }

    private pushNode(conversationId: string, nodeId: string): void {
        let stack = this.nodeStack.get(conversationId);
        if (!stack) {
            stack = [];
            this.nodeStack.set(conversationId, stack);
        }
        stack.push(nodeId);
    }

    private popNode(conversationId: string, nodeId: string): void {
        const stack = this.nodeStack.get(conversationId);
        if (stack) {
            const index = stack.lastIndexOf(nodeId);
            if (index !== -1) {
                stack.splice(index, 1);
            }
        }
    }

    startConversation(ctx: ConversationContext): void {
        // Initialize stack for this conversation
        this.nodeStack.set(ctx.conversationId, []);

        const parentId = this.parentNodeId;
        const parentNode = telemetry.getNode(parentId);
        const traceId = this.resolveBridgeTraceId(parentId, parentNode);

        const node = new WorkflowNode(`llm.conversation.${ctx.type}`, parentId, ctx.conversationId, traceId);
        node.startTime = ctx.startedAt;
        node.status = 'active';

        this.conversationNodes.set(ctx.conversationId, node);
        this.pushNode(ctx.conversationId, node.id);
        telemetry.registerNode(node);
    }

    endConversation(ctx: ConversationContext, summary?: ConversationSummary, inputOutput?: ConversationInputOutput): void {
        const node = this.conversationNodes.get(ctx.conversationId);

        if (node) {
            node.endTime = Date.now();
            node.status = 'success';
            node.output = { summary, ...inputOutput };
            telemetry.endNode(node);
            this.popNode(ctx.conversationId, node.id);
            this.conversationNodes.delete(ctx.conversationId);
        }

        // Cleanup stack map (do not endNode pending LLM/tool nodes here — that races endLLM and clears span content in Opik)
        this.nodeStack.delete(ctx.conversationId);
    }

    startLLM(ctx: LLMCallContext): void {
        // Pop any lingering LLM node from a previous interaction in this turn
        const stack = this.nodeStack.get(ctx.conversationId);
        if (stack && stack.length > 0) {
            const topId = stack[stack.length - 1];
            if (this.llmNodes.has(topId)) {
                this.popNode(ctx.conversationId, topId);
            }
        }

        let parentId = this.getActiveParent(ctx.conversationId, 'llm');
        const stackParent = telemetry.getNode(parentId);
        // 3.5: nest LLM under the active turn (parentNodeId), not under callllm's conversation span
        if (stackParent?.type === 'workflow') {
            parentId = this.parentNodeId;
        }
        const parentNode = telemetry.getNode(parentId);
        const traceId = this.resolveBridgeTraceId(parentId, parentNode);

        const node = new LLMNode(ctx.model, parentId, ctx.llmCallId, traceId);
        node.name = `${ctx.provider.toLowerCase()}.chat.completions`;
        node.startTime = ctx.startedAt;
        node.status = 'active';
        if (this.contextRef?.__currentModule) {
            node.module = this.contextRef.__currentModule;
        }

        Object.assign(node.providerData, {
            provider: ctx.provider,
            model: ctx.model,
            streaming: ctx.streaming,
            responseFormat: ctx.responseFormat,
            toolsEnabled: ctx.toolsEnabled,
            toolsAvailable: ctx.toolsAvailable
        });

        this.llmNodes.set(ctx.llmCallId, node);
        this.llmPrompts.set(ctx.llmCallId, []);
        this.llmChoices.set(ctx.llmCallId, []);

        this.pushNode(ctx.conversationId, node.id);
        telemetry.registerNode(node);
    }

    addPrompt(ctx: LLMCallContext, messages: PromptMessage[]): void {

        const prompts = this.llmPrompts.get(ctx.llmCallId);
        if (prompts) {
            prompts.push(...messages);
        }
    }

    addChoice(ctx: LLMCallContext, choice: ChoiceEvent): void {

        const choices = this.llmChoices.get(ctx.llmCallId);
        if (choices) {
            choices.push(choice);
        }
    }

    endLLM(ctx: LLMCallContext, usage?: Usage, responseModel?: string): void {
        const node = this.llmNodes.get(ctx.llmCallId);
        if (!node) return;

        const now = Date.now();
        node.endTime = now;
        node.status = 'success';

        // Populate input/output
        const prompts = this.llmPrompts.get(ctx.llmCallId) || [];
        node.input = {
            messages: prompts.map(p => ({ role: p.role, content: p.content }))
        };

        const choices = this.llmChoices.get(ctx.llmCallId) || [];
        const finalContent = choices.map(c => c.content).join('');
        const toolCalls = choices.flatMap(c => c.toolCalls || []);
        node.output = {
            content: finalContent,
            finishReason: choices[choices.length - 1]?.finishReason,
            toolCalls
        };

        // Populate usage and pricing
        const u = usage as UsageLike | undefined;
        if (u) {
            const inVal = tokensIn(u);
            const outVal = tokensOut(u);
            const total = tokensTotal(u, inVal, outVal);
            const cost = u.costs?.total ?? 0;

            node.usage = {
                inputTokens: inVal,
                outputTokens: outVal,
                totalTokens: total
            };

            if (cost) {
                node.pricing = { cost, currency: u.costs?.currency ?? 'USD' };
            }
        }

        // Accumulate into turn trace
        const ictx = this.contextRef;
        if (ictx?.__turnLlmCalls) {
            const start = node.startTime ?? 0;
            const durationMs = typeof node.endTime === 'number' ? node.endTime - start : undefined;
            ictx.__turnLlmCalls.push({
                model: node.model,
                provider: (node.providerData as { provider?: string })?.provider,
                durationMs,
                inputTokens: node.usage?.inputTokens,
                outputTokens: node.usage?.outputTokens,
                cost: node.pricing?.cost,
                module: node.module
            });
        }

        if (responseModel) {
            Object.assign(node.providerData, { responseModel });
        }

        telemetry.endNode(node);

        // Cleanup: Only pop if no tools are pending
        if (toolCalls.length === 0) {
            this.popNode(ctx.conversationId, node.id);
            this.llmNodes.delete(ctx.llmCallId);
        } else {
            // Keep on stack as parent for tools, but mark as ended
            // (already marked as success/ended above)
        }

        this.llmPrompts.delete(ctx.llmCallId);
        this.llmChoices.delete(ctx.llmCallId);
    }

    startTool(ctx: ToolCallContext): void {
        const parentId = this.getActiveParent(ctx.conversationId, 'tool');
        const parentNode = telemetry.getNode(parentId);
        const traceId = parentNode?.traceId ?? resolveTraceIdFromParentId(parentId);

        const toolNode = new ToolNode(ctx.name, parentId, ctx.toolCallId, traceId);
        toolNode.name = `execute_tool ${ctx.name}`;
        toolNode.startTime = ctx.startedAt;
        toolNode.status = 'active';
        if (this.contextRef?.__currentModule) {
            toolNode.module = this.contextRef.__currentModule;
        }
        toolNode.input = {
            type: ctx.type,
            args: ctx.args,
            executionIndex: ctx.executionIndex,
            parallel: ctx.parallel
        };

        this.toolNodes.set(ctx.toolCallId, toolNode);
        this.pushNode(ctx.conversationId, toolNode.id);
        telemetry.registerNode(toolNode);
    }

    endTool(ctx: ToolCallContext, result?: unknown, error?: unknown): void {
        const toolNode = this.toolNodes.get(ctx.toolCallId);
        if (!toolNode) return;

        toolNode.endTime = Date.now();

        if (error) {
            toolNode.status = 'failure';
            toolNode.output = { error: error instanceof Error ? error.message : String(error) };
            telemetry.failNode(toolNode, error instanceof Error ? error : new Error(String(error)));
        } else {
            toolNode.status = 'success';
            toolNode.output = result;
            telemetry.endNode(toolNode);
        }

        // Accumulate into turn trace
        const ictx = this.contextRef;
        if (ictx?.__turnToolCalls) {
            const start = toolNode.startTime ?? 0;
            const durationMs = typeof toolNode.endTime === 'number' ? toolNode.endTime - start : undefined;
            ictx.__turnToolCalls.push({
                tool: toolNode.toolName,
                durationMs,
                status: toolNode.status === 'success' ? 'success' : 'failure',
                module: toolNode.module
            });
        }

        this.popNode(ctx.conversationId, toolNode.id);
        this.toolNodes.delete(ctx.toolCallId);
    }

    async flush(): Promise<void> {
        // Nothing to flush - we emit directly to callagent telemetry
    }

    async shutdown(): Promise<void> {
        // Cleanup
        this.llmNodes.clear();
        this.toolNodes.clear();
        this.conversationNodes.clear();
        this.llmPrompts.clear();
        this.llmChoices.clear();
        this.nodeStack.clear();
    }

    /**
     * Update the parent node ID. Call this when the context changes (e.g., new turn).
     * Optionally pass context so the bridge can stamp module and accumulate turn summaries.
     */
    setParentNodeId(parentNodeId: string, ctx?: InternalTaskContext | null): void {
        this.parentNodeId = parentNodeId;
        if (ctx !== undefined) {
            this.contextRef = ctx ?? null;
        }
    }

    /** When parent is still `'root'` or chain lacks traceId, fall back to task context (Opik span routing). */
    private resolveBridgeTraceId(
        parentId: string,
        parentNode: TelemetryNode | undefined
    ): string | undefined {
        const fromParent = parentNode?.traceId ?? resolveTraceIdFromParentId(parentId);
        if (fromParent) return fromParent;
        const fromCtx = this.contextRef?.telemetry?.traceId;
        return typeof fromCtx === 'string' ? fromCtx : undefined;
    }
}

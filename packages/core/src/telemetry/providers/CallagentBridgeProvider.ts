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
import { ModuleNode } from '../nodes/ModuleNode.js';
import { WorkflowNode } from '../nodes/WorkflowNode.js';
import { TelemetryNode } from '../nodes/TelemetryNode.js';
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

/**
 * Bridge provider that converts callLLM telemetry events into callagent telemetry nodes.
 */
export class CallagentBridgeProvider implements CallLLMTelemetryProvider {
    name = 'callagent-bridge';

    private parentNodeId: string;
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
        const traceId = parentNode?.traceId;

        const node = new WorkflowNode(`conversation.${ctx.type}`, parentId, ctx.conversationId, traceId);
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

        // Cleanup stack
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

        const parentId = this.getActiveParent(ctx.conversationId, 'llm');
        const parentNode = telemetry.getNode(parentId);
        const traceId = parentNode?.traceId;

        const node = new LLMNode(ctx.model, parentId, ctx.llmCallId, traceId);
        node.name = `${ctx.provider.toLowerCase()}.chat.completions`;
        node.startTime = ctx.startedAt;
        node.status = 'active';

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
        if (usage) {
            const tokensIn = (usage as any)?.tokens?.input?.total ?? (usage as any)?.tokens?.input ?? 0;
            const tokensOut = (usage as any)?.tokens?.output?.total ?? (usage as any)?.tokens?.output ?? 0;
            const tokensTotal = (usage as any)?.tokens?.total ?? (tokensIn + tokensOut);
            const cost = (usage as any)?.costs?.total || 0;

            node.usage = {
                inputTokens: tokensIn,
                outputTokens: tokensOut,
                totalTokens: tokensTotal
            };

            if (cost) {
                node.pricing = { cost, currency: (usage as any)?.costs?.currency || 'USD' };
            }
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
        const traceId = parentNode?.traceId;

        const toolNode = new ToolNode(ctx.name, parentId, ctx.toolCallId, traceId);
        toolNode.name = `execute_tool ${ctx.name}`;
        toolNode.startTime = ctx.startedAt;
        toolNode.status = 'active';
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
     * Update the parent node ID. Call this when the context changes (e.g., new module).
     */
    setParentNodeId(parentNodeId: string): void {
        this.parentNodeId = parentNodeId;
    }
}

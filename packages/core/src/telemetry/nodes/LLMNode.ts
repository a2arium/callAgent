
import { TelemetryNode } from './TelemetryNode.js';

export class LLMNode extends TelemetryNode {
    public readonly model: string;
    public module?: string;

    constructor(model: string, parentId: string, id?: string, traceId?: string) {
        super('llm', parentId, id, traceId);
        this.model = model;
    }
}

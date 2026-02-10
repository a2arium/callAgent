
import { TelemetryNode } from './TelemetryNode.js';

export class ModuleNode extends TelemetryNode {
    public readonly name: string;

    constructor(name: string, parentId: string, id?: string, traceId?: string) {
        super('module', parentId, id, traceId);
        this.name = name;
    }
}

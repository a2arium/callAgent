
import { TelemetryProvider } from '../Provider.js';
import { TelemetryNode, UsageInfo } from '../nodes/TelemetryNode.js';
import { logger } from '@a2arium/callagent-utils';

const log = logger.createLogger({ prefix: 'ConsoleTelemetry' });

export class ConsoleProvider implements TelemetryProvider {
    name = 'console';

    onNodeStart(node: TelemetryNode): void {
        // Only log high-level nodes to avoid spam
        if (node.type === 'agent' || node.type === 'turn') {
            log.info(`[START] ${node.type.toUpperCase()} ID=${node.id} Parent=${node.parentId || 'ROOT'}`);
        } else {
            log.debug(`[START] ${node.type.toUpperCase()} ID=${node.id}`);
        }
    }

    onNodeEnd(node: TelemetryNode): void {
        const duration = node.endTime && node.startTime ? node.endTime - node.startTime : '?';
        const namePart = node.name ? ` (${node.name})` : '';
        log.info(`[END] ${node.type.toUpperCase()}${namePart} ID=${node.id} Parent=${node.parentId || 'ROOT'} Status=${node.status} Duration=${duration}ms`);
    }

    onNodeFailure(node: TelemetryNode, error: Error): void {
        log.error(`[FAIL] ${node.type.toUpperCase()} ID=${node.id}`, error);
    }

    onUsageUpdate(node: TelemetryNode, usage: UsageInfo): void {
        if (usage.totalTokens) {
            log.debug(`[USAGE] ${node.type.toUpperCase()} ID=${node.id} Tokens=${usage.totalTokens} Cost=$${node.pricing.cost}`);
        }
    }
}

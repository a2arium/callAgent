import type { TelemetryProvider } from '../Provider.js';
import type { TelemetryNode, UsageInfo } from '../nodes/TelemetryNode.js';
import type { TurnTrace } from '../../types/turnTrace.js';
import { logger } from '@a2arium/callagent-utils';

const log = logger.createLogger({ prefix: 'ConsoleTelemetry' });

export class ConsoleProvider implements TelemetryProvider {
    name = 'console';

    onTurnTrace(trace: TurnTrace): void {
        const summary = [
            `Turn ${trace.turn}`,
            `stage: ${trace.stageBefore} → ${trace.stageAfter ?? trace.stageBefore}`,
            `intent: ${trace.intent?.kind ?? '?'}`,
            `shield: ${trace.shield?.action ?? 'none'}`,
            `transition: ${trace.transition?.kind ?? '?'}`,
            `total: ${trace.timings.totalMs}ms`,
            trace.usage?.totalTokens != null ? `tokens: ${trace.usage.totalTokens}` : null,
            trace.usage?.totalCost != null ? `cost: $${trace.usage.totalCost.toFixed(4)}` : null,
        ]
            .filter(Boolean)
            .join(' | ');
        log.info(`[TURN] ${summary}`);
    }

    onNodeStart(node: TelemetryNode): void {
        if (node.type === 'agent') {
            log.info(`[AGENT START] ${node.id}`);
        }
    }

    onNodeEnd(node: TelemetryNode): void {
        if (node.type === 'agent') {
            const duration =
                node.endTime && node.startTime
                    ? node.endTime - node.startTime
                    : '?';
            log.info(
                `[AGENT END] ${node.id} Status=${node.status} Duration=${duration}ms`
            );
        }
    }

    onNodeFailure(node: TelemetryNode, error: Error): void {
        log.error(`[FAIL] ${node.type.toUpperCase()} ID=${node.id}`, error);
    }

    onUsageUpdate(node: TelemetryNode, usage: UsageInfo): void {
        if (usage.totalTokens) {
            log.debug(
                `[USAGE] ${node.type.toUpperCase()} ID=${node.id} Tokens=${usage.totalTokens} Cost=$${node.pricing.cost}`
            );
        }
    }
}

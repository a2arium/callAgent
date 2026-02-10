
import { TelemetryNode } from './nodes/TelemetryNode.js';
import { TelemetryProvider } from './Provider.js';
import { logger } from '@a2arium/callagent-utils';

const log = logger.createLogger({ prefix: 'TelemetryCollector' });

import { ConsoleProvider } from './providers/ConsoleProvider.js';
import { OpikProvider } from './providers/OpikProvider.js';

export class TelemetryCollector {
    private static instance: TelemetryCollector;
    private providers: TelemetryProvider[] = [];
    private nodeRegistry = new Map<string, TelemetryNode>();

    private constructor() {
        this.autoDiscoverProviders();
    }

    private autoDiscoverProviders() {
        if (process.env.TELEMETRY_CONSOLE === 'true' || process.env.CONSOLE_TELEMETRY === 'true') {
            this.addProvider(new ConsoleProvider());
        }

        if (process.env.CALLAGENT_OPIK_ENABLED === 'true' || !!process.env.OPIK_API_KEY) {
            this.addProvider(new OpikProvider());
        }
    }

    public static getInstance(): TelemetryCollector {
        if (!TelemetryCollector.instance) {
            TelemetryCollector.instance = new TelemetryCollector();
        }
        return TelemetryCollector.instance;
    }

    public addProvider(provider: TelemetryProvider): void {
        this.providers.push(provider);
        log.info(`Added telemetry provider: ${provider.name}`);
    }

    public clearProviders(): void {
        this.providers = [];
        this.nodeRegistry.clear();
    }

    public registerNode(node: TelemetryNode): void {
        this.nodeRegistry.set(node.id, node);
        this.broadcast(p => p.onNodeStart(node));
    }

    public endNode(node: TelemetryNode): void {
        this.broadcast(p => p.onNodeEnd(node));
        // We might want to keep it in registry for later reference or clear it
        // For now, let's keep it to allow usage updates after end (e.g. async cost calculation)
        // Ideally, we garbage collect eventually.
    }

    public failNode(node: TelemetryNode, error: Error): void {
        this.broadcast(p => p.onNodeFailure(node, error));
    }

    public updateUsage(node: TelemetryNode): void {
        this.broadcast(p => p.onUsageUpdate(node, node.usage));
    }

    public getNode(id: string): TelemetryNode | undefined {
        return this.nodeRegistry.get(id);
    }

    private broadcast(fn: (p: TelemetryProvider) => void | Promise<void>): void {
        this.providers.forEach(p => {
            try {
                const res = fn(p);
                if (res instanceof Promise) {
                    res.catch(err => log.error(`Provider ${p.name} error`, err));
                }
            } catch (err) {
                log.error(`Provider ${p.name} error`, err);
            }
        });
    }
}

export const telemetry = TelemetryCollector.getInstance();

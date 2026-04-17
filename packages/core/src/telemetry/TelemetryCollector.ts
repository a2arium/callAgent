
import { TelemetryNode } from './nodes/TelemetryNode.js';
import type { TelemetryProvider } from './Provider.js';
import type { TurnTrace } from '../types/turnTrace.js';
import { logger } from '@a2arium/callagent-utils';

const log = logger.createLogger({ prefix: 'TelemetryCollector' });

import { ConsoleProvider } from './providers/ConsoleProvider.js';
import { OpikProvider } from './providers/OpikProvider.js';
import { turnOpikDiagEnabled } from './turnOpikDiagEnv.js';

function isTestRuntime(): boolean {
    return process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
}

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

        if (isTestRuntime()) {
            return;
        }

        if (process.env.CALLAGENT_OPIK_ENABLED === 'true' || !!process.env.OPIK_API_KEY) {
            this.addProvider(
                new OpikProvider(
                    (id: string) => this.nodeRegistry.get(id),
                    () => [...this.nodeRegistry.values()]
                )
            );
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

    /** Snapshot of registered nodes (e.g. Opik replay after async client init). */
    public getRegisteredNodes(): TelemetryNode[] {
        return [...this.nodeRegistry.values()];
    }

    /**
     * Best-effort flush for providers that buffer (e.g. Opik). Call before process exit in CLIs.
     */
    public async shutdownProviders(): Promise<void> {
        for (const p of this.providers) {
            const maybe = (p as { flush?: () => Promise<void> }).flush;
            if (typeof maybe === 'function') {
                try {
                    await maybe();
                } catch (err) {
                    log.error(`Provider ${p.name} flush error`, err);
                }
            }
        }
    }

    /** Emit the assembled TurnTrace to all providers. Called exactly once per turn by loopRunner. */
    public emitTurnTrace(trace: TurnTrace): void {
        if (turnOpikDiagEnabled()) {
            log.info('[CALLAGENT_DEBUG_TURN_OPIK] TelemetryCollector.emitTurnTrace → providers', {
                providerNames: this.providers.map((p) => p.name),
                turn: trace.turn,
                traceId: trace.traceId,
                spanId: trace.spanId,
                parentSpanId: trace.parentSpanId,
            });
        }
        this.broadcast((p) => p.onTurnTrace(trace));
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

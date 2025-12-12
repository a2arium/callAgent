import { logger } from '@a2arium/callagent-utils';

export interface ToolExecutionResult<T = unknown> {
    success: boolean;
    output?: T;
    error?: unknown;
    durationMs: number;
}

export type ToolImplementation = (args: unknown, context?: unknown) => Promise<unknown> | unknown;

export class ToolExecutionService {
    private tools: Map<string, ToolImplementation> = new Map();
    private logger = logger.createLogger({ prefix: 'ToolExecutionService' });

    constructor(initialTools?: Record<string, ToolImplementation>) {
        if (initialTools) {
            Object.entries(initialTools).forEach(([name, fn]) => this.register(name, fn));
        }
    }

    /**
     * Register a tool implementation
     */
    register(name: string, impl: ToolImplementation): void {
        this.tools.set(name, impl);
        this.logger.debug(`Registered tool: ${name}`);
    }

    /**
     * Check if a tool is registered
     */
    has(name: string): boolean {
        return this.tools.has(name);
    }

    /**
     * Invoke a tool by name
     */
    async invoke<T = unknown>(name: string, args: unknown, context?: unknown): Promise<ToolExecutionResult<T>> {
        const start = Date.now();
        const impl = this.tools.get(name);

        if (!impl) {
            return {
                success: false,
                error: new Error(`Tool '${name}' not found`),
                durationMs: 0
            };
        }

        try {
            this.logger.debug(`Invoking tool: ${name}`, { args });
            const output = await impl(args, context) as T;
            return {
                success: true,
                output,
                durationMs: Date.now() - start
            };
        } catch (error) {
            this.logger.error(`Tool execution failed: ${name}`, error, { args });
            return {
                success: false,
                error,
                durationMs: Date.now() - start
            };
        }
    }

    /**
     * Get a handler object compatible with TaskContext.tools
     */
    asContextCapability(context?: unknown) {
        return {
            invoke: async <T = unknown>(name: string, args: unknown): Promise<T> => {
                const result = await this.invoke<T>(name, args, context);
                if (!result.success) {
                    throw result.error;
                }
                return result.output as T;
            }
        };
    }
}

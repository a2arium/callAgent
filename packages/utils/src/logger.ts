/**
 * Centralized logging utility for the AI Agents Framework
 * Provides consistent logging with levels, component prefixing, and structured output
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LoggerConfig = {
    level?: LogLevel;
    prefix?: string;
};

// Define level priorities globally
const LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};

/**
 * Default configuration for the logger
 */
const DEFAULT_CONFIG: Required<LoggerConfig> = {
    level: (process.env.LOG_LEVEL as LogLevel) || 'info',
    prefix: 'Framework'
};

/**
 * Logger class for component-specific logging
 */
export class ComponentLogger {
    private readonly level: LogLevel;
    private readonly levelPriority = LEVEL_PRIORITY; // Use global priorities

    constructor(private config: Required<LoggerConfig>) {
        this.level = config.level;
    }

    /**
     * Check if a log level should be displayed based on current config
     */
    private shouldLog(level: LogLevel): boolean {
        return this.levelPriority[level] >= this.levelPriority[this.level];
    }

    /**
     * Format log prefix
     */
    private getPrefix(): string {
        return this.config.prefix ? `[${this.config.prefix}]` : '';
    }

    /**
     * Creates a new child logger instance with an extended prefix.
     * @param childConfig - Configuration for the child logger (only prefix is used)
     * @returns A new ComponentLogger instance
     */
    createLogger(childConfig: Pick<LoggerConfig, 'prefix'>): ComponentLogger {
        const parentPrefix = this.config.prefix;
        const childPrefix = childConfig.prefix;

        let newPrefix = parentPrefix;
        if (childPrefix) {
            newPrefix = parentPrefix ? `${parentPrefix}: ${childPrefix}` : childPrefix;
        }

        // Child inherits parent's level, but uses the combined prefix
        const newConfig: Required<LoggerConfig> = {
            level: this.config.level,
            prefix: newPrefix,
        };
        return new ComponentLogger(newConfig);
    }

    /**
     * Log a debug message
     */
    debug(message: string, ...args: unknown[]): void {
        if (this.shouldLog('debug')) {
            console.debug(`${this.getPrefix()} ${message}`, ...args);
        }
    }

    /**
     * Log an informational message
     */
    info(message: string, ...args: unknown[]): void {
        if (this.shouldLog('info')) {
            console.info(`${this.getPrefix()} ${message}`, ...args);
        }
    }

    /**
     * Log a warning message
     */
    warn(message: string, ...args: unknown[]): void {
        if (this.shouldLog('warn')) {
            console.warn(`${this.getPrefix()} ${message}`, ...args);
        }
    }

    /**
     * Log an error message
     */
    error(message: string, error?: unknown, context?: Record<string, unknown>): void {
        if (this.shouldLog('error')) {
            // Safe JSON serialization to avoid circular reference issues
            const contextStr = context ? (() => {
                try {
                    const seenObjects = new WeakSet();
                    return ` ${JSON.stringify(context, (key, value) => {
                        if (typeof value === 'object' && value !== null) {
                            // Simple circular reference detection using a WeakSet
                            if (seenObjects.has(value)) {
                                return '[Circular Reference]';
                            }
                            seenObjects.add(value);
                        }
                        return value;
                    })}`;
                } catch (serializationError) {
                    return ` [Context Serialization Error: ${serializationError instanceof Error ? serializationError.message : String(serializationError)}]`;
                }
            })() : '';

            if (error instanceof Error) {
                console.error(`${this.getPrefix()} ${message}`, error.message, contextStr);
                console.error(error.stack);
            } else if (error !== undefined) {
                console.error(`${this.getPrefix()} ${message}`, error, contextStr);
            } else {
                console.error(`${this.getPrefix()} ${message}${contextStr}`);
            }
        }
    }
}

/**
 * Main logger utility for creating component-specific loggers
 */
class Logger {
    private globalConfig: Required<LoggerConfig> = { ...DEFAULT_CONFIG };
    private readonly levelPriority = LEVEL_PRIORITY;

    // Cache the default logger to avoid creating a new instance for each call
    private defaultLoggerInstance: ComponentLogger | null = null;

    /**
     * Set global logger configuration
     */
    setGlobalConfig(config: Partial<LoggerConfig>): void {
        this.globalConfig = { ...this.globalConfig, ...config };
        this.defaultLoggerInstance = null; // Reset cache
    }

    /**
     * Alias for setGlobalConfig
     */
    setConfig(config: Partial<LoggerConfig>): void {
        this.setGlobalConfig(config);
    }

    /**
     * Create a component-specific logger instance
     */
    createLogger(config: LoggerConfig = {}): ComponentLogger {
        const mergedConfig: Required<LoggerConfig> = {
            level: config.level ?? this.globalConfig.level,
            prefix: config.prefix ?? this.globalConfig.prefix,
        };
        return new ComponentLogger(mergedConfig);
    }

    /**
     * Get the default logger instance (create once, reuse)
     */
    private getDefaultLogger(): ComponentLogger {
        if (!this.defaultLoggerInstance) {
            this.defaultLoggerInstance = this.createLogger(); // Use default prefix
        }
        return this.defaultLoggerInstance;
    }

    /**
     * Log a debug message (using default logger)
     */
    debug(message: string, ...args: unknown[]): void {
        this.getDefaultLogger().debug(message, ...args);
    }

    /**
     * Log an informational message (using default logger)
     */
    info(message: string, ...args: unknown[]): void {
        this.getDefaultLogger().info(message, ...args);
    }

    /**
     * Log a warning message (using default logger)
     */
    warn(message: string, ...args: unknown[]): void {
        this.getDefaultLogger().warn(message, ...args);
    }

    /**
     * Log an error message (using default logger)
     */
    error(message: string, error?: unknown, context?: Record<string, unknown>): void {
        this.getDefaultLogger().error(message, error, context);
    }
}

// Create a singleton instance of the logger
export const logger = new Logger();

// Export default instance
export default logger; 
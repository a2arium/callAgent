/**
 * Centralized logging utility for the AI Agents Framework
 * Provides consistent logging with levels, component prefixing, and structured output
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LoggerConfig = {
    level?: LogLevel;
    prefix?: string;
};
/**
 * Logger class for component-specific logging
 */
export declare class ComponentLogger {
    private config;
    private readonly level;
    private readonly levelPriority;
    constructor(config: Required<LoggerConfig>);
    /**
     * Check if a log level should be displayed based on current config
     */
    private shouldLog;
    /**
     * Format log prefix
     */
    private getPrefix;
    /**
     * Creates a new child logger instance with an extended prefix.
     * @param childConfig - Configuration for the child logger (only prefix is used)
     * @returns A new ComponentLogger instance
     */
    createLogger(childConfig: Pick<LoggerConfig, 'prefix'>): ComponentLogger;
    /**
     * Log a debug message
     */
    debug(message: string, ...args: unknown[]): void;
    /**
     * Log an informational message
     */
    info(message: string, ...args: unknown[]): void;
    /**
     * Log a warning message
     */
    warn(message: string, ...args: unknown[]): void;
    /**
     * Log an error message
     */
    error(message: string, error?: unknown, context?: Record<string, unknown>): void;
}
/**
 * Main logger utility for creating component-specific loggers
 */
declare class Logger {
    private globalConfig;
    private readonly levelPriority;
    private defaultLoggerInstance;
    /**
     * Set global logger configuration
     */
    setGlobalConfig(config: Partial<LoggerConfig>): void;
    /**
     * Alias for setGlobalConfig
     */
    setConfig(config: Partial<LoggerConfig>): void;
    /**
     * Create a component-specific logger instance
     */
    createLogger(config?: LoggerConfig): ComponentLogger;
    /**
     * Get the default logger instance (create once, reuse)
     */
    private getDefaultLogger;
    /**
     * Log a debug message (using default logger)
     */
    debug(message: string, ...args: unknown[]): void;
    /**
     * Log an informational message (using default logger)
     */
    info(message: string, ...args: unknown[]): void;
    /**
     * Log a warning message (using default logger)
     */
    warn(message: string, ...args: unknown[]): void;
    /**
     * Log an error message (using default logger)
     */
    error(message: string, error?: unknown, context?: Record<string, unknown>): void;
}
export declare const logger: Logger;
export default logger;

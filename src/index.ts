/**
 * Main entry point for the AI Agents Framework (Minimal Core)
 */

import { logger } from './utils/logger.js';

// Create component-specific logger instead of modifying global config
const frameworkLogger = logger.createLogger({ prefix: 'Framework' });

// Export core types
export * from './shared/types/index.js';

// Export plugin system
export { createAgentPlugin } from './core/plugin/createAgentPlugin.js';
export { type AgentPlugin, type CreateAgentPluginOptions } from './core/plugin/types.js';

// Export minimal config
export { loadConfig } from './config/index.js';

// Export error types
export * from './utils/errors.js';

// Export logger
export { logger, type LogLevel, type LoggerConfig } from './utils/logger.js';

// Log framework initialization
frameworkLogger.info("AI Agents Framework initialized");

// Types for future implementations
export type AgentContext = {
    // Placeholder for context type definition
    [key: string]: unknown; // Avoid 'any'
} 
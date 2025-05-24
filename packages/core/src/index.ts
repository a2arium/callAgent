export * from './core/plugin/createAgent.js';
export type { TaskContext } from './shared/types/index.js';
export type { LLMConfig, UniversalChatResponse, UniversalStreamResponse } from './shared/types/LLMTypes.js';
// Removed build utilities - use simple copying instead:
// "build": "tsc && copyfiles agent.json dist" or "tsc && cp agent.json dist/"
// Add other exports as needed for the public API 
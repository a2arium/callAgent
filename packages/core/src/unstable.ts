/**
 * Non-semver surface for examples, tests, and integrations that need direct access
 * to the conversation service and in-memory session wiring. Prefer `ctx.conversation`
 * in production agents.
 */
export { ConversationService } from './internal/conversation/ConversationService.js';
export { createDbMessageLog } from './eventbus/dbMessageLog.js';
export { InMemorySessionManager } from './orchestration/InMemorySessionManager.js';
export { SessionManager } from './orchestration/SessionManager.js';
export {
    bootstrapCompositionRootInternal,
    type RuntimeCompositionRootInternal,
} from './runtime/bootstrapCompositionRoot.js';
export * from './runtime/index.js';

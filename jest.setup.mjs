// Disable outboxPublisher auto-start in tests to prevent background services
// Tests should explicitly start/stop services they need
process.env.DISABLE_OUTBOX_PUBLISHER = '1';

const testLogsEnabled = process.env.CALLAGENT_TEST_LOGS === '1';

const noisyErrorPatterns = [
    '[TaskExecutor] runLoop threw an error:',
    '[TaskExecutor] runLoop exception',
    '[TurnRunner] TurnRunner error',
    '[TaskEngine] restoreCtx: Failed to create memory registry',
    '[ToolExecutionService] Tool execution failed:',
    'PluginManager.findAgent is not a function',
    "Cannot read properties of undefined (reading 'id')",
    'Error: Boom',
    'Error: Fail',
    'Unknown argument: --nope',
    'CRITICAL: createTaskHandle attempted to update invalid/empty snapshot',
    '[TaskEngine] Task engine error',
    '[runLoop] Turn execution failed',
    '[LoopRunner]',
    'Turn 1 failed',
    'ctx.reply is not a function',
    '[AgentCache] Error getting cached result',
    '[AgentCache] Error setting cached result',
    '[AgentCache] Error clearing cache',
    'Database connection failed',
    'Database write failed',
    'Database delete failed',
    'bad input',
    'attention module failed:',
    'perception module failed:',
    'execution module failed:',
    'transition module failed:',
    '[PluginManager] Failed to register agent plugin',
    "Cannot read properties of null (reading 'agentCard')",
];

const noisyWarnPatterns = [
    'MEMORY_DATABASE_URL not found',
    'Memory backends empty or stub detected',
    'Failed to create working memory adapter, using placeholder',
    'No semantic adapter could be resolved',
    'No budgets found in manifest or state for agent',
    'Cannot stage observation: token not found',
    'Cannot stage observation: snapshot not found',
    'createTaskHandle loaded empty/partial snapshot',
    'DEBUG: Skipping offloadArtifacts - No Prisma',
    'No SessionStore configured - using IN-MEMORY mode',
    'IN-MEMORY MODE IS NOT SUITABLE FOR PRODUCTION',
    'For production, configure a database-backed SessionStore',
    'CAS mismatch for session',
    'TaskExecutor saveSnapshot block caught exception',
    'CRITICAL: Resume loaded snapshot with mismatched Agent ID',
    'Local agent not found',
    'TurnTrace parse failed',
    'Agent already registered, overwriting',
    'ctx.memory is undefined',
    'Circular dependency detected',
    'Maximum agent depth exceeded',
    'Skipping agent "source-only-agent"',
    'LoopRunner: flushSnapshot not available on context for subagent dispatch',
    'Invalid observation envelope; injecting validation.failed',
];

const formatConsoleArgs = (args) => args.map((arg) => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}).join(' ');

const installQuietTestConsole = () => {
    if (testLogsEnabled) return;

    const originals = {
        debug: console.debug.bind(console),
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
    };

    console.debug = () => {};
    console.log = () => {};
    console.info = () => {};
    console.warn = (...args) => {
        const text = formatConsoleArgs(args);
        if (noisyWarnPatterns.some((pattern) => text.includes(pattern))) return;
        originals.warn(...args);
    };
    console.error = (...args) => {
        const text = formatConsoleArgs(args);
        if (noisyErrorPatterns.some((pattern) => text.includes(pattern))) return;
        originals.error(...args);
    };
};

installQuietTestConsole();

// Per-test-suite teardown (runs after each test file)
// Note: Global teardown in jest.teardown.js runs ONCE after ALL tests
// Use dynamic import for ESM modules in CommonJS context
const setupTeardown = async () => {
    const { afterAll } = await import('@jest/globals');

    afterAll(async () => {
        if (testLogsEnabled) {
            const handles = process._getActiveHandles ? process._getActiveHandles().length : 'unknown';
            const requests = process._getActiveRequests ? process._getActiveRequests().length : 'unknown';
            console.log(`[SuiteTeardown] Active handles: ${handles}, Active requests: ${requests}`);
        }

        try {
            const { EngineLocator } = await import('./packages/core/src/orchestration/EngineLocator.js');
            const engine = EngineLocator.getEngine();
            engine?.stopOutboxPublisher?.();
        } catch {
            /* noop */
        }
    });
};

// Execute setup synchronously - Jest will wait for the promise
setupTeardown().catch(() => {
    // Ignore errors during setup
});

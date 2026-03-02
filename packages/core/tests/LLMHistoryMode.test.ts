import { TaskEngine } from '../src/orchestration/taskEngine.js';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { jest } from '@jest/globals';
import { MentalState } from '../src/loop/types.js';

describe('LLM History Mode', () => {
    let sessionStore: InMemorySessionManager;
    let sessionManager: SessionManager;
    let engine: TaskEngine;

    beforeEach(() => {
        sessionStore = new InMemorySessionManager();
        sessionManager = new SessionManager(sessionStore);
        engine = new TaskEngine({ sessionStore: sessionStore as any });
    });

    it('should NOT save LLM history when mode is stateless', async () => {
        const mockStatelessCaller = {
            getHistoryMode: () => 'stateless',
            getMessages: jest.fn().mockReturnValue([{ role: 'user', content: 'test' }]),
            call: jest.fn(),
            addToolResult: jest.fn(),
            updateSettings: jest.fn(),
            exportState: jest.fn().mockReturnValue({ messages: [] })
        };

        const ctx: any = {
            llm: mockStatelessCaller,
            agentId: 'test-agent',
            tenantId: 'test-tenant',
            task: { id: 'test-task', input: {} },
            vars: {},
            memory: {
                semantic: {
                    backends: { basic: {} },
                    getDefaultBackend: () => 'basic'
                }
            }
        };
        ctx.__mental = {
            memory: { sensory: {}, vars: {} },
            goalState: { hierarchy: { nodes: {}, roots: [] } }
        };

        await engine.flushContextSnapshot('test-tenant', 'test-task', 'test-agent', ctx);

        const snap = await sessionManager.load('test-tenant', 'test-task');
        const savedLlmState = (snap?.snapshot as any)?.M?.memory?.sensory?.llmState;

        expect(savedLlmState).toBeUndefined();
        expect(mockStatelessCaller.getMessages).not.toHaveBeenCalled();
        expect(mockStatelessCaller.exportState).not.toHaveBeenCalled();
    });

    it('should clear history during restoration when mode is stateless', async () => {
        const mockStatelessCaller = {
            getHistoryMode: () => 'stateless',
            clearHistory: jest.fn(),
            importState: jest.fn(),
            call: jest.fn()
        };

        const ctx: any = { llm: mockStatelessCaller };
        const M: any = {
            memory: {
                sensory: {
                    llmState: { messages: [{ role: 'user', content: 'stale' }] }
                }
            }
        };

        // attachAndRestoreLLM is private, but we can access it for testing
        await (engine as any).attachAndRestoreLLM(ctx, 'test-agent', M);

        expect(mockStatelessCaller.clearHistory).toHaveBeenCalled();
        expect(mockStatelessCaller.importState).not.toHaveBeenCalled();
    });

    it('should save and restore history when mode is full', async () => {
        const mockFullCaller = {
            getHistoryMode: () => 'full',
            getMessages: jest.fn().mockReturnValue([{ role: 'user', content: 'preserved' }]),
            importState: jest.fn(),
            call: jest.fn()
        };

        const ctx: any = {
            llm: mockFullCaller,
            agentId: 'test-agent',
            tenantId: 'test-tenant',
            task: { id: 'test-task', input: {} },
            vars: {},
            memory: {
                semantic: {
                    backends: { basic: {} },
                    getDefaultBackend: () => 'basic'
                }
            }
        };
        const M: any = {
            memory: { sensory: {}, vars: {} },
            goalState: { hierarchy: { nodes: {}, roots: [] } }
        };
        ctx.__mental = M;

        // 1. Test Saving
        await engine.flushContextSnapshot('test-tenant', 'test-task', 'test-agent', ctx);
        const snap = await sessionManager.load('test-tenant', 'test-task');
        const savedLlmState = (snap?.snapshot as any)?.M?.memory?.sensory?.llmState;

        expect(savedLlmState).toEqual({ messages: [{ role: 'user', content: 'preserved' }] });

        // 2. Test Restoration
        const restoreCtx: any = { llm: mockFullCaller };
        await (engine as any).attachAndRestoreLLM(restoreCtx, 'test-agent', (snap?.snapshot as any).M);

        expect(mockFullCaller.importState).toHaveBeenCalledWith(savedLlmState);
    });
});

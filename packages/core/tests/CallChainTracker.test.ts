/**
 * Tests for circular dependency detection in A2AService
 *
 * These tests verify that:
 * 1. Direct circular dependencies (A → B → A) are detected
 * 2. Indirect circular dependencies (A → B → C → A) are detected
 * 3. Valid nested calls (A → B → C) are allowed
 * 4. Depth limiting prevents runaway recursion
 * 5. Clear error messages help debugging
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CallChainTracker, resetCallChainTracker, type AgentCall } from '../src/orchestration/CallChainTracker.js';

describe('CallChainTracker', () => {
    let tracker: CallChainTracker;

    beforeEach(() => {
        resetCallChainTracker();
        tracker = new CallChainTracker({
            maxDepth: 5,
            enableCycleDetection: true,
            enableDepthLimiting: true
        });
    });

    afterEach(() => {
        resetCallChainTracker();
    });

    describe('basic operations', () => {
        it('should register and track agent calls', () => {
            const call: AgentCall = {
                taskId: 'task-1',
                agentId: 'agent-a',
                parentTaskId: undefined,
                depth: 0,
                timestamp: Date.now()
            };

            tracker.registerCall(call);
            expect(tracker.size).toBe(1);

            const chain = tracker.getCallChain('task-1');
            expect(chain).toHaveLength(1);
            expect(chain[0].agentId).toBe('agent-a');
        });

        it('should unregister calls', () => {
            tracker.registerCall({
                taskId: 'task-1',
                agentId: 'agent-a',
                depth: 0,
                timestamp: Date.now()
            });

            expect(tracker.size).toBe(1);
            tracker.unregisterCall('task-1');
            expect(tracker.size).toBe(0);
        });

        it('should build call chain correctly', () => {
            // Register a chain: root → child → grandchild
            tracker.registerCall({ taskId: 'root', agentId: 'agent-root', depth: 0, timestamp: Date.now() });
            tracker.registerCall({ taskId: 'child', agentId: 'agent-child', parentTaskId: 'root', depth: 1, timestamp: Date.now() });
            tracker.registerCall({ taskId: 'grandchild', agentId: 'agent-grandchild', parentTaskId: 'child', depth: 2, timestamp: Date.now() });

            const chain = tracker.getCallChain('grandchild');
            expect(chain).toHaveLength(3);
            expect(chain.map(c => c.agentId)).toEqual(['agent-root', 'agent-child', 'agent-grandchild']);
        });
    });

    describe('circular dependency detection', () => {
        it('should detect direct circular dependency (A → B → A)', () => {
            // Set up: agent-a calls agent-b
            tracker.registerCall({ taskId: 'task-a', agentId: 'agent-a', depth: 0, timestamp: Date.now() });
            tracker.registerCall({ taskId: 'task-b', agentId: 'agent-b', parentTaskId: 'task-a', depth: 1, timestamp: Date.now() });

            // Check if agent-b can call agent-a
            const result = tracker.checkCircularDependency('agent-a', 'task-b');

            expect(result.hasCycle).toBe(true);
            expect(result.cycleAgent).toBe('agent-a');
            expect(result.chain.map(c => c.agentId)).toEqual(['agent-a', 'agent-b']);
        });

        it('should detect indirect circular dependency (A → B → C → A)', () => {
            // Set up: agent-a → agent-b → agent-c
            tracker.registerCall({ taskId: 'task-a', agentId: 'agent-a', depth: 0, timestamp: Date.now() });
            tracker.registerCall({ taskId: 'task-b', agentId: 'agent-b', parentTaskId: 'task-a', depth: 1, timestamp: Date.now() });
            tracker.registerCall({ taskId: 'task-c', agentId: 'agent-c', parentTaskId: 'task-b', depth: 2, timestamp: Date.now() });

            // Check if agent-c can call agent-a
            const result = tracker.checkCircularDependency('agent-a', 'task-c');

            expect(result.hasCycle).toBe(true);
            expect(result.cycleAgent).toBe('agent-a');
            expect(result.chain.map(c => c.agentId)).toEqual(['agent-a', 'agent-b', 'agent-c']);
        });

        it('should allow valid nested calls (no cycle)', () => {
            // Set up: agent-a → agent-b → agent-c
            tracker.registerCall({ taskId: 'task-a', agentId: 'agent-a', depth: 0, timestamp: Date.now() });
            tracker.registerCall({ taskId: 'task-b', agentId: 'agent-b', parentTaskId: 'task-a', depth: 1, timestamp: Date.now() });
            tracker.registerCall({ taskId: 'task-c', agentId: 'agent-c', parentTaskId: 'task-b', depth: 2, timestamp: Date.now() });

            // Check if agent-c can call agent-d (new agent, not in chain)
            const result = tracker.checkCircularDependency('agent-d', 'task-c');

            expect(result.hasCycle).toBe(false);
            expect(result.cycleAgent).toBeUndefined();
        });

        it('should allow sibling calls (A → B, A → C)', () => {
            // Set up: agent-a calls both agent-b and agent-c
            tracker.registerCall({ taskId: 'task-a', agentId: 'agent-a', depth: 0, timestamp: Date.now() });
            tracker.registerCall({ taskId: 'task-b', agentId: 'agent-b', parentTaskId: 'task-a', depth: 1, timestamp: Date.now() });

            // Check if agent-a can call agent-c (sibling, not descendant)
            const result = tracker.checkCircularDependency('agent-c', 'task-a');

            expect(result.hasCycle).toBe(false);
        });
    });

    describe('depth limiting', () => {
        it('should enforce max depth limit', () => {
            // Set up a chain at max depth
            for (let i = 0; i < 5; i++) {
                const taskId = `task-${i}`;
                const parentTaskId = i > 0 ? `task-${i - 1}` : undefined;
                tracker.registerCall({
                    taskId,
                    agentId: `agent-${i}`,
                    parentTaskId,
                    depth: i,
                    timestamp: Date.now()
                });
            }

            // Try to add one more (exceeds maxDepth=5)
            const result = tracker.checkCircularDependency('agent-5', 'task-4');

            expect(result.exceedsMaxDepth).toBe(true);
            expect(result.depth).toBe(5);
        });

        it('should allow calls within max depth', () => {
            // Set up a chain below max depth
            for (let i = 0; i < 3; i++) {
                const taskId = `task-${i}`;
                const parentTaskId = i > 0 ? `task-${i - 1}` : undefined;
                tracker.registerCall({
                    taskId,
                    agentId: `agent-${i}`,
                    parentTaskId,
                    depth: i,
                    timestamp: Date.now()
                });
            }

            // Try to add one more (still within maxDepth=5)
            const result = tracker.checkCircularDependency('agent-3', 'task-2');

            expect(result.exceedsMaxDepth).toBe(false);
            expect(result.depth).toBe(3);
        });

        it('should not enforce depth limit when disabled', () => {
            const deepTracker = new CallChainTracker({
                maxDepth: 5,
                enableDepthLimiting: false
            });

            // Set up a chain exceeding max depth
            for (let i = 0; i < 10; i++) {
                const taskId = `task-${i}`;
                const parentTaskId = i > 0 ? `task-${i - 1}` : undefined;
                deepTracker.registerCall({
                    taskId,
                    agentId: `agent-${i}`,
                    parentTaskId,
                    depth: i,
                    timestamp: Date.now()
                });
            }

            const result = deepTracker.checkCircularDependency('agent-10', 'task-9');

            expect(result.exceedsMaxDepth).toBe(false);
        });
    });

    describe('configuration options', () => {
        it('should disable cycle detection when configured', () => {
            const noCycleTracker = new CallChainTracker({
                enableCycleDetection: false,
                maxDepth: 5
            });

            noCycleTracker.registerCall({ taskId: 'task-a', agentId: 'agent-a', depth: 0, timestamp: Date.now() });
            noCycleTracker.registerCall({ taskId: 'task-b', agentId: 'agent-b', parentTaskId: 'task-a', depth: 1, timestamp: Date.now() });

            const result = noCycleTracker.checkCircularDependency('agent-a', 'task-b');

            expect(result.hasCycle).toBe(false);
        });

        it('should use custom max depth', () => {
            const customTracker = new CallChainTracker({
                maxDepth: 3
            });

            // Set up chain at depth 3
            for (let i = 0; i < 3; i++) {
                const taskId = `task-${i}`;
                const parentTaskId = i > 0 ? `task-${i - 1}` : undefined;
                customTracker.registerCall({
                    taskId,
                    agentId: `agent-${i}`,
                    parentTaskId,
                    depth: i,
                    timestamp: Date.now()
                });
            }

            const result = customTracker.checkCircularDependency('agent-3', 'task-2');

            expect(result.exceedsMaxDepth).toBe(true);
        });
    });

    describe('call chain formatting', () => {
        it('should format call chain for debugging', () => {
            tracker.registerCall({ taskId: 'root', agentId: 'orchestrator', depth: 0, timestamp: Date.now() });
            tracker.registerCall({ taskId: 'child', agentId: 'fetcher', parentTaskId: 'root', depth: 1, timestamp: Date.now() });
            tracker.registerCall({ taskId: 'grandchild', agentId: 'parser', parentTaskId: 'child', depth: 2, timestamp: Date.now() });

            const formatted = tracker.formatCallChain('grandchild');

            expect(formatted).toContain('orchestrator');
            expect(formatted).toContain('fetcher');
            expect(formatted).toContain('parser');
            expect(formatted).toContain('└─>');
        });

        it('should return empty message for no calls', () => {
            const formatted = tracker.formatCallChain('nonexistent');
            expect(formatted).toBe('(no calls)');
        });
    });

    describe('edge cases', () => {
        it('should handle checking with no parent task ID', () => {
            const result = tracker.checkCircularDependency('agent-a', undefined);

            expect(result.hasCycle).toBe(false);
            expect(result.depth).toBe(0);
        });

        it('should handle checking with non-existent parent', () => {
            const result = tracker.checkCircularDependency('agent-a', 'nonexistent-task');

            expect(result.hasCycle).toBe(false);
            expect(result.depth).toBe(0);
        });

        it('should handle multiple independent chains', () => {
            // Chain 1: a → b
            tracker.registerCall({ taskId: 'task-a', agentId: 'agent-a', depth: 0, timestamp: Date.now() });
            tracker.registerCall({ taskId: 'task-b', agentId: 'agent-b', parentTaskId: 'task-a', depth: 1, timestamp: Date.now() });

            // Chain 2: x → y (independent)
            tracker.registerCall({ taskId: 'task-x', agentId: 'agent-x', depth: 0, timestamp: Date.now() });
            tracker.registerCall({ taskId: 'task-y', agentId: 'agent-y', parentTaskId: 'task-x', depth: 1, timestamp: Date.now() });

            // Check from chain 1
            const result1 = tracker.checkCircularDependency('agent-a', 'task-b');
            expect(result1.hasCycle).toBe(true);

            // Check from chain 2
            const result2 = tracker.checkCircularDependency('agent-x', 'task-y');
            expect(result2.hasCycle).toBe(true);

            // But cross-chain calls are allowed
            const result3 = tracker.checkCircularDependency('agent-a', 'task-y');
            expect(result3.hasCycle).toBe(false);
        });
    });
});

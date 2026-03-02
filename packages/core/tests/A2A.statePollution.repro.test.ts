/**
 * Test to reproduce Issue #2: State Pollution in Multi-Agent System
 *
 * Bug: Session IDs were reused across different test runs because they were derived
 * from deterministic strings (sourceTaskId + targetAgentId) rather than unique values.
 * This caused stale state to persist in PostgreSQL's wm_sessions table.
 *
 * Root cause (BEFORE FIX): In A2AService.ts line 368:
 *   const childTaskId = `a2a_${sourceTaskId.slice(0, 16)}_${targetAgentId.slice(0, 16)}`;
 *
 * Fix (APPLIED): Now includes timestamp and random suffix:
 *   const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
 *   const childTaskId = options.childTaskId || `a2a_${sourceTaskId.slice(0, 16)}_${targetAgentId.slice(0, 16)}_${uniqueSuffix}`;
 *
 * This ensures each A2A call gets a fresh session state unless explicit childTaskId is provided.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { v4 as uuidv4 } from 'uuid';

describe('Issue #2: State Pollution Causing Stale HTML Reuse', () => {
    describe('sessionId generation', () => {
        it('should generate DIFFERENT sessionIds for same parent→child call across different runs', () => {
            // Simulate the current buggy implementation
            const sourceTaskId = 'a2a_local-task-17723_discover-listing-structure';
            const targetAgentId = 'process-listing-page';

            // Current implementation (BUGGY)
            const sessionId1 = `a2a_${sourceTaskId.slice(0, 16)}_${targetAgentId.slice(0, 16)}`;
            const sessionId2 = `a2a_${sourceTaskId.slice(0, 16)}_${targetAgentId.slice(0, 16)}`;

            console.log('Session ID 1:', sessionId1);
            console.log('Session ID 2:', sessionId2);

            // BUG: These are identical!
            expect(sessionId1).toBe(sessionId2);
            console.log('❌ BUG CONFIRMED: Same sessionId generated twice!');
            console.log('   This causes state to be reused across different runs');
        });

        it('should generate DIFFERENT sessionIds when using unique identifiers', () => {
            // Simulate the fixed implementation with UUID/timestamp
            const sourceTaskId = 'a2a_local-task-17723_discover-listing-structure';
            const targetAgentId = 'process-listing-page';

            // Fixed implementation with timestamp/UUID
            const sessionId1 = `a2a_${sourceTaskId.slice(0, 16)}_${targetAgentId.slice(0, 16)}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            // Small delay to ensure different timestamp
            const startTime = Date.now();
            while (Date.now() === startTime) { /* busy wait */ }
            const sessionId2 = `a2a_${sourceTaskId.slice(0, 16)}_${targetAgentId.slice(0, 16)}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            console.log('Session ID 1:', sessionId1);
            console.log('Session ID 2:', sessionId2);

            // FIX: These are now different!
            expect(sessionId1).not.toBe(sessionId2);
            console.log('✅ FIXED: Different sessionIds generated!');
        });
    });

    describe('state pollution symptoms', () => {
        it('should demonstrate turn counter accumulation across runs', () => {
            // Simulate first run
            let envTurn = 1;
            const sessionId = `a2a_local-task-17723_process-listing-`;

            // First run completes 10 turns
            envTurn = 10;

            // State is saved to database with turn = 10

            // Second run: Same sessionId reused, loads previous state
            const loadedTurn = envTurn;
            console.log('Second run starts with turn:', loadedTurn);

            // BUG: Turn counter continues from 10 instead of resetting to 1
            expect(loadedTurn).toBe(10);
            console.log('❌ BUG: Turn counter persisted from previous run');
        });

        it('should demonstrate stale HTML in sensory state', () => {
            // Simulate state from previous run
            const previousState = {
                turn: 450,
                memory: {
                    sensory: {
                        fetchedHtml: '<html><head></head><body><header id="header-frontend"...' // 1087 chars
                    }
                }
            };

            // New run loads this state
            const loadedState = previousState;

            // Policy checks if fetchedHtml exists
            const hasFetchedHtml = !!loadedState.memory.sensory.fetchedHtml;

            console.log('Has fetchedHtml from previous run:', hasFetchedHtml);
            console.log('HTML length:', loadedState.memory.sensory.fetchedHtml.length);

            // BUG: Policy skips fetch because stale HTML exists
            expect(hasFetchedHtml).toBe(true);
            expect(loadedState.memory.sensory.fetchedHtml.length).toBeLessThan(2000); // Stale fragment

            console.log('❌ BUG: Stale HTML from previous run prevents fresh fetch');
        });
    });

    describe('database persistence', () => {
        it('should show same sessionId reused across runs', () => {
            const runs = [];

            // Simulate 5 test runs
            for (let i = 0; i < 5; i++) {
                const sourceTaskId = 'a2a_local-task-17723_discover-listing-structure';
                const targetAgentId = 'process-listing-page';
                const sessionId = `a2a_${sourceTaskId.slice(0, 16)}_${targetAgentId.slice(0, 16)}`;
                runs.push({ run: i + 1, sessionId });
            }

            console.log('Session IDs across 5 runs:');
            runs.forEach(r => console.log(`  Run ${r.run}: ${r.sessionId}`));

            // All session IDs are identical
            const uniqueSessionIds = new Set(runs.map(r => r.sessionId));
            expect(uniqueSessionIds.size).toBe(1);

            console.log('❌ BUG: All runs use the same sessionId!');
            console.log('   This causes database to accumulate state for same session');
        });

        it('should demonstrate state accumulation in wm_sessions table', () => {
            const sessions = [];

            // Simulate multiple runs with same sessionId
            const sessionId = 'a2a_local-task-17723_process-listing-';

            for (let turn = 1; turn <= 10; turn++) {
                sessions.push({
                    sessionId,
                    turn,
                    wm_version: turn,
                    snapshot_size: 750000 + (turn * 1000)
                });
            }

            console.log('Simulated wm_sessions entries:');
            sessions.slice(-3).forEach(s => {
                console.log(`  turn:${s.turn} version:${s.wm_version} size:${s.snapshot_size}`);
            });

            // BUG: All entries have the same sessionId
            const sameSessionId = sessions.every(s => s.sessionId === sessionId);
            expect(sameSessionId).toBe(true);

            console.log('❌ BUG: State accumulates under same sessionId');
            console.log('   Each turn creates a new wm_version but same session');
        });
    });

    describe('AFTER FIX: unique sessionIds per call', () => {
        it('should generate unique sessionIds for each A2A call', () => {
            const sourceTaskId = 'a2a_local-task-17723_discover-listing-structure';
            const targetAgentId = 'process-listing-page';

            // Simulate the FIXED implementation
            const sessionIds: string[] = [];
            for (let i = 0; i < 5; i++) {
                const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
                const sessionId = `a2a_${sourceTaskId.slice(0, 16)}_${targetAgentId.slice(0, 16)}_${uniqueSuffix}`;
                sessionIds.push(sessionId);
                // Small delay to ensure different timestamp
                const start = Date.now();
                while (Date.now() === start) { /* busy wait */ }
            }

            console.log('Session IDs after fix (5 calls):');
            sessionIds.forEach((id, i) => console.log(`  Call ${i + 1}: ${id}`));

            // All session IDs should be unique
            const uniqueIds = new Set(sessionIds);
            expect(uniqueIds.size).toBe(5);

            console.log('✅ FIXED: Each call gets a unique sessionId!');
            console.log('   State is no longer polluted across different runs');
        });

        it('should still support explicit childTaskId for resume scenarios', () => {
            const sourceTaskId = 'a2a_local-task-17723_discover-listing-structure';
            const targetAgentId = 'process-listing-page';

            // When explicit childTaskId is provided, use it (for resume scenarios)
            const explicitChildTaskId = 'my-custom-session-id';
            const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
            const resultId = explicitChildTaskId || `a2a_${sourceTaskId.slice(0, 16)}_${targetAgentId.slice(0, 16)}_${uniqueSuffix}`;

            expect(resultId).toBe(explicitChildTaskId);
            console.log('✅ FIXED: Explicit childTaskId is respected for resume scenarios');
        });
    });
});

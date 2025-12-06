import { createAgent } from '@a2arium/callagent-core';
import type { ExecErrorPayload, ObservationConfig } from '@a2arium/callagent-core';

type MemoryDemoObservation = {
    input: unknown;
    time: string;
    attention: unknown;
};

// Loop-first implementation using top-level module sugar
export default createAgent<Record<string, unknown>, MemoryDemoObservation, unknown, unknown, ExecErrorPayload, ObservationConfig>({
    manifest: { name: 'memory-usage', version: '0.1.0', runMode: 'loop' },
    // Selects focus for this turn.
    // args: mentalState (agent state from previous turn), env (runtime input)
    // returns: attention signal consumed by perception
    attention: (_M: any, _env: any) => { console.log('[memory-usage] attention'); return { focus: 'memory-demo' }; },
    // Converts environment into an observation for this turn.
    // args: env (runner-provided input), attention (from attention)
    // returns: observation consumed by learning and policy
    perception: (env: any, attention: any) => {
        const userInput = env.inbox.current.find((o: any) => o.source === 'user' && o.kind === 'input.provided');
        return { input: userInput?.payload?.value, time: env.time, attention };
    },
    // Updates long-term memory with the latest observation.
    // args: prevMentalState (previous agent state), prevAction (action chosen last turn), obs (from perception)
    // returns: updated agent state
    learning: (prevMentalState: any) => prevMentalState,
    // Chooses the next action based on observation and state.
    // args: mentalState (current state after learning), prevMentalState (prior state), obs (from perception)
    // returns: action (e.g., ask_user | language | internal)
    policy: () => { console.log('[memory-usage] policy -> run_demo'); return { kind: 'run_demo' } as any; },
    // Optional policy-guard/safety layer to adjust or veto actions.
    // args: mentalState (current state), action (from policy)
    // returns: final action passed to execution
    shield: (_M: any, action: any) => ({ action: 'pass', intent: action }),
    // Performs side effects for the chosen action.
    // args: action (from shield), ctx (runner exec context with helpers)
    // returns: execution result consumed by transition
    execution: async (action: any, ctx: any) => {
        console.log('[memory-usage] execution start', action);
        const base = (status: 'ok' | 'error', payload?: { data?: unknown; error?: { code: string; message: string } }) => ({
            status,
            ts: Date.now(),
            toolId: 'memory-usage',
            data: payload?.data,
            error: payload?.error
        });
        if (action?.kind !== 'run_demo') {
            return {
                action: { kind: 'internal', done: true },
                result: base('ok', { data: { state: 'noop' } })
            } as any;
        }
        await ctx.progress({ state: 'working', timestamp: new Date().toISOString(), message: { role: 'agent', parts: [{ type: 'text', text: 'Running memory demo…' }] } } as any);

        await ctx.reply('🧠 Memory System Demo\n');

        try {
            // 1. Store some user data with entity alignment
            await ctx.reply('📝 Storing user data...');

            await ctx.semantic?.add({
                id: 'simple', value: {
                    name: 'John Smith'
                }, tags: ['user', 'employee']
            });

            await ctx.semantic?.add({
                id: 'user:001', value: {
                    name: 'John Smith',
                    email: 'john@example.com',
                    department: 'Engineering',
                    salary: 75000,
                    active: true
                }, tags: ['user', 'employee'], entities: { name: 'person', department: 'organization' }
            });

            await ctx.semantic?.add({
                id: 'user:002', value: {
                    name: 'J. Smith',  // Will align to "John Smith"
                    email: 'jane@company.org',
                    department: 'Engineering Dept',  // Will align to "Engineering"
                    salary: 82000,
                    active: true
                }, tags: ['user', 'employee'], entities: { name: 'person', department: 'organization' }
            });

            await ctx.semantic?.add({
                id: 'user:003', value: {
                    name: 'Bob Johnson',
                    email: 'bob@example.com',
                    department: 'Marketing',
                    salary: 65000,
                    active: false
                }, tags: ['user', 'employee'], entities: { name: 'person', department: 'organization' }
            });

            // Store event data with arrays for array filtering demonstrations
            await ctx.reply('🎪 Storing event data with arrays...');

            await ctx.semantic?.add({
                id: 'event:001', value: {
                    title: 'Tech Conference 2025',
                    city: 'Riga',
                    eventOccurences: [
                        { date: '2025-07-24', time: '09:00', priority: 9, status: 'confirmed' },
                        { date: '2025-07-25', time: '10:00', priority: 7, status: 'pending' }
                    ],
                    venue: { name: 'Conference Center', capacity: 500 },
                    speakers: [
                        { name: 'Dr. John Smith', expertise: 'AI', rating: 9.2 },
                        { name: 'Jane Doe', expertise: 'Machine Learning', rating: 8.8 }
                    ]
                }, tags: ['event', 'tech', 'riga']
            });

            await ctx.semantic?.add({
                id: 'event:002', value: {
                    title: 'Art Exhibition',
                    city: 'Riga',
                    eventOccurences: [
                        { date: '2025-07-24', time: '14:00', priority: 6, status: 'confirmed' },
                        { date: '2025-07-26', time: '15:00', priority: 5, status: 'cancelled' }
                    ],
                    venue: { name: 'Art Gallery', capacity: 200 },
                    speakers: [
                        { name: 'Maria Gonzalez', expertise: 'Contemporary Art', rating: 9.0 }
                    ]
                }, tags: ['event', 'art', 'riga']
            });

            await ctx.semantic?.add({
                id: 'event:003', value: {
                    title: 'Music Festival',
                    city: 'Tallinn',
                    eventOccurences: [
                        { date: '2025-07-26', time: '18:00', priority: 8, status: 'confirmed' },
                        { date: '2025-07-27', time: '19:00', priority: 9, status: 'confirmed' }
                    ],
                    venue: { name: 'Outdoor Stage', capacity: 1000 },
                    speakers: [
                        { name: 'Rock Band A', expertise: 'Rock Music', rating: 8.5 },
                        { name: 'DJ Cool', expertise: 'Electronic Music', rating: 9.1 }
                    ]
                }, tags: ['event', 'music', 'tallinn']
            });

            // 2. Pattern matching with wildcards
            await ctx.reply('🔍 Pattern matching with wildcards...');
            const allUsers = await ctx.semantic!.read({ id: 'user:*' } as any);
            await ctx.reply(`Found ${allUsers.length} users with pattern 'user:*'`);

            // 3. String-based filter operators
            await ctx.reply('🎯 Using string-based filters...');

            // High salary employees
            const highEarners = await ctx.semantic.read({ filters: ['salary > 70000'] as any });
            await ctx.reply(`High earners (>70k): ${highEarners.length} users`);

            // Active engineering employees
            const activeEngineers = await ctx.semantic.read({
                filters: [
                    'active = true',
                    'department contains "Engineering"'
                ] as any
            });
            await ctx.reply(`Active engineers: ${activeEngineers.length} users`);

            // Email domain search
            const exampleEmails = await ctx.semantic.read({ filters: ['email ends_with "@example.com"'] as any });
            await ctx.reply(`@example.com emails: ${exampleEmails.length} users`);

            // 4. Array filtering demonstrations
            await ctx.reply('🎯 Array filtering examples...');

            // ✅ Array filtering with equality
            const todayEvents = await ctx.semantic.read({ filters: ['eventOccurences[].date = "2025-07-24"'] as any });
            await ctx.reply(`Events on 2025-07-24: ${todayEvents.length} events`);

            // ✅ Array filtering with comparison
            const highPriorityEvents = await ctx.semantic.read({ filters: ['eventOccurences[].priority >= 8'] as any });
            await ctx.reply(`High priority events (>=8): ${highPriorityEvents.length} events`);

            // ✅ Array filtering with string operations
            const morningEvents = await ctx.semantic.read({ filters: ['eventOccurences[].time starts_with "09"'] as any });
            await ctx.reply(`Morning events (starting at 09): ${morningEvents.length} events`);

            // ✅ Nested object array filtering
            const aiExperts = await ctx.semantic.read({ filters: ['speakers[].expertise contains "AI"'] as any });
            await ctx.reply(`Events with AI experts: ${aiExperts.length} events`);

            // ✅ Array filtering with rating comparison
            const topRatedSpeakers = await ctx.semantic.read({ filters: ['speakers[].rating >= 9.0'] as any });
            await ctx.reply(`Events with top-rated speakers (>=9.0): ${topRatedSpeakers.length} events`);

            // ✅ Combined array and regular filtering
            const rigaTodayEvents = await ctx.semantic.read({
                filters: [
                    'eventOccurences[].date = "2025-07-24"',
                    'city = "Riga"'
                ] as any
            });
            await ctx.reply(`Riga events on 2025-07-24: ${rigaTodayEvents.length} events`);

            // ✅ Combined array and tag filtering
            const techTodayEvents = await ctx.semantic.read({ tag: 'tech', filters: ['eventOccurences[].date = "2025-07-24"'] as any });
            await ctx.reply(`Tech events on 2025-07-24: ${techTodayEvents.length} events`);

            // ✅ Multiple array filters
            const complexEvents = await ctx.semantic.read({
                filters: [
                    'eventOccurences[].priority >= 8',
                    'speakers[].rating >= 9.0'
                ] as any
            });
            await ctx.reply(`High priority events with top speakers: ${complexEvents.length} events`);

            // 5. Show entity alignment results
            const user2Arr = await ctx.semantic?.read?.({ id: 'user:002', limit: 1 });
            const user2 = Array.isArray(user2Arr) && user2Arr[0] ? (user2Arr[0] as any).value : undefined;
            let alignmentResults = [];

            if (user2?.name?._wasAligned) {
                alignmentResults.push(`Name: "${user2.name._original}" → "${user2.name._canonical}"`);
            }
            if (user2?.department?._wasAligned) {
                alignmentResults.push(`Dept: "${user2.department._original}" → "${user2.department._canonical}"`);
            }

            await ctx.reply([
                '✅ Demo complete!',
                '',
                '🎯 Entity Alignments:',
                ...alignmentResults,
                '',
                '📊 Regular Filtering Summary:',
                `• Pattern matching: Found ${allUsers.length} users`,
                `• High earners: ${highEarners.length} users`,
                `• Active engineers: ${activeEngineers.length} users`,
                `• @example.com: ${exampleEmails.length} users`,
                '',
                '🎯 Array Filtering Summary:',
                `• Events on 2025-07-24: ${todayEvents.length} events`,
                `• High priority events: ${highPriorityEvents.length} events`,
                `• Morning events: ${morningEvents.length} events`,
                `• AI expert events: ${aiExperts.length} events`,
                `• Top-rated speaker events: ${topRatedSpeakers.length} events`,
                `• Riga events today: ${rigaTodayEvents.length} events`,
                `• Tech events today: ${techTodayEvents.length} events`,
                `• Complex filtered events: ${complexEvents.length} events`
            ].join('\n'));
            console.log('[memory-usage] execution done');
            return {
                action: { kind: 'internal', done: true },
                result: base('ok', { data: { state: 'done' } })
            } as any;
        } catch (error: any) {
            console.error('[memory-usage] error:', error);
            await ctx.reply(`❌ Error running memory demo: ${error?.message || error}`);
            return {
                action: { kind: 'internal', done: true },
                result: base('error', { error: { code: 'memory_usage_error', message: error?.message || 'unknown' } })
            } as any;
        }
    },

    // Maps execution result to loop control flow.
    // args: env (current environment input), executionResult
    // returns: loop state (await_input | complete | continue)
    transition: (_env: any, exec: any) => {
        const status = exec?.result?.status || exec?.status;
        if (status === 'error') return { kind: 'fail', reason: exec?.result?.error?.message || 'unknown_error' } as any;
        if (status === 'ok' && exec?.result?.data?.state === 'done') return { kind: 'complete', result: 'ok' } as any;
        return { kind: 'continue', observations: [] } as any;
    }
}, import.meta.url);

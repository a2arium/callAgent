import { createAgent } from '@a2arium/callagent-core';

export default createAgent({
    async handleTask(ctx) {
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
            const allUsers = await ctx.memory.semantic.getMany('user:*');
            await ctx.reply(`Found ${allUsers.length} users with pattern 'user:*'`);

            // 3. String-based filter operators
            await ctx.reply('🎯 Using string-based filters...');

            // High salary employees
            const highEarners = await ctx.memory.semantic.getMany({
                filters: ['salary > 70000']
            });
            await ctx.reply(`High earners (>70k): ${highEarners.length} users`);

            // Active engineering employees
            const activeEngineers = await ctx.memory.semantic.getMany({
                filters: [
                    'active = true',
                    'department contains "Engineering"'
                ]
            });
            await ctx.reply(`Active engineers: ${activeEngineers.length} users`);

            // Email domain search
            const exampleEmails = await ctx.memory.semantic.getMany({
                filters: ['email ends_with "@example.com"']
            });
            await ctx.reply(`@example.com emails: ${exampleEmails.length} users`);

            // 4. Array filtering demonstrations
            await ctx.reply('🎯 Array filtering examples...');

            // ✅ Array filtering with equality
            const todayEvents = await ctx.memory.semantic.getMany({
                filters: ['eventOccurences[].date = "2025-07-24"']
            });
            await ctx.reply(`Events on 2025-07-24: ${todayEvents.length} events`);

            // ✅ Array filtering with comparison
            const highPriorityEvents = await ctx.memory.semantic.getMany({
                filters: ['eventOccurences[].priority >= 8']
            });
            await ctx.reply(`High priority events (>=8): ${highPriorityEvents.length} events`);

            // ✅ Array filtering with string operations
            const morningEvents = await ctx.memory.semantic.getMany({
                filters: ['eventOccurences[].time starts_with "09"']
            });
            await ctx.reply(`Morning events (starting at 09): ${morningEvents.length} events`);

            // ✅ Nested object array filtering
            const aiExperts = await ctx.memory.semantic.getMany({
                filters: ['speakers[].expertise contains "AI"']
            });
            await ctx.reply(`Events with AI experts: ${aiExperts.length} events`);

            // ✅ Array filtering with rating comparison
            const topRatedSpeakers = await ctx.memory.semantic.getMany({
                filters: ['speakers[].rating >= 9.0']
            });
            await ctx.reply(`Events with top-rated speakers (>=9.0): ${topRatedSpeakers.length} events`);

            // ✅ Combined array and regular filtering
            const rigaTodayEvents = await ctx.memory.semantic.getMany({
                filters: [
                    'eventOccurences[].date = "2025-07-24"',
                    'city = "Riga"'
                ]
            });
            await ctx.reply(`Riga events on 2025-07-24: ${rigaTodayEvents.length} events`);

            // ✅ Combined array and tag filtering
            const techTodayEvents = await ctx.memory.semantic.getMany({
                tag: 'tech',
                filters: ['eventOccurences[].date = "2025-07-24"']
            });
            await ctx.reply(`Tech events on 2025-07-24: ${techTodayEvents.length} events`);

            // ✅ Multiple array filters
            const complexEvents = await ctx.memory.semantic.getMany({
                filters: [
                    'eventOccurences[].priority >= 8',
                    'speakers[].rating >= 9.0'
                ]
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

        } catch (error: any) {
            await ctx.reply(`❌ Error: ${error.message}`);
        }

        ctx.complete();
    },
}, import.meta.url); 
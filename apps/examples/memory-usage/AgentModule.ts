import { createAgent } from '@callagent/core';

export default createAgent({
    async handleTask(ctx) {
        await ctx.reply('🧠 Memory System Demo\n');

        try {
            // 1. Store some user data with entity alignment
            await ctx.reply('📝 Storing user data...');

            await ctx.memory.semantic.set('user:001', {
                name: 'John Smith',
                email: 'john@example.com',
                department: 'Engineering',
                salary: 75000,
                active: true
            }, {
                tags: ['user', 'employee'],
                entities: { name: 'person', department: 'organization' }
            });

            await ctx.memory.semantic.set('user:002', {
                name: 'J. Smith',  // Will align to "John Smith"
                email: 'jane@company.org',
                department: 'Engineering Dept',  // Will align to "Engineering"
                salary: 82000,
                active: true
            }, {
                tags: ['user', 'employee'],
                entities: { name: 'person', department: 'organization' }
            });

            await ctx.memory.semantic.set('user:003', {
                name: 'Bob Johnson',
                email: 'bob@example.com',
                department: 'Marketing',
                salary: 65000,
                active: false
            }, {
                tags: ['user', 'employee'],
                entities: { name: 'person', department: 'organization' }
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

            // 4. Show entity alignment results
            const user2 = await ctx.memory.semantic.get('user:002') as any;
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
                '📊 Summary:',
                `• Pattern matching: Found ${allUsers.length} users`,
                `• High earners: ${highEarners.length} users`,
                `• Active engineers: ${activeEngineers.length} users`,
                `• @example.com: ${exampleEmails.length} users`
            ].join('\n'));

        } catch (error: any) {
            await ctx.reply(`❌ Error: ${error.message}`);
        }

        ctx.complete();
    },
}, import.meta.url); 
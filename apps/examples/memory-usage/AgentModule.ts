import { createAgent } from '@callagent/core';

export default createAgent({
    async handleTask(ctx) {
        // Store structured data with meaningful keys for pattern matching
        await ctx.memory.semantic.set('user:123:profile', { name: 'John Doe', email: 'john@example.com', status: 'active' }, { tags: ['user', 'profile'] });
        await ctx.memory.semantic.set('user:123:preferences', { theme: 'dark', language: 'en' }, { tags: ['user', 'preferences'] });
        await ctx.memory.semantic.set('user:456:profile', { name: 'Jane Smith', email: 'jane@example.com', status: 'active' }, { tags: ['user', 'profile'] });
        await ctx.memory.semantic.set('user:456:preferences', { theme: 'light', language: 'es' }, { tags: ['user', 'preferences'] });
        await ctx.memory.semantic.set('admin:789:profile', { name: 'Admin User', email: 'admin@example.com', status: 'active' }, { tags: ['admin', 'profile'] });
        await ctx.memory.semantic.set('config:app:database', { host: 'localhost', port: 5432 }, { tags: ['config'] });

        // Original functionality demonstrations
        const value = await ctx.memory.semantic.get('user:123:profile');
        const results = await ctx.memory.semantic.query({ tag: 'profile' });
        const filtered = await ctx.memory.semantic.query({ filters: [{ path: 'status', operator: '=', value: 'active' }] });

        // Access the underlying SQL adapter for pattern matching (if available)
        const sqlBackend = (ctx.memory.semantic as any).backends?.sql;
        let patternResults = 'Pattern matching not available (requires MemorySQLAdapter)';
        let advancedPatternResults = 'Advanced pattern matching not available (requires MemorySQLAdapter)';

        if (sqlBackend && typeof sqlBackend.queryByKeyPattern === 'function') {
            try {
                // Pattern matching examples
                const userProfiles = await sqlBackend.queryByKeyPattern('user:*:profile');
                const user123Data = await sqlBackend.queryByKeyPattern('user:123:*');
                const configEntries = await sqlBackend.queryByKeyPattern('config:*');

                patternResults = [
                    `User profiles (user:*:profile): ${JSON.stringify(userProfiles)}`,
                    `User 123 data (user:123:*): ${JSON.stringify(user123Data)}`,
                    `Config entries (config:*): ${JSON.stringify(configEntries)}`
                ].join('\n    ');

                // Advanced pattern matching with single character wildcards
                if (typeof sqlBackend.queryByKeyPatternAdvanced === 'function') {
                    const advancedPattern = await sqlBackend.queryByKeyPatternAdvanced('user:???:*');
                    advancedPatternResults = `Advanced pattern (user:???:*): ${JSON.stringify(advancedPattern)}`;
                }
            } catch (error: any) {
                patternResults = `Pattern matching error: ${error.message}`;
            }
        }

        await ctx.reply([
            '=== Memory Usage Examples ===',
            '',
            '1. Basic Operations:',
            `   Get user:123:profile: ${JSON.stringify(value)}`,
            `   Query by tag "profile": Found ${results.length} entries`,
            `   Query by filter (status=active): Found ${filtered.length} entries`,
            '',
            '2. Pattern Matching (Key Wildcards):',
            `   ${patternResults}`,
            '',
            '3. Advanced Pattern Matching:',
            `   ${advancedPatternResults}`,
            '',
            '=== Alternative: Using Tags ===',
            'For most use cases, consider using tags instead of key patterns:',
            '- More portable across different memory backends',
            '- Better performance in many cases',
            '- More explicit and maintainable',
            '',
            `Example: Query by tag "user": Found ${await ctx.memory.semantic.query({ tag: 'user' }).then(r => r.length)} entries`
        ].join('\n'));

        ctx.complete();
    },
}, import.meta.url); 
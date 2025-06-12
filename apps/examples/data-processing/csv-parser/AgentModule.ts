import { createAgent } from '@callagent/core';

type CsvParseTask = {
    csvData: string;
    delimiter?: string;
};

type CsvParseResult = {
    headers: string[];
    rows: string[][];
    rowCount: number;
};

export default createAgent({
    manifest: {
        name: 'data-processing/csv-parser',
        version: '1.0.0',
        description: 'Parses CSV data into structured format'
    },
    async handleTask(ctx) {
        const { csvData, delimiter = ',' } = ctx.task.input as CsvParseTask;

        await ctx.reply(`📊 CSV Parser: Starting to parse CSV data with delimiter '${delimiter}'`);

        try {
            const lines = csvData.trim().split('\n');
            if (lines.length === 0) {
                throw new Error('Empty CSV data provided');
            }

            // Parse headers
            const headers = lines[0].split(delimiter).map(h => h.trim());
            await ctx.reply(`📊 CSV Parser: Found ${headers.length} columns: ${headers.join(', ')}`);

            // Parse data rows
            const rows: string[][] = [];
            for (let i = 1; i < lines.length; i++) {
                const row = lines[i].split(delimiter).map(cell => cell.trim());
                if (row.length === headers.length) {
                    rows.push(row);
                } else {
                    await ctx.reply(`⚠️ CSV Parser: Skipping malformed row ${i + 1} (expected ${headers.length} columns, got ${row.length})`);
                }
            }

            const result: CsvParseResult = {
                headers,
                rows,
                rowCount: rows.length
            };

            await ctx.reply(`✅ CSV Parser: Successfully parsed ${rows.length} rows`);
            return result;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            await ctx.reply(`❌ CSV Parser: Error - ${errorMessage}`);
            throw error;
        }
    }
}, import.meta.url); 
import { createAgent } from '@callagent/core';

type DataAnalysisTask = {
    csvData: string;
    analysisType: 'summary' | 'statistics' | 'validation';
};

type DataAnalysisResult = {
    analysisType: string;
    summary: {
        totalRows: number;
        totalColumns: number;
        columnNames: string[];
    };
    statistics?: {
        numericColumns: string[];
        textColumns: string[];
        emptyValues: number;
    };
    validation?: {
        isValid: boolean;
        errors: string[];
    };
};

export default createAgent({
    manifest: {
        name: 'business-logic/data-analyzer',
        version: '1.0.0',
        description: 'Analyzes CSV data using the CSV parser agent',
        dependencies: {
            agents: ['data-processing/csv-parser']
        }
    },
    async handleTask(ctx) {
        const { csvData, analysisType } = ctx.task.input as DataAnalysisTask;

        await ctx.reply(`🔍 Data Analyzer: Starting ${analysisType} analysis`);

        try {
            // First, parse the CSV data using the CSV parser agent
            await ctx.reply(`🔍 Data Analyzer: Delegating CSV parsing to data-processing/csv-parser`);

            const parseResult = await ctx.sendTaskToAgent('data-processing/csv-parser', {
                csvData,
                delimiter: ','
            }) as {
                headers: string[];
                rows: string[][];
                rowCount: number;
            };

            const { headers, rows, rowCount } = parseResult;

            await ctx.reply(`🔍 Data Analyzer: Received parsed data with ${rowCount} rows and ${headers.length} columns`);

            // Build basic summary
            const summary = {
                totalRows: rowCount,
                totalColumns: headers.length,
                columnNames: headers
            };

            const result: DataAnalysisResult = {
                analysisType,
                summary
            };

            // Perform specific analysis based on type
            if (analysisType === 'statistics') {
                const numericColumns: string[] = [];
                const textColumns: string[] = [];
                let emptyValues = 0;

                // Analyze each column
                for (let colIndex = 0; colIndex < headers.length; colIndex++) {
                    const columnName = headers[colIndex];
                    let isNumeric = true;

                    for (const row of rows) {
                        const value = row[colIndex];
                        if (!value || value.trim() === '') {
                            emptyValues++;
                        } else if (isNaN(Number(value))) {
                            isNumeric = false;
                        }
                    }

                    if (isNumeric) {
                        numericColumns.push(columnName);
                    } else {
                        textColumns.push(columnName);
                    }
                }

                result.statistics = {
                    numericColumns,
                    textColumns,
                    emptyValues
                };

                await ctx.reply(`📊 Data Analyzer: Found ${numericColumns.length} numeric and ${textColumns.length} text columns`);

            } else if (analysisType === 'validation') {
                const errors: string[] = [];

                // Basic validation checks
                if (rowCount === 0) {
                    errors.push('No data rows found');
                }

                if (headers.length === 0) {
                    errors.push('No column headers found');
                }

                // Check for duplicate headers
                const uniqueHeaders = new Set(headers);
                if (uniqueHeaders.size !== headers.length) {
                    errors.push('Duplicate column headers detected');
                }

                result.validation = {
                    isValid: errors.length === 0,
                    errors
                };

                await ctx.reply(`✅ Data Analyzer: Validation ${result.validation.isValid ? 'passed' : 'failed'}`);
            }

            await ctx.reply(`✅ Data Analyzer: ${analysisType} analysis completed`);
            return result;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            await ctx.reply(`❌ Data Analyzer: Error - ${errorMessage}`);
            throw error;
        }
    }
}, import.meta.url); 
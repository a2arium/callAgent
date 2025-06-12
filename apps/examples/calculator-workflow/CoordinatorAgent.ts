import { createAgent } from '@callagent/core';

type CalculationTask = {
    expression: string;
};

type CalculationResult = {
    result: number;
    steps: string[];
    expression: string;
};

async function evaluateExpression(expression: string, ctx: any, steps: string[]): Promise<number> {
    // Simple expression parser - handles multiplication/division first, then addition/subtraction
    steps.push(`Calculator Workflow: Parsing expression "${expression}"`);

    // First, handle multiplication and division
    const tokens = tokenize(expression);
    const processedTokens = await processMulDiv(tokens, ctx, steps);

    // Then handle addition and subtraction
    const result = await processAddSub(processedTokens, ctx, steps);

    return result;
}

function tokenize(expression: string): (number | string)[] {
    // Simple tokenizer for basic math expressions
    const tokens: (number | string)[] = [];
    let current = '';

    for (const char of expression.replace(/\s+/g, '')) {
        if (['+', '-', '*', '/'].includes(char)) {
            if (current) {
                tokens.push(parseFloat(current));
                current = '';
            }
            tokens.push(char);
        } else {
            current += char;
        }
    }

    if (current) {
        tokens.push(parseFloat(current));
    }

    return tokens;
}

async function processMulDiv(tokens: (number | string)[], ctx: any, steps: string[]): Promise<(number | string)[]> {
    const result: (number | string)[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (token === '*' || token === '/') {
            const left = result.pop() as number;
            const right = tokens[i + 1] as number;
            const operation = token as string;

            // Delegate to multiplication agent
            const mulResult = await ctx.sendTaskToAgent('multiplication-agent', {
                operation,
                left,
                right,
                expression: `${left} ${operation} ${right}`
            });

            result.push(mulResult.result);
            steps.push(`Calculator Workflow: ${left} ${operation} ${right} = ${mulResult.result} (via multiplication-agent)`);
            i++; // Skip the right operand
        } else {
            result.push(token);
        }
    }

    return result;
}

async function processAddSub(tokens: (number | string)[], ctx: any, steps: string[]): Promise<number> {
    if (tokens.length === 1) {
        return tokens[0] as number;
    }

    // Delegate to arithmetic agent for addition/subtraction
    const addSubResult = await ctx.sendTaskToAgent('arithmetic-agent', {
        expression: tokens.join(' '),
        tokens
    });

    steps.push(`Calculator Workflow: Addition/subtraction delegated to arithmetic-agent`);
    return addSubResult.result;
}

export default createAgent({
    manifest: {
        name: 'calculator-workflow',
        version: '1.0.0',
        description: 'Coordinates mathematical expression evaluation by delegating to specialist agents',
        dependencies: {
            agents: ['arithmetic-agent', 'multiplication-agent']
        }
    },
    async handleTask(ctx) {
        const { expression } = ctx.task.input as CalculationTask;

        await ctx.reply(`🧮 Calculator Workflow: Starting calculation for "${expression}"`);

        const steps: string[] = [];
        let currentExpression = expression.trim();

        try {
            // Parse and evaluate the expression by delegating to specialist agents
            const result = await evaluateExpression(currentExpression, ctx, steps);

            const response: CalculationResult = {
                result,
                steps,
                expression
            };

            await ctx.reply(`🧮 Calculator Workflow: Final result = ${result}`);
            return response;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            await ctx.reply(`❌ Calculator Workflow: Error - ${errorMessage}`);
            throw error;
        }
    }
}, import.meta.url); 
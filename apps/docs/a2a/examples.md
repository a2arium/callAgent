# A2A Examples

This document provides comprehensive examples of A2A (Agent-to-Agent) communication patterns and real-world use cases.

## Table of Contents

1. [Basic Examples](#basic-examples)
2. [Memory Transfer Examples](#memory-transfer-examples)
3. [Workflow Patterns](#workflow-patterns)
4. [Error Handling Examples](#error-handling-examples)
5. [Real-World Use Cases](#real-world-use-cases)

## Basic Examples

### Simple Agent Delegation

The most basic A2A pattern - one agent calling another.

```typescript
// MathCoordinator.ts
import { createAgent } from '@callagent/core';

export default createAgent({
  manifest: {
    name: 'math-coordinator',
    version: '1.0.0',
    description: 'Coordinates mathematical operations'
  },

  async handleTask(ctx) {
    const input = ctx.task.input as { operation: string; numbers: number[] };
    
    // Delegate to specialist calculator
    const result = await ctx.sendTaskToAgent?.('calculator', {
      operation: input.operation,
      values: input.numbers
    });

    return {
      coordinator: 'math-coordinator',
      delegatedTo: 'calculator',
      result: result
    };
  }
}, import.meta.url);

// Calculator.ts
export default createAgent({
  manifest: {
    name: 'calculator',
    version: '1.0.0',
    description: 'Performs mathematical calculations'
  },

  async handleTask(ctx) {
    const input = ctx.task.input as { operation: string; values: number[] };
    
    let result: number;
    switch (input.operation) {
      case 'sum':
        result = input.values.reduce((a, b) => a + b, 0);
        break;
      case 'multiply':
        result = input.values.reduce((a, b) => a * b, 1);
        break;
      case 'average':
        result = input.values.reduce((a, b) => a + b, 0) / input.values.length;
        break;
      default:
        throw new Error(`Unknown operation: ${input.operation}`);
    }

    return {
      operation: input.operation,
      values: input.values,
      result: result
    };
  }
}, import.meta.url);
```

### Agent Registration and Usage

```typescript
// demo.ts
import { PluginManager, runAgentWithStreaming } from '@callagent/core';
import MathCoordinator from './MathCoordinator.js';
import Calculator from './Calculator.js';

// Register agents
PluginManager.registerAgent(MathCoordinator);
PluginManager.registerAgent(Calculator);

// Run the coordinator
const result = await runAgentWithStreaming('./MathCoordinator.js', {
  operation: 'sum',
  numbers: [1, 2, 3, 4, 5]
});

console.log('Result:', result);
// Output: { coordinator: 'math-coordinator', delegatedTo: 'calculator', result: { operation: 'sum', values: [1,2,3,4,5], result: 15 } }
```

## Memory Transfer Examples

### Working Memory Inheritance

Transfer goals, thoughts, and variables between agents.

```typescript
// ProjectManager.ts
export default createAgent({
  manifest: {
    name: 'project-manager',
    version: '1.0.0',
    description: 'Manages project workflows'
  },

  async handleTask(ctx) {
    const input = ctx.task.input as { projectId: string; phase: string };
    
    // Set up project context
    await ctx.setGoal?.(`Complete ${input.phase} phase for project ${input.projectId}`);
    await ctx.addThought?.('Initializing project workflow');
    
    // Store project metadata in variables
    ctx.vars!.projectId = input.projectId;
    ctx.vars!.phase = input.phase;
    ctx.vars!.startTime = new Date().toISOString();
    ctx.vars!.priority = 'high';

    // Delegate to development team with context inheritance
    const devResult = await ctx.sendTaskToAgent?.('development-team', {
      requirements: ['feature-a', 'feature-b', 'feature-c']
    }, {
      inheritWorkingMemory: true  // Team inherits goal, thoughts, and variables
    });

    await ctx.addThought?.('Development phase completed');

    // Delegate to QA team with updated context
    const qaResult = await ctx.sendTaskToAgent?.('qa-team', {
      buildArtifacts: devResult.artifacts
    }, {
      inheritWorkingMemory: true
    });

    return {
      projectId: input.projectId,
      phase: input.phase,
      development: devResult,
      qa: qaResult,
      status: 'completed'
    };
  }
}, import.meta.url);

// DevelopmentTeam.ts
export default createAgent({
  manifest: {
    name: 'development-team',
    version: '1.0.0',
    description: 'Handles software development tasks'
  },

  async handleTask(ctx) {
    // Access inherited context
    const inheritedGoal = await ctx.getGoal?.();
    const projectId = ctx.vars?.projectId;
    const priority = ctx.vars?.priority;
    
    await ctx.addThought?.(`Development team activated for project ${projectId}`);
    await ctx.addThought?.(`Working on goal: ${inheritedGoal}`);
    await ctx.addThought?.(`Priority level: ${priority}`);

    const input = ctx.task.input as { requirements: string[] };
    
    // Simulate development work
    const artifacts = input.requirements.map(req => ({
      requirement: req,
      implementation: `${req}-implementation.js`,
      tests: `${req}-tests.js`,
      status: 'completed'
    }));

    // Update working memory
    ctx.vars!.developmentCompleted = new Date().toISOString();
    ctx.vars!.artifactCount = artifacts.length;

    return {
      team: 'development-team',
      projectId: projectId,
      artifacts: artifacts,
      completedAt: ctx.vars!.developmentCompleted
    };
  }
}, import.meta.url);
```

### Long-Term Memory Sharing

Share semantic and episodic memory between agents.

```typescript
// ResearchCoordinator.ts
export default createAgent({
  manifest: {
    name: 'research-coordinator',
    version: '1.0.0',
    description: 'Coordinates research activities'
  },

  async handleTask(ctx) {
    const input = ctx.task.input as { topic: string; depth: string };
    
    // Store research context in semantic memory
    await ctx.remember?.('research-context', {
      topic: input.topic,
      depth: input.depth,
      startedAt: new Date().toISOString(),
      methodology: 'systematic-review'
    });

    // Store research guidelines
    await ctx.remember?.('research-guidelines', {
      qualityCriteria: ['peer-reviewed', 'recent', 'relevant'],
      sources: ['academic-papers', 'industry-reports', 'expert-interviews'],
      biasConsiderations: ['selection-bias', 'confirmation-bias']
    });

    // Delegate to literature review specialist with memory access
    const literatureResult = await ctx.sendTaskToAgent?.('literature-reviewer', {
      topic: input.topic,
      timeframe: '2020-2024'
    }, {
      inheritMemory: true  // Reviewer can access research context and guidelines
    });

    // Delegate to data analyst with accumulated knowledge
    const analysisResult = await ctx.sendTaskToAgent?.('data-analyst', {
      literatureFindings: literatureResult.findings,
      analysisType: 'meta-analysis'
    }, {
      inheritMemory: true  // Analyst has access to all previous research context
    });

    return {
      topic: input.topic,
      literature: literatureResult,
      analysis: analysisResult,
      status: 'completed'
    };
  }
}, import.meta.url);

// LiteratureReviewer.ts
export default createAgent({
  manifest: {
    name: 'literature-reviewer',
    version: '1.0.0',
    description: 'Conducts systematic literature reviews'
  },

  async handleTask(ctx) {
    // Access inherited research context
    const researchContext = await ctx.recall?.('research-context');
    const guidelines = await ctx.recall?.('research-guidelines');
    
    console.log('Research context:', researchContext);
    console.log('Guidelines:', guidelines);

    const input = ctx.task.input as { topic: string; timeframe: string };
    
    // Simulate literature review using inherited guidelines
    const findings = [
      {
        title: `${input.topic} in Modern Context`,
        authors: ['Smith, J.', 'Doe, A.'],
        year: 2023,
        relevance: 0.95,
        quality: 'high'
      },
      {
        title: `Advances in ${input.topic}`,
        authors: ['Johnson, B.'],
        year: 2022,
        relevance: 0.87,
        quality: 'medium'
      }
    ];

    // Store findings in memory for future reference
    await ctx.remember?.('literature-findings', {
      topic: input.topic,
      timeframe: input.timeframe,
      findings: findings,
      reviewedAt: new Date().toISOString()
    });

    return {
      reviewer: 'literature-reviewer',
      topic: input.topic,
      findingsCount: findings.length,
      findings: findings
    };
  }
}, import.meta.url);
```

## Workflow Patterns

### Sequential Pipeline

Agents process data in sequence, each building on the previous result.

```typescript
// DataPipeline.ts
export default createAgent({
  manifest: {
    name: 'data-pipeline',
    version: '1.0.0',
    description: 'Orchestrates data processing pipeline'
  },

  async handleTask(ctx) {
    const input = ctx.task.input as { dataSource: string; outputFormat: string };
    
    await ctx.setGoal?.(`Process data from ${input.dataSource} to ${input.outputFormat}`);
    ctx.vars!.pipelineId = `pipeline-${Date.now()}`;
    ctx.vars!.startTime = new Date().toISOString();

    // Stage 1: Data Extraction
    await ctx.addThought?.('Starting data extraction phase');
    const extractedData = await ctx.sendTaskToAgent?.('data-extractor', {
      source: input.dataSource,
      format: 'raw'
    }, { inheritWorkingMemory: true });

    // Stage 2: Data Cleaning
    await ctx.addThought?.('Starting data cleaning phase');
    const cleanedData = await ctx.sendTaskToAgent?.('data-cleaner', {
      rawData: extractedData.data,
      cleaningRules: ['remove-nulls', 'normalize-dates', 'validate-types']
    }, { inheritWorkingMemory: true });

    // Stage 3: Data Transformation
    await ctx.addThought?.('Starting data transformation phase');
    const transformedData = await ctx.sendTaskToAgent?.('data-transformer', {
      cleanData: cleanedData.data,
      targetSchema: input.outputFormat
    }, { inheritWorkingMemory: true });

    // Stage 4: Data Validation
    await ctx.addThought?.('Starting data validation phase');
    const validationResult = await ctx.sendTaskToAgent?.('data-validator', {
      transformedData: transformedData.data,
      validationRules: ['schema-compliance', 'data-integrity']
    }, { inheritWorkingMemory: true });

    ctx.vars!.endTime = new Date().toISOString();
    await ctx.addThought?.('Pipeline completed successfully');

    return {
      pipelineId: ctx.vars!.pipelineId,
      stages: ['extraction', 'cleaning', 'transformation', 'validation'],
      results: {
        extracted: extractedData,
        cleaned: cleanedData,
        transformed: transformedData,
        validated: validationResult
      },
      timing: {
        start: ctx.vars!.startTime,
        end: ctx.vars!.endTime
      }
    };
  }
}, import.meta.url);
```

### Parallel Processing

Multiple agents work on different aspects simultaneously.

```typescript
// ParallelProcessor.ts
export default createAgent({
  manifest: {
    name: 'parallel-processor',
    version: '1.0.0',
    description: 'Coordinates parallel processing tasks'
  },

  async handleTask(ctx) {
    const input = ctx.task.input as { dataset: unknown[]; operations: string[] };
    
    await ctx.setGoal?.('Process dataset with multiple parallel operations');
    ctx.vars!.batchId = `batch-${Date.now()}`;
    ctx.vars!.totalOperations = input.operations.length;

    // Launch parallel operations
    const promises = input.operations.map(async (operation, index) => {
      return await ctx.sendTaskToAgent?.(`${operation}-processor`, {
        data: input.dataset,
        operationIndex: index,
        batchId: ctx.vars!.batchId
      }, { inheritWorkingMemory: true });
    });

    // Wait for all operations to complete
    const results = await Promise.all(promises);

    // Aggregate results
    const aggregatedResult = await ctx.sendTaskToAgent?.('result-aggregator', {
      results: results,
      batchId: ctx.vars!.batchId
    }, { inheritWorkingMemory: true });

    return {
      batchId: ctx.vars!.batchId,
      operationsCompleted: input.operations.length,
      parallelResults: results,
      aggregatedResult: aggregatedResult
    };
  }
}, import.meta.url);
```

### Conditional Routing

Route tasks to different agents based on conditions.

```typescript
// SmartRouter.ts
export default createAgent({
  manifest: {
    name: 'smart-router',
    version: '1.0.0',
    description: 'Routes tasks to appropriate specialist agents'
  },

  async handleTask(ctx) {
    const input = ctx.task.input as { 
      taskType: string; 
      complexity: 'low' | 'medium' | 'high';
      priority: 'low' | 'medium' | 'high';
      data: unknown;
    };
    
    await ctx.setGoal?.(`Route ${input.taskType} task to appropriate specialist`);
    ctx.vars!.routingDecision = 'pending';
    ctx.vars!.taskMetadata = {
      type: input.taskType,
      complexity: input.complexity,
      priority: input.priority
    };

    let targetAgent: string;
    let options = { inheritWorkingMemory: true };

    // Routing logic based on task characteristics
    if (input.taskType === 'data-analysis') {
      if (input.complexity === 'low') {
        targetAgent = 'basic-data-analyst';
      } else if (input.complexity === 'medium') {
        targetAgent = 'advanced-data-analyst';
        options.inheritMemory = true;
      } else {
        targetAgent = 'expert-data-scientist';
        options.inheritMemory = true;
      }
    } else if (input.taskType === 'text-processing') {
      if (input.priority === 'high') {
        targetAgent = 'priority-text-processor';
      } else {
        targetAgent = 'standard-text-processor';
      }
    } else {
      targetAgent = 'general-purpose-agent';
    }

    ctx.vars!.routingDecision = targetAgent;
    await ctx.addThought?.(`Routing to ${targetAgent} based on ${input.taskType}/${input.complexity}/${input.priority}`);

    const result = await ctx.sendTaskToAgent?.(targetAgent, input.data, options);

    return {
      router: 'smart-router',
      routedTo: targetAgent,
      routingCriteria: {
        taskType: input.taskType,
        complexity: input.complexity,
        priority: input.priority
      },
      result: result
    };
  }
}, import.meta.url);
```

## Error Handling Examples

### Graceful Fallbacks

Handle agent failures with backup strategies.

```typescript
// ResilientCoordinator.ts
export default createAgent({
  manifest: {
    name: 'resilient-coordinator',
    version: '1.0.0',
    description: 'Coordinates tasks with fallback strategies'
  },

  async handleTask(ctx) {
    const input = ctx.task.input as { task: string; data: unknown };
    
    await ctx.setGoal?.(`Complete ${input.task} with resilience`);
    ctx.vars!.attemptCount = 0;
    ctx.vars!.fallbackStrategy = 'multi-tier';

    // Primary attempt
    try {
      ctx.vars!.attemptCount = 1;
      await ctx.addThought?.('Attempting primary agent');
      
      const result = await ctx.sendTaskToAgent?.('primary-agent', input.data, {
        inheritWorkingMemory: true
      });
      
      return {
        success: true,
        strategy: 'primary',
        attempts: ctx.vars!.attemptCount,
        result: result
      };
      
    } catch (primaryError) {
      await ctx.addThought?.(`Primary agent failed: ${primaryError.message}`);
      
      // Secondary attempt
      try {
        ctx.vars!.attemptCount = 2;
        await ctx.addThought?.('Attempting secondary agent');
        
        const result = await ctx.sendTaskToAgent?.('secondary-agent', input.data, {
          inheritWorkingMemory: true
        });
        
        return {
          success: true,
          strategy: 'secondary',
          attempts: ctx.vars!.attemptCount,
          primaryError: primaryError.message,
          result: result
        };
        
      } catch (secondaryError) {
        await ctx.addThought?.(`Secondary agent failed: ${secondaryError.message}`);
        
        // Tertiary attempt with simplified processing
        try {
          ctx.vars!.attemptCount = 3;
          await ctx.addThought?.('Attempting fallback agent with simplified processing');
          
          const result = await ctx.sendTaskToAgent?.('fallback-agent', {
            originalData: input.data,
            simplifiedMode: true
          }, {
            inheritWorkingMemory: true
          });
          
          return {
            success: true,
            strategy: 'fallback',
            attempts: ctx.vars!.attemptCount,
            primaryError: primaryError.message,
            secondaryError: secondaryError.message,
            result: result
          };
          
        } catch (fallbackError) {
          await ctx.addThought?.(`All agents failed, using local processing`);
          
          // Final fallback - local processing
          const localResult = await this.processLocally(input.data);
          
          return {
            success: false,
            strategy: 'local',
            attempts: ctx.vars!.attemptCount,
            errors: {
              primary: primaryError.message,
              secondary: secondaryError.message,
              fallback: fallbackError.message
            },
            result: localResult
          };
        }
      }
    }
  },

  async processLocally(data: unknown) {
    // Minimal local processing as last resort
    return {
      processed: true,
      method: 'local-fallback',
      data: data,
      timestamp: new Date().toISOString()
    };
  }
}, import.meta.url);
```

### Timeout and Retry Logic

Handle slow or unresponsive agents.

```typescript
// TimeoutHandler.ts
export default createAgent({
  manifest: {
    name: 'timeout-handler',
    version: '1.0.0',
    description: 'Handles agent calls with timeout and retry logic'
  },

  async handleTask(ctx) {
    const input = ctx.task.input as { 
      targetAgent: string; 
      data: unknown; 
      maxRetries: number;
      timeoutMs: number;
    };
    
    ctx.vars!.retryCount = 0;
    ctx.vars!.maxRetries = input.maxRetries || 3;
    ctx.vars!.timeoutMs = input.timeoutMs || 30000;

    while (ctx.vars!.retryCount < ctx.vars!.maxRetries) {
      try {
        ctx.vars!.retryCount++;
        await ctx.addThought?.(`Attempt ${ctx.vars!.retryCount} of ${ctx.vars!.maxRetries}`);
        
        const startTime = Date.now();
        
        // Create timeout promise
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Agent call timeout')), ctx.vars!.timeoutMs);
        });
        
        // Race between agent call and timeout
        const agentPromise = ctx.sendTaskToAgent?.(input.targetAgent, input.data, {
          inheritWorkingMemory: true
        });
        
        const result = await Promise.race([agentPromise, timeoutPromise]);
        const duration = Date.now() - startTime;
        
        await ctx.addThought?.(`Agent call succeeded in ${duration}ms`);
        
        return {
          success: true,
          attempts: ctx.vars!.retryCount,
          duration: duration,
          result: result
        };
        
      } catch (error) {
        const isTimeout = error.message.includes('timeout');
        await ctx.addThought?.(`Attempt ${ctx.vars!.retryCount} failed: ${error.message}`);
        
        if (ctx.vars!.retryCount >= ctx.vars!.maxRetries) {
          return {
            success: false,
            attempts: ctx.vars!.retryCount,
            finalError: error.message,
            isTimeout: isTimeout
          };
        }
        
        // Wait before retry (exponential backoff)
        const backoffMs = Math.pow(2, ctx.vars!.retryCount) * 1000;
        await ctx.addThought?.(`Waiting ${backoffMs}ms before retry`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }
}, import.meta.url);
```

## Real-World Use Cases

### E-commerce Order Processing

Complete order fulfillment workflow with multiple specialized agents.

```typescript
// OrderProcessor.ts
export default createAgent({
  manifest: {
    name: 'order-processor',
    version: '1.0.0',
    description: 'Processes e-commerce orders end-to-end'
  },

  async handleTask(ctx) {
    const order = ctx.task.input as {
      orderId: string;
      customerId: string;
      items: Array<{ productId: string; quantity: number; price: number }>;
      shippingAddress: unknown;
      paymentMethod: unknown;
    };
    
    await ctx.setGoal?.(`Process order ${order.orderId} for customer ${order.customerId}`);
    ctx.vars!.orderId = order.orderId;
    ctx.vars!.customerId = order.customerId;
    ctx.vars!.orderValue = order.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    ctx.vars!.processingStarted = new Date().toISOString();

    try {
      // Step 1: Validate order
      await ctx.addThought?.('Validating order details');
      const validation = await ctx.sendTaskToAgent?.('order-validator', {
        order: order
      }, { inheritWorkingMemory: true });

      if (!validation.valid) {
        throw new Error(`Order validation failed: ${validation.errors.join(', ')}`);
      }

      // Step 2: Process payment
      await ctx.addThought?.('Processing payment');
      const payment = await ctx.sendTaskToAgent?.('payment-processor', {
        orderId: order.orderId,
        amount: ctx.vars!.orderValue,
        paymentMethod: order.paymentMethod
      }, { inheritWorkingMemory: true });

      // Step 3: Check inventory
      await ctx.addThought?.('Checking inventory availability');
      const inventory = await ctx.sendTaskToAgent?.('inventory-manager', {
        items: order.items
      }, { inheritWorkingMemory: true });

      // Step 4: Reserve items
      await ctx.addThought?.('Reserving inventory items');
      const reservation = await ctx.sendTaskToAgent?.('inventory-manager', {
        action: 'reserve',
        items: order.items,
        orderId: order.orderId
      }, { inheritWorkingMemory: true });

      // Step 5: Create shipment
      await ctx.addThought?.('Creating shipment');
      const shipment = await ctx.sendTaskToAgent?.('shipping-coordinator', {
        orderId: order.orderId,
        items: order.items,
        address: order.shippingAddress,
        priority: ctx.vars!.orderValue > 100 ? 'express' : 'standard'
      }, { inheritWorkingMemory: true });

      // Step 6: Send confirmation
      await ctx.addThought?.('Sending order confirmation');
      const notification = await ctx.sendTaskToAgent?.('notification-service', {
        type: 'order-confirmation',
        customerId: order.customerId,
        orderId: order.orderId,
        trackingNumber: shipment.trackingNumber
      }, { inheritWorkingMemory: true });

      ctx.vars!.processingCompleted = new Date().toISOString();
      await ctx.addThought?.('Order processing completed successfully');

      return {
        orderId: order.orderId,
        status: 'completed',
        steps: {
          validation: validation,
          payment: payment,
          inventory: inventory,
          reservation: reservation,
          shipment: shipment,
          notification: notification
        },
        timing: {
          started: ctx.vars!.processingStarted,
          completed: ctx.vars!.processingCompleted
        }
      };

    } catch (error) {
      await ctx.addThought?.(`Order processing failed: ${error.message}`);
      
      // Initiate rollback
      const rollback = await ctx.sendTaskToAgent?.('order-rollback-service', {
        orderId: order.orderId,
        error: error.message,
        completedSteps: Object.keys(ctx.vars || {}).filter(key => key.endsWith('Completed'))
      }, { inheritWorkingMemory: true });

      return {
        orderId: order.orderId,
        status: 'failed',
        error: error.message,
        rollback: rollback
      };
    }
  }
}, import.meta.url);
```

### Content Moderation Pipeline

Multi-stage content analysis and moderation system.

```typescript
// ContentModerator.ts
export default createAgent({
  manifest: {
    name: 'content-moderator',
    version: '1.0.0',
    description: 'Moderates user-generated content through multiple analysis stages'
  },

  async handleTask(ctx) {
    const content = ctx.task.input as {
      contentId: string;
      type: 'text' | 'image' | 'video';
      content: string | Buffer;
      userId: string;
      platform: string;
    };
    
    await ctx.setGoal?.(`Moderate ${content.type} content ${content.contentId}`);
    ctx.vars!.contentId = content.contentId;
    ctx.vars!.contentType = content.type;
    ctx.vars!.userId = content.userId;
    ctx.vars!.moderationStarted = new Date().toISOString();

    // Store content context for all analysis agents
    await ctx.remember?.('content-context', {
      contentId: content.contentId,
      type: content.type,
      userId: content.userId,
      platform: content.platform,
      submittedAt: new Date().toISOString()
    });

    const analysisResults: Record<string, unknown> = {};

    try {
      // Stage 1: Automated content analysis
      await ctx.addThought?.('Starting automated content analysis');
      analysisResults.automated = await ctx.sendTaskToAgent?.('automated-content-analyzer', {
        content: content.content,
        type: content.type
      }, { 
        inheritWorkingMemory: true,
        inheritMemory: true 
      });

      // Stage 2: Toxicity detection
      await ctx.addThought?.('Analyzing content toxicity');
      analysisResults.toxicity = await ctx.sendTaskToAgent?.('toxicity-detector', {
        content: content.content,
        type: content.type
      }, { 
        inheritWorkingMemory: true,
        inheritMemory: true 
      });

      // Stage 3: Spam detection
      await ctx.addThought?.('Checking for spam indicators');
      analysisResults.spam = await ctx.sendTaskToAgent?.('spam-detector', {
        content: content.content,
        userId: content.userId,
        platform: content.platform
      }, { 
        inheritWorkingMemory: true,
        inheritMemory: true 
      });

      // Stage 4: Policy compliance check
      await ctx.addThought?.('Checking policy compliance');
      analysisResults.policy = await ctx.sendTaskToAgent?.('policy-checker', {
        content: content.content,
        type: content.type,
        platform: content.platform
      }, { 
        inheritWorkingMemory: true,
        inheritMemory: true 
      });

      // Stage 5: Risk assessment
      await ctx.addThought?.('Performing risk assessment');
      const riskAssessment = await ctx.sendTaskToAgent?.('risk-assessor', {
        contentId: content.contentId,
        analysisResults: analysisResults
      }, { 
        inheritWorkingMemory: true,
        inheritMemory: true 
      });

      // Stage 6: Moderation decision
      await ctx.addThought?.('Making moderation decision');
      const decision = await ctx.sendTaskToAgent?.('moderation-decision-maker', {
        contentId: content.contentId,
        riskAssessment: riskAssessment,
        analysisResults: analysisResults
      }, { 
        inheritWorkingMemory: true,
        inheritMemory: true 
      });

      // Stage 7: Action execution (if needed)
      if (decision.action !== 'approve') {
        await ctx.addThought?.(`Executing moderation action: ${decision.action}`);
        const actionResult = await ctx.sendTaskToAgent?.('moderation-action-executor', {
          contentId: content.contentId,
          action: decision.action,
          reason: decision.reason,
          userId: content.userId
        }, { 
          inheritWorkingMemory: true,
          inheritMemory: true 
        });
        
        analysisResults.actionExecuted = actionResult;
      }

      ctx.vars!.moderationCompleted = new Date().toISOString();
      await ctx.addThought?.('Content moderation completed');

      return {
        contentId: content.contentId,
        decision: decision.action,
        reason: decision.reason,
        confidence: decision.confidence,
        analysisResults: analysisResults,
        timing: {
          started: ctx.vars!.moderationStarted,
          completed: ctx.vars!.moderationCompleted
        }
      };

    } catch (error) {
      await ctx.addThought?.(`Moderation failed: ${error.message}`);
      
      // Fallback to human review
      const humanReview = await ctx.sendTaskToAgent?.('human-review-queue', {
        contentId: content.contentId,
        error: error.message,
        partialResults: analysisResults
      }, { inheritWorkingMemory: true });

      return {
        contentId: content.contentId,
        decision: 'human-review-required',
        error: error.message,
        humanReviewTicket: humanReview.ticketId
      };
    }
  }
}, import.meta.url);
```

These examples demonstrate the power and flexibility of the A2A system for building complex, multi-agent workflows that maintain context and memory across agent boundaries. 
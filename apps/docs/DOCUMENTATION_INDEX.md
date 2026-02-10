# Documentation Index

## Overview

This document provides an index of all documentation in the CallAgent framework, organized by topic and complexity level.

## Core Framework Documentation

### Getting Started
- [Monorepo Overview](./monorepo-overview.md) - Project structure and setup
- [Agent Runner](./runner.md) - CLI tool for running agents (with auto-resume support)
- [Usage Tracking](./usage-tracking.md) - Usage metrics and monitoring
- [Telemetry & Observability](./telemetry.md) - Tracing, Opik integration, and zero-code configuration

### Loop-First Architecture
- [Loop Overview](./loop/overview.md) - Loop execution model with auto-resume
- [Loop Modules](./loop/modules.md) - Module contracts and agent-local declarations
- [A-P-L-R-E-T Stage Dispatcher Architecture](./loop/aplret-stage-dispatcher.md) - Production-ready agent architecture with typed intents, stage dispatcher, and effect safety
- [Loop-First Persistence](./durable-handlers-and-persistence.md) - MentalState persistence and auto-resume

### Memory System
- [Memory SQL Adapter](./memory-sql-adapter.md) - Database persistence layer
- [Working Memory](./memory/working-memory.md) - Cognitive context API
- [Semantic Memory](./memory/semantic-memory.md) - Knowledge storage
- [Binary Data Storage](./memory/binary-data-storage.md) - File and image storage
- [Multi-Tenant Memory](./memory/multi-tenant-memory.md) - Tenant isolation
- [MLO Architecture](./memory/mlo-architecture.md) - Memory Lifecycle Orchestrator

## Agent-to-Agent (A2A) Communication

### Basic Usage
- [A2A Usage Guide](./a2a/usage-guide.md) - Practical patterns and examples
- [A2A Examples](./a2a/examples.md) - Code examples and demos
- [A2A API Reference](./a2a/api-reference.md) - Complete API documentation

### Architecture and Implementation
- [A2A Architecture](./a2a/architecture.md) - System design overview
- [Child Input Required Flow](./a2a/child-input-required-flow.md) - Parent-child input handling
- [TaskEngine A2A Integration](./task-engine-a2a-integration.md) - Auto-resume A2A coordination

## Advanced Topics

### Loop Architecture
- **Module Contracts**: Detailed in [Loop Modules](./loop/modules.md)
- **Auto-Resume Flow**: Covered in [Loop Overview](./loop/overview.md)
- **MentalState Management**: Technical details in [Loop-First Persistence](./durable-handlers-and-persistence.md)
- **Production Agent Architecture**: [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md) with typed intents and effect safety

### Persistence and Database
- **MentalState Persistence**: [Loop-First Persistence](./durable-handlers-and-persistence.md)
- **Token-Based Auto-Resume**: [TaskEngine A2A Integration](./task-engine-a2a-integration.md)
- **Event Payload Injection**: Covered in loop architecture documents

### Debugging and Troubleshooting
- **Auto-Resume Issues**: [Loop-First Persistence](./durable-handlers-and-persistence.md#debugging-and-troubleshooting)
- **Loop Module Problems**: [Loop Modules](./loop/modules.md#troubleshooting)
- **A2A Auto-Resume**: [TaskEngine A2A Integration](./task-engine-a2a-integration.md)

## Documentation by Complexity Level

### Beginner (Getting Started)
1. [Monorepo Overview](./monorepo-overview.md)
2. [Agent Runner](./runner.md)
3. [A2A Usage Guide](./a2a/usage-guide.md)
4. [A2A Examples](./a2a/examples.md)

### Intermediate (Implementation)
1. [Working Memory](./memory/working-memory.md)
2. [Memory SQL Adapter](./memory-sql-adapter.md)
3. [A2A Architecture](./a2a/architecture.md)
4. [A2A API Reference](./a2a/api-reference.md)

### Advanced (Technical Deep Dive)
1. [A-P-L-R-E-T Stage Dispatcher Architecture](./loop/aplret-stage-dispatcher.md)
2. [Child Input Required Flow](./a2a/child-input-required-flow.md)
3. [Durable Handlers and Persistence](./durable-handlers-and-persistence.md)
4. [TaskEngine A2A Integration](./task-engine-a2a-integration.md)
5. [MLO Architecture](./memory/mlo-architecture.md)

## Recently Added Documentation

### January 2025 Updates
- ✅ **[A-P-L-R-E-T Stage Dispatcher Architecture](./loop/aplret-stage-dispatcher.md)** - Production-ready agent architecture with typed Intent system, stage dispatcher pattern, effect safety (budgets/timeouts/retries), resume contract, golden path tests, and upgrade path to ts-pattern/XState
- ✅ **[Framework Changes for A-P-L-R-E-T](./loop/framework-changes-for-aplret.md)** - Implementation plan for framework enhancements to support the architecture (80% already works, 20% enhancements needed)

### December 2024 Updates
- ✅ **[Child Input Required Flow](./a2a/child-input-required-flow.md)** - Complete technical documentation of parent-child input handling, database persistence patterns, and troubleshooting guide
- ✅ **[Durable Handlers and Persistence](./durable-handlers-and-persistence.md)** - Comprehensive guide to handler lifecycle, context restoration, and working memory persistence
- ✅ **[TaskEngine A2A Integration](./task-engine-a2a-integration.md)** - Technical architecture documentation covering TaskEngine and A2AService coordination

### Key Patterns Documented
1. **Production Agent Architecture**: Typed Intent system, stage dispatcher, effect safety in [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md)
2. **State Management Strategy**: M (cognition) vs ctx.vars (control) separation in [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md#state-management-strategy)
3. **Effect Safety Pattern**: runEffect() with budgets/timeouts/retries in [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md#effect-safety-and-budgets)

### Key Issues Documented
1. **Child `onProvided` Handler Not Invoked**: Root cause analysis and fix in [Child Input Required Flow](./a2a/child-input-required-flow.md#issue-child-onprovided-handler-not-invoked)
2. **Parent Context Correlation**: Token-based correlation system in [TaskEngine A2A Integration](./task-engine-a2a-integration.md#token-based-correlation-system)
3. **Durable Handler Context Extension**: Context restoration patterns in [Durable Handlers and Persistence](./durable-handlers-and-persistence.md#context-restoration-process)

## Cross-References

### Database and Persistence
- Working Memory Database Schema: [Durable Handlers](./durable-handlers-and-persistence.md#database-storage-schema)
- Memory SQL Implementation: [Memory SQL Adapter](./memory-sql-adapter.md)
- Context Serialization: [TaskEngine A2A Integration](./task-engine-a2a-integration.md#context-serialization-for-child-agents)

### Error Handling and Recovery
- Child Input Flow Errors: [Child Input Required Flow](./a2a/child-input-required-flow.md#common-issues-and-troubleshooting)
- Handler Registration Errors: [TaskEngine A2A Integration](./task-engine-a2a-integration.md#error-handling-and-recovery)
- Context Restoration Failures: [Durable Handlers](./durable-handlers-and-persistence.md#debugging-and-troubleshooting)

### Performance and Optimization
- A2A Performance Characteristics: [A2A Architecture](./a2a/architecture.md#performance-characteristics)
- Context Restoration Costs: [Durable Handlers](./durable-handlers-and-persistence.md#performance-considerations)
- Handler Registry Caching: [TaskEngine A2A Integration](./task-engine-a2a-integration.md#performance-optimizations)

### Agent Architecture Patterns
- Typed Intent System: [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md#typed-intent-system)
- Stage Dispatcher Pattern: [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md#stage-dispatcher-pattern)
- Effect Safety (runEffect): [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md#effect-safety-and-budgets)
- Resume Contract: [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md#resume-contract)
- Testing Strategies: [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md#testing-strategy)

## Migration Guides

### Agent Architecture Evolution
- From If-Pyramids to Stage Dispatcher: [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md#upgrade-path)
- From Simple Dispatcher to Pattern Matching (ts-pattern): [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md#stage-2-pattern-matching-when-branching-grows)
- From Pattern Matching to Statecharts (XState): [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md#stage-3-statecharts-when-flows-get-complex)

### From Manual to Framework-Managed
- Handler Management: [TaskEngine A2A Integration](./task-engine-a2a-integration.md#migration-and-upgrade-guide)
- State Management: [Durable Handlers](./durable-handlers-and-persistence.md#migration-guide)
- Input Handling: [Child Input Required Flow](./a2a/child-input-required-flow.md#migration-guide)

## Testing and Quality Assurance

### Testing Strategies
- Golden Path Testing: [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md#golden-path-test)
- Module Unit Testing: [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md#unit-tests-for-modules)
- Handler Integration Testing: [A-P-L-R-E-T Stage Dispatcher](./loop/aplret-stage-dispatcher.md#integration-tests-for-handlers)
- Unit Testing A2A: [TaskEngine A2A Integration](./task-engine-a2a-integration.md#testing-strategies)
- Integration Testing: [Child Input Required Flow](./a2a/child-input-required-flow.md#testing-and-debugging)
- Handler Testing: [Durable Handlers](./durable-handlers-and-persistence.md#migration-guide)

## Contributing to Documentation

### Standards and Guidelines
- Follow the patterns established in recently added documentation
- Include sequence diagrams for complex flows (using Mermaid)
- Provide both conceptual explanations and practical code examples
- Include troubleshooting sections with common issues and solutions
- Cross-reference related documentation

### Documentation Template Structure
1. **Overview** - High-level explanation
2. **Architecture Diagrams** - Visual flow representation
3. **Implementation Details** - Technical specifics
4. **Code Examples** - Practical usage patterns
5. **Common Issues** - Troubleshooting guide
6. **Best Practices** - Recommended patterns
7. **Performance Considerations** - Optimization guidance
8. **Testing** - Verification strategies
9. **Migration Guide** - Upgrade paths
10. **See Also** - Cross-references

## Status Summary

✅ **Production-Ready Architecture**: The A-P-L-R-E-T Stage Dispatcher pattern provides a complete, reusable agent architecture with typed intents, effect safety, and clear upgrade paths.

✅ **Complete Coverage**: The child input_required flow, persistence patterns, and production agent architecture are now fully documented across comprehensive technical documents.

✅ **Cross-Referenced**: All documents properly reference each other and existing documentation.

✅ **Troubleshooting Ready**: Common issues, root causes, and solutions are documented with practical examples.

✅ **Developer-Friendly**: Includes debugging logs, testing strategies (golden path, unit, integration), migration guides, and best practices.

✅ **Future-Proof**: Clear evolution path from simple dispatchers → pattern matching (ts-pattern) → statecharts (XState).

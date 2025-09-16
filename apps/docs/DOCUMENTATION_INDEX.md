# Documentation Index

## Overview

This document provides an index of all documentation in the CallAgent framework, organized by topic and complexity level.

## Core Framework Documentation

### Getting Started
- [Monorepo Overview](./monorepo-overview.md) - Project structure and setup
- [Agent Runner](./runner.md) - CLI tool for running agents
- [Usage Tracking](./usage-tracking.md) - Usage metrics and monitoring

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
- [Durable Handlers and Persistence](./durable-handlers-and-persistence.md) - Handler lifecycle management
- [TaskEngine A2A Integration](./task-engine-a2a-integration.md) - Core system coordination

## Advanced Topics

### Persistence and Database
- **Database Persistence Patterns**: Covered in [Child Input Required Flow](./a2a/child-input-required-flow.md)
- **Working Memory Storage**: Detailed in [Durable Handlers and Persistence](./durable-handlers-and-persistence.md)
- **Context Restoration**: Technical details in [TaskEngine A2A Integration](./task-engine-a2a-integration.md)

### Handler Management
- **Durable Handler Lifecycle**: [Durable Handlers and Persistence](./durable-handlers-and-persistence.md)
- **Token-Based Correlation**: [TaskEngine A2A Integration](./task-engine-a2a-integration.md)
- **Error Recovery**: Covered across multiple A2A documents

### Debugging and Troubleshooting
- **Child Input Flow Issues**: [Child Input Required Flow](./a2a/child-input-required-flow.md#common-issues-and-troubleshooting)
- **Context Restoration Problems**: [Durable Handlers and Persistence](./durable-handlers-and-persistence.md#debugging-and-troubleshooting)
- **Handler Registration Issues**: [TaskEngine A2A Integration](./task-engine-a2a-integration.md#debugging-and-monitoring)

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
1. [Child Input Required Flow](./a2a/child-input-required-flow.md)
2. [Durable Handlers and Persistence](./durable-handlers-and-persistence.md)
3. [TaskEngine A2A Integration](./task-engine-a2a-integration.md)
4. [MLO Architecture](./memory/mlo-architecture.md)

## Recently Added Documentation

### December 2024 Updates
- ✅ **[Child Input Required Flow](./a2a/child-input-required-flow.md)** - Complete technical documentation of parent-child input handling, database persistence patterns, and troubleshooting guide
- ✅ **[Durable Handlers and Persistence](./durable-handlers-and-persistence.md)** - Comprehensive guide to handler lifecycle, context restoration, and working memory persistence
- ✅ **[TaskEngine A2A Integration](./task-engine-a2a-integration.md)** - Technical architecture documentation covering TaskEngine and A2AService coordination

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

## Migration Guides

### From Manual to Framework-Managed
- Handler Management: [TaskEngine A2A Integration](./task-engine-a2a-integration.md#migration-and-upgrade-guide)
- State Management: [Durable Handlers](./durable-handlers-and-persistence.md#migration-guide)
- Input Handling: [Child Input Required Flow](./a2a/child-input-required-flow.md#migration-guide)

## Testing and Quality Assurance

### Testing Strategies
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

✅ **Complete Coverage**: The child input_required flow and related persistence patterns are now fully documented across three comprehensive technical documents.

✅ **Cross-Referenced**: All documents properly reference each other and existing documentation.

✅ **Troubleshooting Ready**: Common issues, root causes, and solutions are documented with practical examples.

✅ **Developer-Friendly**: Includes debugging logs, testing strategies, and migration guides.

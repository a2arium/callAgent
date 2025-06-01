/**
 * Memory Lifecycle Orchestrator (MLO) - Complete Implementation
 * 
 * This module provides the complete 6-stage memory lifecycle pipeline:
 * 1. Acquisition - Filter, compress, consolidate
 * 2. Encoding - Attention, multi-modal fusion
 * 3. Derivation - Reflection, summarization, distillation, forgetting
 * 4. Retrieval - Indexing, matching
 * 5. Neural Memory - Associative memory, parameter integration
 * 6. Utilization - RAG, context management, hallucination mitigation
 */

// Export all stage interfaces
export * from './interfaces/index.js';

// Export configuration system
export * from './config/index.js';

// Export processor factory
export * from './ProcessorFactory.js';

// Export main orchestrator
export * from './orchestrator/index.js'; 
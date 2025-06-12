import { IAcquisitionFilter } from '../../interfaces/IAcquisitionFilter.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
import { logger } from '@callagent/utils';

export class TenantAwareFilter implements IAcquisitionFilter {
    readonly stageName = 'acquisition' as const;
    readonly componentName = 'filter' as const;
    readonly stageNumber = 1;

    private logger = logger.createLogger({ prefix: 'TenantAwareFilter' });
    private metrics: ProcessorMetrics = {
        itemsProcessed: 0,
        itemsDropped: 0,
        processingTimeMs: 0,
    };

    private filterStats = {
        totalItemsEvaluated: 0,
        itemsAccepted: 0,
        itemsRejected: 0,
        averageRelevanceScore: 0,
    };

    private allowedTenants: Set<string>;
    private maxInputSize: number;
    private relevanceThreshold: number;
    private conversationAware: boolean;
    private researchMode: boolean;
    private complexityAware: boolean;

    constructor(config?: {
        allowedTenants?: string[];
        maxInputSize?: number;
        relevanceThreshold?: number;
        conversationAware?: boolean;
        researchMode?: boolean;
        complexityAware?: boolean;
    }) {
        this.allowedTenants = new Set(config?.allowedTenants || []);
        this.maxInputSize = config?.maxInputSize || 10000;
        this.relevanceThreshold = config?.relevanceThreshold || 0.5;
        this.conversationAware = config?.conversationAware || false;
        this.researchMode = config?.researchMode || false;
        this.complexityAware = config?.complexityAware || false;

        this.logger.debug('TenantAwareFilter initialized', {
            relevanceThreshold: this.relevanceThreshold,
            maxInputSize: this.maxInputSize
        });
    }

    /**
     * PHASE 1: Basic tenant isolation
     * FUTURE: Could add more sophisticated tenant permissions, cross-tenant sharing rules
     * 
     * @see https://www.osohq.com/ - Oso RBAC for advanced permissions
     * @see https://github.com/casbin/casbin - Authorization library
     * 
     * ENHANCEMENT: Foreign Key / Namespace Isolation
     * While TenantAwareFilter enforces tenant isolation in Acquisition, consider adding
     * namespace or key-prefixing strategies for indexing, especially in vector databases
     * like Pinecone or Weaviate. Many hosted vector DBs support namespace segregation
     * at the API level, which can complement or replace manual filtering for larger deployments.
     */
    async process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown> | null> {
        const startTime = Date.now();
        this.metrics.itemsProcessed++;
        this.filterStats.totalItemsEvaluated++;

        try {
            // Check if item should be processed
            const shouldProcess = await this.shouldProcess(item);

            if (shouldProcess) {
                // Add processing history
                if (!item.metadata.processingHistory) {
                    item.metadata.processingHistory = [];
                }
                item.metadata.processingHistory.push(`${this.stageName}:${this.componentName}`);

                this.filterStats.itemsAccepted++;
                this.metrics.processingTimeMs += Date.now() - startTime;
                this.metrics.lastProcessedAt = new Date().toISOString();

                this.logger.debug('Item passed filtering', {
                    itemId: item.id,
                    tenantId: item.metadata.tenantId
                });

                return item;
            } else {
                this.logger.debug('Item filtered out', {
                    itemId: item.id,
                    tenantId: item.metadata.tenantId,
                    reason: 'Failed filtering criteria'
                });

                this.filterStats.itemsRejected++;
                this.metrics.itemsDropped++;
                this.metrics.processingTimeMs += Date.now() - startTime;
                return null;
            }
        } catch (error) {
            this.logger.error('Error processing item in filter', {
                itemId: item.id,
                error: error instanceof Error ? error.message : 'Unknown error'
            });

            this.metrics.itemsDropped++;
            this.metrics.processingTimeMs += Date.now() - startTime;
            return null;
        }
    }

    async shouldProcess(item: MemoryItem<unknown>): Promise<boolean> {
        // Tenant isolation check
        if (this.allowedTenants.size > 0 && !this.allowedTenants.has(item.metadata.tenantId)) {
            this.logger.warn('Tenant access denied', {
                tenantId: item.metadata.tenantId,
                operation: item.metadata.sourceOperation
            });
            return false;
        }

        // Size check
        const contentSize = JSON.stringify(item.data).length;
        if (contentSize > this.maxInputSize) {
            this.logger.debug('Item too large', {
                itemId: item.id,
                size: contentSize,
                maxSize: this.maxInputSize
            });
            return false;
        }

        // Placeholder relevance scoring
        const relevanceScore = this.calculateRelevanceScore(item);
        this.logger.debug('Relevance score calculated', {
            itemId: item.id,
            score: relevanceScore,
            threshold: this.relevanceThreshold
        });

        if (relevanceScore < this.relevanceThreshold) {
            this.logger.debug('Item below relevance threshold', {
                itemId: item.id,
                score: relevanceScore,
                threshold: this.relevanceThreshold
            });
            return false;
        }

        return true;
    }

    private calculateRelevanceScore(item: MemoryItem<unknown>): number {
        // Placeholder implementation - in Phase 2, this would use LLM scoring
        let score = 0.7; // Base score

        if (this.conversationAware && item.metadata.intent === 'conversation') {
            score += 0.1;
        }

        if (this.researchMode && item.metadata.intent === 'research') {
            score += 0.2;
        }

        if (this.complexityAware) {
            const contentLength = JSON.stringify(item.data).length;
            if (contentLength > 1000) {
                score += 0.1; // Longer content might be more valuable
            }
        }

        return Math.min(score, 1.0);
    }

    configure(config: {
        maxInputSize?: number;
        tenantIsolation?: boolean;
        relevanceThreshold?: number;
        conversationAware?: boolean;
        researchMode?: boolean;
        complexityAware?: boolean;
        [key: string]: unknown;
    }): void {
        if (config.maxInputSize !== undefined) {
            this.maxInputSize = config.maxInputSize;
        }
        if (config.relevanceThreshold !== undefined) {
            this.relevanceThreshold = config.relevanceThreshold;
        }
        if (config.conversationAware !== undefined) {
            this.conversationAware = config.conversationAware;
        }
        if (config.researchMode !== undefined) {
            this.researchMode = config.researchMode;
        }
        if (config.complexityAware !== undefined) {
            this.complexityAware = config.complexityAware;
        }
        if (config.allowedTenants && Array.isArray(config.allowedTenants)) {
            this.allowedTenants = new Set(config.allowedTenants);
        }
    }

    getMetrics(): ProcessorMetrics {
        return { ...this.metrics };
    }

    getFilterStats() {
        // Update average relevance score
        if (this.filterStats.totalItemsEvaluated > 0) {
            this.filterStats.averageRelevanceScore =
                this.filterStats.itemsAccepted / this.filterStats.totalItemsEvaluated;
        }

        return { ...this.filterStats };
    }
} 
export type EntityType = string; // User-defined, no restrictions

export type EntityMatch = {
    entityId: string;
    canonicalName: string;
    similarity: number;
    confidence: 'high' | 'medium' | 'low';
};

export type EntityAlignment = {
    entityId: string;
    canonicalName: string;
    originalValue: string;
    confidence: 'high' | 'medium' | 'low';
    alignedAt: Date;
};

export type AlignedValue = {
    toString(): string;           // Returns canonical name
    valueOf(): string;            // Returns canonical name  
    _entity: EntityAlignment;     // Full alignment info
    _wasAligned: boolean;         // Quick check
    _original: string;            // Original value
    _canonical: string;           // Canonical name
};

export type EntityFieldSpec = {
    [fieldName: string]: EntityType;
};

export type MemorySetOptions = {
    tags?: string[];
    entities?: EntityFieldSpec;   // e.g., { venue: 'location', speaker: 'person' }
    alignmentThreshold?: number;  // Override default threshold
    autoCreateEntities?: boolean; // Default: true
    backend?: string;             // Backend selection
    tenantId?: string;            // Tenant context for memory operations
};

export type ParsedEntityField = {
    fieldName: string;
    entityType: string;
    value: string;
    threshold?: number;  // Field-specific threshold parsed from 'type:threshold' syntax
};

export type EmbeddingConfig = {
    provider: string;           // e.g., 'openai'
    model: string;             // e.g., 'text-embedding-3-small'
    apiKey?: string;           // Optional, falls back to env vars
    dimensions?: number;       // Optional dimension reduction
    encodingFormat?: 'float' | 'base64';
};

export type EntityAlignmentOptions = {
    defaultThreshold: number;
    // Removed typeThresholds - now using field-specific thresholds
};

// Type for handling pgvector embeddings (Prisma Unsupported type)
export type VectorEmbedding = number[] | null;

export type GetManyOptions = {
    limit?: number;
    orderBy?: {
        path: string;
        direction: 'asc' | 'desc';
    };
    backend?: string;
    tenantId?: string;            // Tenant context for query operations
};

export type GetManyQuery = {
    tag?: string;
    filters?: import('@a2arium/callagent-types').MemoryFilter[];  // Use core MemoryFilter type
    limit?: number;
    orderBy?: {
        path: string;
        direction: 'asc' | 'desc';
    };
    backend?: string;
    tenantId?: string;            // Tenant context for query operations
};

// Union type for getMany parameter
export type GetManyInput = string | GetManyQuery; 
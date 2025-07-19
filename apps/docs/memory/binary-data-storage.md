# Binary Data Storage

The CallAgent framework supports storing binary data (images, files, documents) seamlessly through the standard memory interface. Binary data is automatically detected and stored efficiently in PostgreSQL BYTEA fields while maintaining the same simple `.set()` and `.get()` API.

## Philosophy

Binary data storage should be **transparent to agents**. Agents use the same `ctx.memory.semantic.set()` and `ctx.memory.semantic.get()` interface regardless of whether they're storing text, JSON, or binary data. The framework automatically:

- **Detects data type**: URLs, base64 strings, data URLs, Buffers, JSON
- **Downloads URLs**: HTTP/HTTPS links downloaded with retries and error handling
- **Converts formats**: Base64 and data URLs decoded to Buffer objects
- **Optimizes storage**: Large data (≥1KB) → BYTEA fields, small data → JSON Base64
- **Extracts metadata**: MIME types, filenames, content hashes automatically
- **Provides unified interface**: Same `.set()` and `.get()` for all data types

## Status

**Phase 2A**: ✅ **Complete** (Smart Detection & Processing)
- [x] Automatic binary detection in `.set()` method
- [x] URL auto-download with retries and error handling  
- [x] Base64 and data URL parsing
- [x] Smart storage routing (JSON vs BYTEA based on size)
- [x] Transparent Buffer/binary handling
- [x] Comprehensive test coverage and demo agent

**Phase 2B**: 🚧 **Planned** (Advanced Features)
- [ ] Download caching and deduplication by content hash
- [ ] Configurable policies and domain restrictions
- [ ] Advanced error handling and fallback strategies
- [ ] Performance monitoring and storage metrics

## Setup

1. **Run the blob storage migration:**
   ```bash
   yarn workspace @callagent/memory-sql prisma migrate dev --name add_blob_storage
   yarn workspace @callagent/memory-sql prisma generate
   ```

2. **No code changes needed** - existing agents automatically gain binary storage capabilities.

## Smart Interface (Phase 2A)

The framework now automatically detects and processes any data type in `.set()` calls:

### URL Auto-Download
```typescript
// Framework detects URL and downloads automatically
await ctx.memory.semantic.set('image:profile', {
    data: 'https://example.com/avatar.jpg',  // URL detected → download
    description: 'User profile photo'
}, { tags: ['image'] });
```

### Base64 Auto-Decode
```typescript  
// Framework detects base64 and converts to Buffer
await ctx.memory.semantic.set('image:logo', {
    data: 'iVBORw0KGgoAAAANSUhE...', // Base64 detected → decode
    filename: 'logo.png'
}, { tags: ['image'] });
```

### Data URL Parsing
```typescript
// Framework detects data URL and extracts binary content
await ctx.memory.semantic.set('image:inline', {
    data: 'data:image/png;base64,iVBORw0KGg...', // Data URL → parse
    description: 'Inline image'
}, { tags: ['image'] });
```

### Buffer Optimization
```typescript
// Framework detects Buffer and chooses optimal storage
await ctx.memory.semantic.set('file:doc', {
    data: bufferData, // Buffer → optimize storage (JSON/BYTEA)
    filename: 'document.pdf'  
}, { tags: ['file'] });
```

### Unified Retrieval
```typescript
// Same interface returns consistent structure regardless of storage method
const data = await ctx.memory.semantic.get('image:profile');
// Always returns: { data: Buffer, filename: string, mimeType: string, ... }
```

Try the `smart-binary-demo` agent to see all features in action!

## Basic Usage (Recommended)

### Store Binary Data
```typescript
// In your agent - same interface for text or binary data
export default createAgent({
    async handleTask(ctx) {
        // Store an image - framework detects Buffer and handles appropriately
        const imageBuffer = Buffer.from(input.imageData, 'base64');
        
        await ctx.memory.semantic.set(`image:${userId}:avatar`, {
            type: 'image',
            data: imageBuffer,  // Framework automatically detects binary data
            filename: 'avatar.jpg',
            mimeType: 'image/jpeg',
            description: 'User avatar photo'
        }, { 
            tags: ['image', 'avatar', 'user'] 
        });
        
        // Store a document  
        const docBuffer = Buffer.from(input.documentData, 'base64');
        
        await ctx.memory.semantic.set(`doc:${docId}`, {
            type: 'document',
            data: docBuffer,
            filename: 'contract.pdf',
            mimeType: 'application/pdf'
        }, {
            tags: ['document', 'contract']
        });
    }
});
```

### Retrieve Binary Data
```typescript
// Retrieve works the same way - no special handling needed
const imageEntry = await ctx.memory.semantic.get(`image:${userId}:avatar`);
if (imageEntry) {
    const imageBuffer = imageEntry.value.data; // Returns Buffer automatically
    const metadata = {
        filename: imageEntry.value.filename,
        mimeType: imageEntry.value.mimeType,
        size: imageBuffer.length
    };
}
```

### Query Binary Data
```typescript
// Query works with tags just like regular memory
const userImages = await ctx.memory.semantic.getMany({ 
    tag: 'image',
    limit: 10 
});

userImages.forEach(entry => {
    console.log(`Found image: ${entry.value.filename}`);
    console.log(`Size: ${entry.value.data.length} bytes`);
});
```

## Storage Strategy

The framework uses an intelligent storage strategy:

### Automatic Detection
- **Small binary data** (<1KB): Stored as Base64 in JSON fields
- **Large binary data** (>1KB): Stored in PostgreSQL BYTEA fields  
- **Metadata**: Always stored in JSON for fast querying

### Benefits
- ✅ **Simple agent code** - same interface for all data types
- ✅ **Automatic optimization** - framework chooses best storage method
- ✅ **Fast queries** - metadata remains searchable in JSON
- ✅ **Efficient storage** - large binaries use optimized BYTEA fields
- ✅ **Transactional integrity** - binary data and metadata stored atomically

## Advanced Usage (Framework Internals)

> **Note**: These methods are for framework development only. Regular agents should use the standard `.set()` interface above.

### Direct SQL Adapter Access
```typescript
// Only for framework development or advanced use cases
const sqlAdapter = (ctx.memory.semantic as any).backends?.sql;

if (sqlAdapter) {
    // Direct blob operations (framework internal use)
    await sqlAdapter.setBlob('key', buffer, metadata, options);
    const result = await sqlAdapter.getBlob('key');
}
```

## Implementation Status

### Current Implementation (Phase 1) ✅
- ✅ Database schema with BYTEA fields
- ✅ Direct SQL adapter methods (`setBlob`, `getBlob`, etc.)
- ✅ Helper functions for images and files
- ✅ Migration and setup documentation
- ✅ Working demo agent

### Planned Implementation (Phase 2) 🚧
- 🚧 **Automatic binary detection** in standard `.set()` method
- 🚧 **Transparent Buffer handling** in `.get()` method  
- 🚧 **Size-based storage strategy** (JSON vs BYTEA)
- 🚧 **Seamless agent experience** without sqlAdapter access

## Migration Path

### Current Usage (Phase 1)
```typescript
// Agents currently need to access SQL adapter directly
const sqlAdapter = (ctx.memory.semantic as any).backends?.sql;
await sqlAdapter.setBlob('key', buffer, metadata);
```

### Future Usage (Phase 2) 
```typescript  
// Agents will use standard interface - much cleaner!
await ctx.memory.semantic.set('key', {
    data: buffer,  // Framework auto-detects binary data
    filename: 'image.jpg'
}, { tags: ['image'] });
```

## Working Example

See the complete working example at:
- **[Image Storage Demo](../../examples/image-storage-demo/)** - Shows current Phase 1 implementation
- **[Binary Storage Tests](../../packages/memory-sql/tests/BlobStorage.test.ts)** - Unit tests and expected behavior

## Next Steps

1. **Phase 2 Implementation**: Make binary storage transparent to agents
2. **Memory Lifecycle Integration**: Add binary data processing to MLO pipeline  
3. **Vision Processing**: Extract features from images using AI models
4. **Multimodal RAG**: Combine text and image understanding in retrieval

The goal is making binary data storage as simple as `ctx.memory.semantic.set('key', { data: buffer })` with all optimization happening automatically behind the scenes. 
# Image Storage Demo Agent

This agent demonstrates the **smart binary storage** in CallAgent Phase 2A, where binary data is handled transparently through the standard `ctx.memory.semantic.set()` interface. The framework automatically detects data types and optimizes storage!

## Features Demonstrated

- ✅ **Smart Data Detection** - URLs, base64, data URLs, buffers automatically detected
- ✅ **URL Auto-Download** - HTTP/HTTPS links downloaded with retries and error handling  
- ✅ **Format Auto-Conversion** - Base64 and data URLs decoded to Buffer objects
- ✅ **Storage Optimization** - Large files → BYTEA, small files → JSON base64
- ✅ **Metadata Extraction** - MIME types, filenames, hashes extracted automatically
- ✅ **Unified Interface** - Same `.set()` and `.get()` for all data types
- ✅ **Transparent Retrieval** - Always returns Buffer objects for binary data

## Setup Instructions

### 1. Run the Database Migration

The blob storage functionality requires new database fields. Run the migration:

```bash
# Apply the migration
yarn workspace @callagent/memory-sql prisma migrate dev --name add-blob-storage

# Regenerate the Prisma client to include new fields
yarn workspace @callagent/memory-sql prisma generate
```

### 2. Build the Example

```bash
# Build the example agent
yarn workspace image-storage-demo build

# Or build everything
yarn build
```

### 3. Make sure your database is configured

Ensure you have `MEMORY_DATABASE_URL` set in your `.env` file:

```env
MEMORY_DATABASE_URL="postgresql://user:password@localhost:5432/callagent_db"
```

## Usage Examples

### Run the Smart Binary Storage Demo

The simplest way to test the new transparent functionality:

```bash
yarn callagent dev
```

Then try:
```json
{"action": "demo"}
```

This demonstrates:
1. **URL Auto-Download** - Downloads image from URL automatically  
2. **Base64 Auto-Processing** - Detects and decodes base64 data
3. **Data URL Parsing** - Parses data URLs and extracts binary content
4. Lists all stored images with metadata

### Store Image from URL (NEW!)

```json
{
  "action": "storeImageUrl",
  "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/e/eb/N%C3%A1jera_Monasterio_Santa_Mar%C3%ADa_la_Real_400.jpg/1599px-N%C3%A1jera_Monasterio_Santa_Mar%C3%ADa_la_Real_400.jpg?20170208112628",
  "description": "Beautiful Spanish monastery"
}
```

The framework automatically:
- ✅ Detects the URL format
- ✅ Downloads with retries and error handling
- ✅ Extracts MIME type and filename from headers
- ✅ Generates content hash for deduplication
- ✅ Chooses optimal storage (BYTEA for large images)

### Store Text as Binary

```json
{
  "action": "storeText",
  "text": "Hello, smart binary world!",
  "filename": "greeting.txt",
  "description": "Text stored as binary data"
}
```

### List All Images

```json
{"action": "listImages"}
```

Shows all stored images with rich metadata including download source, MIME types, and file sizes.

### Store a File

```bash
yarn run-agent apps/examples/image-storage-demo/dist/AgentModule.js '{
  "action": "storeFile",
  "fileBuffer": "SGVsbG8gV29ybGQh", 
  "filename": "hello.txt",
  "mimeType": "text/plain",
  "description": "A simple text file"
}'
```

### Delete an Image

```bash
yarn run-agent apps/examples/image-storage-demo/dist/AgentModule.js '{
  "action": "deleteImage",
  "imageId": "your-image-id-here"
}'
```

## API Reference

### Available Actions

| Action | Description | Required Fields | New in Phase 2A |
|--------|-------------|----------------|-----------------|
| `demo` | Smart binary storage demo (URLs, base64, data URLs) | None | ✅ Updated |
| `storeImageUrl` | Store image from URL (auto-download) | `url` | ✅ NEW |
| `listImages` | List stored images with metadata | None | ✅ Enhanced |
| `storeText` | Store text as binary data | `text` | ✅ Updated |

### Smart Data Processing

The framework automatically detects and processes:

- **URLs** (`http://` or `https://`) → Downloaded with retries and error handling
- **Base64 strings** → Decoded to Buffer objects  
- **Data URLs** (`data:image/png;base64,xxx`) → Parsed and converted
- **Buffer objects** → Optimally stored (JSON vs BYTEA based on size)
- **Regular JSON** → Unchanged behavior

### Unified Interface

All data types use the same simple interface:
```typescript
await ctx.memory.semantic.set(key, { 
    data: anyDataType,  // URL, base64, Buffer, data URL, or JSON
    description: 'optional'
}, { tags: ['optional'] });
```

## Code Integration

### Using the Helper Functions

```typescript
import { storeImage, getImage, listImages } from '@callagent/memory-sql/BlobStorageHelpers';

// In your agent
export default createAgent({
    async handleTask(ctx) {
        const sqlAdapter = (ctx.memory.semantic as any).backends?.sql;
        
        // Store an image
        await storeImage(sqlAdapter, 'my-image-id', imageBuffer, {
            tags: ['photo', 'user-upload'],
            metadata: {
                filename: 'vacation.jpg',
                description: 'Beach vacation photo'
            }
        });
        
        // Retrieve it
        const result = await getImage(sqlAdapter, 'my-image-id');
        if (result) {
            console.log('Image size:', result.buffer.length);
            console.log('Metadata:', result.metadata);
        }
    }
});
```

### Direct Adapter Usage

```typescript
// Direct access to blob methods (after Prisma client regeneration)
const sqlAdapter = (ctx.memory.semantic as any).backends?.sql;

// Store binary data
await sqlAdapter.setBlob('file-key', buffer, { 
    filename: 'document.pdf',
    mimeType: 'application/pdf' 
});

// Retrieve binary data
const result = await sqlAdapter.getBlob('file-key');
```

## Architecture Notes

### Where Images Are Stored

Images are stored using the **distributed memory architecture** we discussed:

1. **Database (BYTEA field)**: The actual binary data
2. **Semantic Memory**: Metadata, tags, and searchable properties
3. **Episodic Memory**: Events like "image uploaded", "image accessed"
4. **Embed Memory**: Vector embeddings (if vision processing is enabled)

### Memory Lifecycle Orchestrator (MLO) Integration

The blob storage works seamlessly with the MLO pipeline:

- **Acquisition**: Validates and filters binary data
- **Encoding**: Can extract features using vision models (future)
- **Derivation**: Generates metadata and insights
- **Retrieval**: Optimizes binary data access
- **Utilization**: Supports RAG with multimodal content

### Performance Characteristics

- ✅ **Transactional integrity**: Binary data and metadata stored atomically
- ✅ **Efficient queries**: Optimized indexes for blob operations  
- ✅ **Tenant isolation**: Complete data separation per tenant
- ✅ **Scalable**: Handles files up to PostgreSQL's BYTEA limits (~1GB)

## Next Steps

This implementation provides the foundation for:

1. **Vision processing**: Extract features from images using AI models
2. **Multimodal agents**: Combine text and image understanding
3. **File management**: Build document processing workflows
4. **Asset pipelines**: Integrate with existing asset management systems

## Troubleshooting

### "blobData does not exist" errors

If you see TypeScript errors about `blobData` not existing, you need to regenerate the Prisma client:

```bash
yarn workspace @callagent/memory-sql prisma generate
```

### Database errors

Make sure you've run the migration:

```bash
yarn workspace @callagent/memory-sql prisma migrate dev --name add-blob-storage
```

### Performance considerations

For very large files (>10MB), consider:
- Using streaming for uploads/downloads  
- Implementing compression
- Adding file size limits
- Using external storage (S3, etc.) for huge files 
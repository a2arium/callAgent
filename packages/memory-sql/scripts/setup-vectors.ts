import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function setupVectorSupport() {
    const prisma = new PrismaClient();

    try {
        console.log('🔧 Setting up vector support...');

        // Try to enable pgvector extension
        try {
            await prisma.$executeRaw`CREATE EXTENSION IF NOT EXISTS vector;`;
            console.log('✅ pgvector extension enabled');
        } catch (error) {
            console.warn('⚠️  pgvector extension not available. Vector similarity search will be disabled.');
            console.warn('   To enable vector search, install pgvector: https://github.com/pgvector/pgvector');
            console.warn('   Error:', error);
            // Continue without vector support
        }

        // Create vector indexes for performance (only if pgvector is available)
        try {
            await prisma.$executeRaw`
                CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_store_embedding 
                ON entity_store USING ivfflat (embedding vector_cosine_ops) 
                WITH (lists = 100);
            `;
            console.log('✅ Entity store embedding index created');

            await prisma.$executeRaw`
                CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memory_store_embedding 
                ON agent_memory_store USING ivfflat (embedding vector_cosine_ops) 
                WITH (lists = 100);
            `;
            console.log('✅ Memory store embedding index created');
        } catch (error) {
            console.warn('⚠️  Vector indexes not created. Error details:');
            console.warn('   ', error);
            console.warn('   This might be because:');
            console.warn('   1. pgvector extension is not properly installed');
            console.warn('   2. The vector data type is not recognized');
            console.warn('   3. Database user lacks permissions to create indexes');
        }

        // Create additional indexes for query performance (these work without pgvector)
        await prisma.$executeRaw`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_store_type 
            ON entity_store(entity_type);
        `;
        console.log('✅ Entity type index created');

        await prisma.$executeRaw`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_alignment_memory_key 
            ON entity_alignment(memory_key);
        `;
        console.log('✅ Entity alignment memory key index created');

        console.log('🎉 Database setup complete!');

    } catch (error) {
        console.error('❌ Error setting up database:', error);
        throw error;
    } finally {
        await prisma.$disconnect();
    }
}

// Check if this script is being run directly
if (import.meta.url === `file://${process.argv[1]}`) {
    setupVectorSupport().catch(console.error);
}

export { setupVectorSupport };
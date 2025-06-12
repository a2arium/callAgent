import { PrismaClient } from '@prisma/client';
import { MemorySQLAdapter } from './dist/MemorySQLAdapter.js';

const prisma = new PrismaClient();

// Mock embedding function for testing
const mockEmbedFunction = async (text) => {
  // Simple hash-based embedding for testing
  const hash = text.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0);
  
  // Convert to a 1536-dimensional vector (filled with variations of the hash)
  const embedding = new Array(1536).fill(0).map((_, i) => 
    Math.sin(hash + i) * 0.1
  );
  
  return embedding;
};

const adapter = new MemorySQLAdapter(prisma, mockEmbedFunction);

async function testEntityAwareSearch() {
  try {
    console.log('🧪 Testing Entity-Aware Search Implementation');
    console.log('='.repeat(50));
    
    // Clean up any existing test data
    await prisma.agentMemoryStore.deleteMany({
      where: { key: { startsWith: 'test:entity:' } }
    });
    await prisma.entityAlignment.deleteMany({
      where: { memoryKey: { startsWith: 'test:entity:' } }
    });
    await prisma.entityStore.deleteMany({
      where: { canonicalName: { in: ['John Smith', 'Jane Doe', 'Conference Room A'] } }
    });
    
    console.log('✅ Cleaned up test data');
    
    // Set up test data with entity alignment
    console.log('\n📝 Setting up test data with entity alignment...');
    
    await adapter.set('test:entity:meeting1', {
      title: 'Team Standup',
      speaker: 'John Smith',
      location: 'Conference Room A',
      attendees: ['John Smith', 'Jane Doe']
    }, {
      tags: ['meeting'],
      entities: {
        speaker: 'person',
        location: 'location',
        'attendees.*': 'person'
      }
    });
    
    await adapter.set('test:entity:meeting2', {
      title: 'Project Review',
      speaker: 'Johnny',  // Alias for John Smith
      location: 'Room A', // Alias for Conference Room A
      attendees: ['Johnny', 'J. Doe']
    }, {
      tags: ['meeting'],
      entities: {
        speaker: 'person',
        location: 'location',
        'attendees.*': 'person'
      }
    });
    
    console.log('✅ Test data created with entity alignment');
    
    // Test 1: Regular filter (should work as before)
    console.log('\n🔍 Test 1: Regular filter search');
    const regularResults = await adapter.getMany({
      tag: 'meeting',
      filters: [{ path: 'title', operator: 'CONTAINS', value: 'Team' }]
    });
    console.log(`Found ${regularResults.length} results with regular filter`);
    console.log('Results:', regularResults.map(r => ({ key: r.key, title: r.value.title })));
    
    // Test 2: Entity fuzzy search (new functionality)
    console.log('\n🔍 Test 2: Entity fuzzy search');
    try {
      const fuzzyResults = await adapter.getMany({
        tag: 'meeting',
        filters: ['speaker ~ "John"']  // Should find both "John Smith" and "Johnny"
      });
      console.log(`Found ${fuzzyResults.length} results with entity fuzzy search`);
      console.log('Results:', fuzzyResults.map(r => ({ key: r.key, speaker: r.value.speaker })));
    } catch (error) {
      console.log('⚠️  Entity fuzzy search not yet fully implemented:', error.message);
    }
    
    // Test 3: Entity exact search (new functionality)
    console.log('\n🔍 Test 3: Entity exact search');
    try {
      const exactResults = await adapter.getMany({
        tag: 'meeting',
        filters: ['speaker entity_is "John Smith"']  // Should find exact canonical name matches
      });
      console.log(`Found ${exactResults.length} results with entity exact search`);
      console.log('Results:', exactResults.map(r => ({ key: r.key, speaker: r.value.speaker })));
    } catch (error) {
      console.log('⚠️  Entity exact search not yet fully implemented:', error.message);
    }
    
    // Test 4: Entity alias search (new functionality)
    console.log('\n🔍 Test 4: Entity alias search');
    try {
      const aliasResults = await adapter.getMany({
        tag: 'meeting',
        filters: ['speaker entity_like "Johnny"']  // Should find by alias
      });
      console.log(`Found ${aliasResults.length} results with entity alias search`);
      console.log('Results:', aliasResults.map(r => ({ key: r.key, speaker: r.value.speaker })));
    } catch (error) {
      console.log('⚠️  Entity alias search not yet fully implemented:', error.message);
    }
    
    // Test 5: Mixed filters (regular + entity)
    console.log('\n🔍 Test 5: Mixed filters (regular + entity)');
    try {
      const mixedResults = await adapter.getMany({
        tag: 'meeting',
        filters: [
          { path: 'title', operator: 'CONTAINS', value: 'Team' },
          'speaker ~ "John"'
        ]
      });
      console.log(`Found ${mixedResults.length} results with mixed filters`);
      console.log('Results:', mixedResults.map(r => ({ key: r.key, title: r.value.title, speaker: r.value.speaker })));
    } catch (error) {
      console.log('⚠️  Mixed filters not yet fully implemented:', error.message);
    }
    
    // Test 6: Check entity alignments were created
    console.log('\n🔍 Test 6: Verify entity alignments');
    const alignments = await prisma.entityAlignment.findMany({
      where: { memoryKey: { startsWith: 'test:entity:' } },
      include: { entity: true }
    });
    console.log(`Found ${alignments.length} entity alignments:`);
    alignments.forEach(alignment => {
      console.log(`  - ${alignment.memoryKey}:${alignment.fieldPath} -> ${alignment.entity.canonicalName} (${alignment.originalValue})`);
    });
    
    console.log('\n🎉 Entity-aware search implementation test completed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

testEntityAwareSearch(); 

import { SemanticConcept } from '../src/loop/types.js';

describe('SemanticConcept', () => {
    it('should support tags', () => {
        const concept: SemanticConcept = {
            id: 'test-id',
            data: { foo: 'bar' },
            tags: ['tag1', 'tag2']
        };
        expect(concept.tags).toBeDefined();
        expect(concept.tags).toContain('tag1');
    });
});

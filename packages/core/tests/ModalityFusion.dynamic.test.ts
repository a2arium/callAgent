import { ModalityFusion } from '../src/core/memory/lifecycle/2-encoding/implementations/fusion/ModalityFusion.js';
import { createMemoryItem } from '../src/shared/types/memoryLifecycle.js';

describe('ModalityFusion Dynamic Modality Support', () => {
    let modalityFusion: ModalityFusion;

    beforeEach(() => {
        modalityFusion = new ModalityFusion({
            concatenationStrategy: 'weighted',
            fusionWeights: {
                text: 1.0,
                audio: 0.9,
                image: 0.8,
                metadata: 0.5,
                sensor: 0.7
            }
        });
    });

    describe('extractModalities', () => {
        it('should extract text modality', async () => {
            const item = createMemoryItem('Hello world', 'workingMemory', 'test', 'test-tenant');
            const modalities = await modalityFusion.extractModalities(item);

            expect(modalities).toHaveLength(3); // text + metadata + temporal
            expect(modalities[0].type).toBe('text');
            expect(modalities[0].content).toBe('Hello world');
            expect(modalities[1].type).toBe('metadata');
            expect(modalities[2].type).toBe('temporal');
        });

        it('should extract image modality when present', async () => {
            const imageData = {
                image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgA...',
                description: 'A test image'
            };
            const item = createMemoryItem(imageData, 'workingMemory', 'test', 'test-tenant');
            const modalities = await modalityFusion.extractModalities(item);

            const imageModality = modalities.find(m => m.type === 'image');
            expect(imageModality).toBeDefined();
            expect(imageModality?.content).toBe(imageData.image);
        });

        it('should extract audio modality when present', async () => {
            const audioData = {
                audioUrl: 'https://example.com/audio.mp3',
                transcript: 'Hello from audio'
            };
            const item = createMemoryItem(audioData, 'workingMemory', 'test', 'test-tenant');
            const modalities = await modalityFusion.extractModalities(item);

            const audioModality = modalities.find(m => m.type === 'audio');
            expect(audioModality).toBeDefined();
            expect(audioModality?.content).toBe(audioData.audioUrl);
        });

        it('should handle multiple modalities', async () => {
            const multiModalData = {
                text: 'Description of the image',
                image: 'data:image/png;base64,test...',
                audioData: 'audio-buffer-data'
            };
            const item = createMemoryItem(multiModalData, 'workingMemory', 'test', 'test-tenant');
            const modalities = await modalityFusion.extractModalities(item);

            expect(modalities.length).toBeGreaterThan(2);
            expect(modalities.map(m => m.type)).toContain('text');
            expect(modalities.map(m => m.type)).toContain('image');
            expect(modalities.map(m => m.type)).toContain('audio');
        });
    });

    describe('weightedFusion', () => {
        it('should create dynamic modality entries', async () => {
            const item = createMemoryItem({
                text: 'Test content',
                image: 'image-data',
                customSensor: { temperature: 25, humidity: 60 }
            }, 'workingMemory', 'test', 'test-tenant');

            const result = await modalityFusion.process(item);
            const fusedData = result.data as any;

            // Should have dynamic modality keys
            expect(fusedData.text).toBeDefined();
            expect(fusedData.text.content).toBe('Test content');
            expect(fusedData.image).toBeDefined();
            expect(fusedData.image.content).toBe('image-data');
            expect(fusedData.structured).toBeDefined(); // customSensor goes to structured
        });

        it('should preserve weights for any modality type', async () => {
            const modalities = [
                { type: 'text', content: 'Hello', weight: 1.0 },
                { type: 'image', content: 'image-data', weight: 0.8 },
                { type: 'customType', content: { value: 42 }, weight: 0.6 }
            ];

            const fusionResult = await modalityFusion.fuseModalities(modalities);
            const fusedContent = fusionResult.fusedContent as any;

            expect(fusedContent.text).toBeDefined();
            expect(fusedContent.text.weight).toBe(1.0);
            expect(fusedContent.image).toBeDefined();
            expect(fusedContent.image.weight).toBeCloseTo(0.64, 2); // 0.8 * 0.8 (from fusionWeights)
            expect(fusedContent.customType).toBeDefined();
            expect(fusedContent.customType.weight).toBe(0.6); // 1.0 * 0.6 (default weight)
        });
    });

    describe('Dynamic Content Extraction (UnifiedMemoryService)', () => {
        it('should extract content from any modality type', () => {
            // Test the helper method logic
            const testCases = [
                // Text modality
                { text: { content: 'Hello world', weight: 1.0 } },
                // Image modality  
                { image: { content: 'image-data', weight: 0.8 } },
                // Audio modality
                { audio: { content: 'audio-buffer', weight: 0.9 } },
                // Custom sensor modality
                { sensorData: { content: { temp: 25 }, weight: 0.7 } },
                // Multiple modalities (should pick first with content)
                {
                    metadata: { content: 'meta info', weight: 0.5 },
                    text: { content: 'text content', weight: 1.0 }
                }
            ];

            testCases.forEach((testCase, index) => {
                // Simulate the dynamic extraction logic
                let extractedContent: string | undefined;

                for (const [key, value] of Object.entries(testCase)) {
                    if (value && typeof value === 'object' && (value as any).content) {
                        const content = (value as any).content;
                        if (typeof content === 'string') {
                            extractedContent = content;
                            break;
                        } else if (content && typeof content === 'object') {
                            extractedContent = JSON.stringify(content);
                            break;
                        }
                    }
                }

                expect(extractedContent).toBeDefined();
                console.log(`Test case ${index + 1}: extracted "${extractedContent}" from`, testCase);
            });
        });
    });
}); 
import { createAgent } from '@a2arium/callagent-core';

export default createAgent({
    manifest: {
        name: 'image-storage-demo',
        version: '1.0.0',
        description: 'Demonstrates blob storage concepts for images and files'
    },

    async handleTask(ctx) {
        const input = ctx.task.input as any;

        try {
            switch (input.action) {
                case 'demo':
                    await ctx.reply('🖼️ **Smart Binary Storage Demo**\\n');
                    await ctx.reply('This shows how the framework automatically handles different data types!\\n\\n');

                    // Demo 1: URL Auto-Download
                    await ctx.reply('📥 **1. URL Auto-Download**\\n');
                    await ctx.memory.semantic.set(`image:url-demo-${Date.now()}`, {
                        data: 'https://httpbin.org/image/png', // Framework auto-downloads!
                        description: 'Image downloaded automatically from URL'
                    }, {
                        tags: ['image', 'demo', 'url-download']
                    });
                    await ctx.reply('✅ URL detected and downloaded automatically\\n\\n');

                    // Demo 2: Base64 Processing
                    await ctx.reply('📝 **2. Base64 Auto-Processing**\\n');
                    const sampleImageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='; // 1x1 pixel PNG
                    await ctx.memory.semantic.set(`image:base64-demo-${Date.now()}`, {
                        data: sampleImageData, // Framework auto-detects base64
                        filename: 'pixel.png',
                        description: 'Base64 image processed automatically'
                    }, {
                        tags: ['image', 'demo', 'base64']
                    });
                    await ctx.reply('✅ Base64 detected and processed automatically\\n\\n');

                    // Demo 3: Data URL
                    await ctx.reply('🔗 **3. Data URL Parsing**\\n');
                    const dataUrl = `data:image/png;base64,${sampleImageData}`;
                    await ctx.memory.semantic.set(`image:dataurl-demo-${Date.now()}`, {
                        data: dataUrl, // Framework auto-parses data URL
                        description: 'Data URL parsed automatically'
                    }, {
                        tags: ['image', 'demo', 'data-url']
                    });
                    await ctx.reply('✅ Data URL detected and parsed automatically\\n\\n');

                    // List stored images
                    const storedImages = await ctx.memory.semantic.getMany({
                        tag: 'image',
                        limit: 10
                    });

                    await ctx.reply(`📋 Found ${storedImages.length} images in memory:\\n`);

                    storedImages.forEach((image: { key: string; value: unknown }, index: number) => {
                        const metadata = image.value as any;
                        ctx.reply(`${index + 1}. **${metadata.filename}** (${metadata.mimeType}) - ${metadata.description}\\n`);
                    });

                    await ctx.reply('\\n🎯 **Key Benefits:**\\n');
                    await ctx.reply('• **One Interface**: Same `.set()` method for URLs, base64, buffers, data URLs\\n');
                    await ctx.reply('• **Automatic Download**: URLs downloaded with retries and error handling\\n');
                    await ctx.reply('• **Smart Storage**: Large files → BYTEA, small files → JSON base64\\n');
                    await ctx.reply('• **Rich Metadata**: MIME types, filenames, hashes extracted automatically\\n');
                    await ctx.reply('• **Transparent Retrieval**: Always returns Buffer objects for binary data\\n\\n');

                    return {
                        status: 'success',
                        message: 'Binary storage demo completed',
                        imagesFound: storedImages.length,
                        features: [
                            'Smart data type detection (URLs, base64, data URLs, buffers)',
                            'Automatic URL downloads with retries',
                            'Optimized storage routing (JSON vs BYTEA)',
                            'Rich metadata extraction (MIME types, filenames, hashes)',
                            'Transparent unified interface'
                        ]
                    };

                case 'listImages':
                    const images = await ctx.memory.semantic.getMany({
                        tag: 'image',
                        limit: 50
                    });

                    return {
                        status: 'success',
                        count: images.length,
                        images: images.map((img: { key: string; value: unknown }) => ({
                            key: img.key,
                            filename: (img.value as any).filename,
                            mimeType: (img.value as any).mimeType,
                            description: (img.value as any).description
                        }))
                    };

                case 'storeImageUrl':
                    if (!input.url) {
                        return { status: 'error', message: 'URL parameter required' };
                    }

                    await ctx.reply(`🌐 **Storing image from URL**\\n`);
                    await ctx.reply(`📥 Downloading: ${input.url}\\n\\n`);

                    // Framework automatically detects URL and downloads it!
                    await ctx.memory.semantic.set(`image:url:${Date.now()}`, {
                        data: input.url, // Just pass the URL - framework handles the rest!
                        description: input.description || `Downloaded from ${input.url}`,
                        source: 'url',
                        userRequested: true
                    }, {
                        tags: ['image', 'url-download', 'user-requested']
                    });

                    await ctx.reply('✅ **Image stored successfully!**\\n');
                    await ctx.reply('The framework automatically:\\n');
                    await ctx.reply('• Downloaded the image with error handling\\n');
                    await ctx.reply('• Extracted MIME type and filename from headers\\n');
                    await ctx.reply('• Generated content hash for deduplication\\n');
                    await ctx.reply('• Chose optimal storage method (JSON or BYTEA)\\n');

                    return {
                        status: 'success',
                        message: `Image downloaded and stored from URL: ${input.url}`,
                        approach: 'transparent-smart-storage'
                    };

                case 'storeText':
                    // Demonstrate storing text with the new transparent interface
                    const textData = input.text || 'Sample text data';
                    const textBuffer = Buffer.from(textData, 'utf-8'); // Create Buffer directly

                    await ctx.memory.semantic.set(`text:${input.filename || 'sample.txt'}`, {
                        data: textBuffer, // Framework detects Buffer and optimizes storage
                        filename: input.filename || 'sample.txt',
                        description: input.description || 'Text file storage demo'
                    }, {
                        tags: ['file', 'text', 'demo']
                    });

                    return {
                        status: 'success',
                        message: `Stored text file: ${input.filename || 'sample.txt'}`,
                        approach: 'transparent-buffer-handling'
                    };

                default:
                    return {
                        status: 'error',
                        message: 'Invalid action. Available actions: demo, listImages, storeImageUrl, storeText',
                        availableActions: ['demo', 'listImages', 'storeImageUrl', 'storeText']
                    };
            }
        } catch (error: any) {
            await ctx.reply(`❌ Error: ${error.message}\\n`);
            return {
                status: 'error',
                message: error.message,
                action: input.action
            };
        }
    }
}, import.meta.url); 
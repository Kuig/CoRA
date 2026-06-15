import * as assert from 'assert';
import { RagEngine } from '../ragEngine';

suite('RagEngine (Core) Test Suite', function() {
    this.timeout(60000);
    let ragEngine: RagEngine;

    // Executed once before all tests in the suite
    suiteSetup(async function() {
        // Increase the timeout to 60 seconds for initialization.
        // The first time the tests run, Transformers.js will download the model (~90MB).
        this.timeout(60000); 
        
        ragEngine = new RagEngine();
        await ragEngine.initialize();
    });

    // Clears memory between tests to prevent overlaps
    teardown(() => {
        ragEngine.clearMemory();
    });

    test('1. Vector generation and storage in memory', async () => {
        const testFileName = 'space_notes.md';
        const testChunks = [
            'The solar system includes the Sun and the celestial bodies that orbit around it.',
            'Mars is the fourth planet of the solar system, also known as the Red Planet.'
        ];

        // Add documents to the engine (calculates embeddings in background)
        await ragEngine.addDocument(testFileName, testChunks);

        // To indirectly verify that vectors were created,
        // we execute a generic query and check if it returns results.
        const results = await ragEngine.processQuery('planet');
        
        assert.ok(results.length > 0, 'There should be results in the vector store');
        assert.strictEqual(results[0].source, testFileName, 'The source file name must match');
    });

    test('2. Cosine Similarity Accuracy (Smart Context)', async () => {
        const testFileName = 'biology.md';
        const testChunks = [
            'Mitochondria are the cellular organelles responsible for respiration and energy production (ATP).',
            'DNA is the molecule that contains the genetic instructions necessary for the development and functioning of organisms.',
            'Photosynthesis is the process through which plants produce glucose from light, water, and carbon dioxide.'
        ];

        await ragEngine.addDocument(testFileName, testChunks);

        // Test A: Query focused on genetics
        const geneticsResults = await ragEngine.processQuery('genetic code and chromosomes', 1);
        assert.strictEqual(geneticsResults.length, 1);
        assert.ok(
            geneticsResults[0].text.includes('DNA'), 
            'The "genetics" query must return the DNA chunk.'
        );

        // Test B: Query focused on plants
        const plantsResults = await ragEngine.processQuery('how trees feed themselves using the sun', 1);
        assert.ok(
            plantsResults[0].text.includes('Photosynthesis'), 
            'The query about plants must return the photosynthesis chunk.'
        );
    });

    test('3. Confidence threshold filtering (Avoiding false positives)', async () => {
        const testFileName = 'recipes.txt';
        const testChunks = [
            'To make carbonara you need guanciale, pecorino, eggs, and black pepper.',
            'Neapolitan pizza requires dough leavened for at least 24 hours.'
        ];

        await ragEngine.addDocument(testFileName, testChunks);

        // We execute a completely unrelated query (e.g., Computer Science)
        const outOfContextResults = await ragEngine.processQuery('Object-oriented programming languages like Java', 3);

        // The engine should filter out all results because the Cosine Similarity score
        // will be lower than the set threshold (>0.3 in your ragEngine.ts)
        assert.strictEqual(outOfContextResults.length, 0, 'It must not return anything if the context is totally irrelevant');
    });

    test('4. Dynamic document removal (mock FileSystemWatcher)', async () => {
        await ragEngine.addDocument('file_to_keep.txt', ['This file must remain in memory.']);
        await ragEngine.addDocument('file_to_delete.txt', ['This text will be deleted shortly.']);

        // Verify that both are present by answering a broad query
        let results = await ragEngine.processQuery('text file memory');
        assert.strictEqual(results.length, 2, 'Initially there should be 2 chunks in memory');

        // Simulate document deletion
        ragEngine.removeDocument('file_to_delete.txt');

        // Re-execute query
        results = await ragEngine.processQuery('text file memory');
        assert.strictEqual(results.length, 1, 'Only 1 chunk should remain after removal');
        assert.strictEqual(results[0].source, 'file_to_keep.txt', 'The remaining file must be the correct one');
    });
});
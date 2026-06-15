import * as vscode from 'vscode';
import { logInfo, logAction, logSuccess, logError, logWarning, logAi } from './logger';

export interface VectorRecord {
    id: string;
    fileName: string;
    text: string;
    embedding: number[];
    pinned?: boolean;
    hidden?: boolean;
    doi?: string;
    url?: string;
}

export interface SearchResult {
    text: string;
    source: string;
    score: number;
    doi?: string;
    url?: string;
}

export class RagEngine {
    private _vectorStore: VectorRecord[] = [];
    private _isReady: boolean = false;
    private _threshold = 0.43;
    private _topK = 5;
    private _ollamaEndpoint = 'http://localhost:11434/api/embed';
    private _modelName = 'bge-m3';
    private _ollamaPort = 11434;
    private _filterTitles = true;

    constructor() {}

    public setModelAndPort(modelName: string, port: number) {
        this._modelName = modelName;
        this._ollamaPort = port;
        this._ollamaEndpoint = `http://localhost:${port}/api/embed`;
        this._isReady = false; // Reset ready state to force tag checks and preload
        logInfo(`RAG Engine configured to use Ollama port ${port} with model "${modelName}"`);
    }

    public setThreshold(val: number) {
        this._threshold = val;
    }

    public setTopK(val: number) {
        this._topK = val;
    }

    public setFilterTitles(val: boolean) {
        this._filterTitles = val;
    }

    public async getEmbeddings(texts: string[]): Promise<number[][]> {
        if (!this._isReady || texts.length === 0) {
            return [];
        }
        try {
            logAi(`Calculating embeddings for ${texts.length} text segments...`);
            const response = await fetch(this._ollamaEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this._modelName,
                    input: texts
                })
            });
            if (!response.ok) {
                throw new Error(`Ollama API error: ${response.status}`);
            }
            const result = await response.json() as any;
            return result.embeddings;
        } catch (err: any) {
            logError(`Failed to fetch embeddings: ${err?.message || err}`);
            return [];
        }
    }

    /**
     * Verifies connection to Ollama and ensures the model is pulled.
     */
    public async initialize() {
        if (this._isReady) {
            return;
        }

        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "CoRA: Connecting to local Ollama server...",
            cancellable: false
        }, async () => {
            try {
                const response = await fetch(`http://localhost:${this._ollamaPort}/api/tags`);
                if (!response.ok) {
                    throw new Error('Ollama endpoint unreachable');
                }
                
                const data = await response.json() as any;
                const hasModel = data.models.some((m: any) => m.name.includes(this._modelName));
                
                if (!hasModel) {
                    const errorMsg = `Model '${this._modelName}' not found in Ollama. Please run 'ollama pull ${this._modelName}' in your terminal.`;
                    logWarning(errorMsg);
                    vscode.window.showWarningMessage(`CoRA: ${errorMsg}`);
                } else {
                    this._isReady = true;
                    
                    // Warm up the model by sending a dummy embedding query
                    try {
                        await fetch(this._ollamaEndpoint, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ model: this._modelName, input: 'preload' })
                        });
                        logSuccess(`Model ${this._modelName} preloaded successfully.`);
                    } catch (e: any) {
                        logWarning(`Model warm-up failed: ${e?.message || e}`);
                    }

                    vscode.window.showInformationMessage(`CoRA: Connected to Ollama (${this._modelName}) successfully!`);
                }
            } catch (error: any) {
                const errorMsg = 'Could not connect to Ollama. Make sure Ollama is running locally (http://localhost:11434).';
                logError(`${errorMsg} Details: ${error?.message || error}`);
                vscode.window.showErrorMessage(`CoRA: ${errorMsg}`);
            }
        });
    }

    /**
     * Batch processes text segments, gets their embeddings, and saves them in-memory.
     */
    public async addDocument(fileName: string, chunks: string[], doi?: string, url?: string) {
        if (!this._isReady) {
            logWarning('Ollama engine is not ready. Skipping document indexing.');
            return;
        }

        // Deduplicate chunks to save embeddings API calls and prevent duplicates in vectorStore
        const uniqueChunks: string[] = [];
        const seen = new Set<string>();
        for (const chunk of chunks) {
            if (!seen.has(chunk)) {
                seen.add(chunk);
                uniqueChunks.push(chunk);
            }
        }

        if (uniqueChunks.length === 0) {
            return;
        }

        // Clean up any existing vectors for this file to prevent duplicates
        this.removeDocument(fileName);

        try {
            logAi(`Requesting vectors for ${fileName} (${uniqueChunks.length} chunks)...`);
            const response = await fetch(this._ollamaEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this._modelName,
                    input: uniqueChunks
                })
            });

            if (!response.ok) {
                throw new Error(`Ollama API error: ${response.status}`);
            }
            
            const result = await response.json() as any;
            const embeddings: number[][] = result.embeddings;
            
            for (let i = 0; i < uniqueChunks.length; i++) {
                this._vectorStore.push({
                    id: `${fileName}-${i}`,
                    fileName: fileName,
                    text: uniqueChunks[i],
                    embedding: embeddings[i],
                    doi: doi,
                    url: url
                });
            }
            logSuccess(`Successfully indexed ${uniqueChunks.length} chunks for ${fileName}.`);
        } catch (err: any) {
            logError(`Failed to index document ${fileName}: ${err?.message || err}`);
        }
    }

    /**
     * Removes all vectors associated with a specific file.
     */
    public removeDocument(fileName: string) {
        const initialLength = this._vectorStore.length;
        this._vectorStore = this._vectorStore.filter(record => record.fileName !== fileName);
        logInfo(`Removed ${initialLength - this._vectorStore.length} vector chunks for ${fileName}`);
    }

    /**
     * Clears all vectorized records from memory.
     */
    public clearMemory() {
        this._vectorStore = [];
        logInfo('Vector store memory cleared.');
    }

    /**
     * Exports vector records of a specific file for cache persistence.
     */
    public exportVectors(fileName: string): VectorRecord[] {
        return this._vectorStore.filter(record => record.fileName === fileName);
    }

    public importVectors(records: VectorRecord[]) {
        if (records.length > 0) {
            this.removeDocument(records[0].fileName);
        }
        
        // Deduplicate records by text to clean up any legacy duplicates in cache.json
        const seen = new Set<string>();
        const uniqueRecords = records.filter(r => {
            if (seen.has(r.text)) {
                return false;
            }
            seen.add(r.text);
            return true;
        });

        this._vectorStore.push(...uniqueRecords);
        logInfo(`Imported ${uniqueRecords.length} chunks into vector store from cache.`);
    }

    /**
     * Updates record state (pinned/hidden/normal) in memory by searching text.
     */
    public updateRecordState(text: string, state: 'pinned' | 'hidden' | 'normal'): VectorRecord | undefined {
        const record = this._vectorStore.find(r => r.text === text);
        if (record) {
            if (state === 'pinned') {
                record.pinned = true;
                record.hidden = false;
            } else if (state === 'hidden') {
                record.pinned = false;
                record.hidden = true;
            } else {
                record.pinned = false;
                record.hidden = false;
            }
            logInfo(`Snippet state set to "${state}" for document ${record.fileName}`);
            return record;
        }
        return undefined;
    }

    /**
     * Returns all pinned records.
     */
    public getPinnedRecords(): { text: string; source: string }[] {
        return this._vectorStore
            .filter(r => r.pinned === true)
            .map(r => ({ text: r.text, source: r.fileName }));
    }

    /**
     * Returns all hidden records.
     */
    public getHiddenRecords(): { text: string; source: string }[] {
        return this._vectorStore
            .filter(r => r.hidden === true)
            .map(r => ({ text: r.text, source: r.fileName }));
    }

    /**
     * Queries the RAG engine for matches against query text.
     */
    public async processQuery(queryText: string, topK?: number): Promise<SearchResult[]> {
        if (!this._isReady || this._vectorStore.length === 0) {
            return [];
        }

        const actualTopK = topK ?? this._topK;

        try {
            logAi(`Querying local vector store...`);
            const response = await fetch(this._ollamaEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this._modelName,
                    input: queryText
                })
            });
            if (!response.ok) {
                throw new Error(`Ollama API error: ${response.status}`);
            }
            
            const result = await response.json() as any;
            const queryEmbedding: number[] = result.embeddings[0];

            const scoredRecords = this._vectorStore.map(record => {
                const score = this.cosineSimilarity(queryEmbedding, record.embedding);
                return { ...record, score };
            });

            scoredRecords.sort((a, b) => b.score - a.score);

            const seenTexts = new Set<string>();
            const results = scoredRecords
                .filter(r => {
                    if (r.score <= this._threshold || r.pinned || r.hidden) {
                        return false;
                    }
                    if (this._filterTitles && /^\s*#+/i.test(r.text)) {
                        return false;
                    }
                    if (seenTexts.has(r.text)) {
                        return false;
                    }
                    seenTexts.add(r.text);
                    return true;
                })
                .slice(0, actualTopK)
                .map(r => ({
                    text: r.text,
                    source: r.fileName,
                    score: r.score,
                    doi: r.doi,
                    url: r.url
                }));

            return results;

        } catch (error: any) {
            logError(`RAG query failed: ${error?.message || error}`);
            return [];
        }
    }

    /**
     * Calculates cosine similarity between two numeric vectors.
     */
    public cosineSimilarity(vecA: number[], vecB: number[]): number {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) {
            return 0;
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}
import * as vscode from 'vscode';
import { SettingsManager } from './settingsManager';
import { DocumentConverter } from './documentConverter';
import { logInfo, logAction, logSuccess, logError, logSave, logWarning, logIdle } from './logger';

export interface CachedRecord {
    id: string;
    fileName: string;
    text: string;
    embedding: number[];
    pinned?: boolean;
    hidden?: boolean;
    doi?: string;
    url?: string;
}

export interface CacheData {
    [fileName: string]: {
        mtime: number; // Last modified timestamp of the file
        records: CachedRecord[]; // Vectorized chunks
    };
}

export class VectorCache {
    private _data: CacheData = {};
    private _modelName: string = 'bge-m3';

    constructor(data?: CacheData, modelName?: string) {
        if (data) {
            this._data = data;
        }
        if (modelName) {
            this._modelName = modelName;
        }
    }

    public get(fileName: string) {
        return this._data[fileName];
    }

    public set(fileName: string, mtime: number, records: CachedRecord[]) {
        this._data[fileName] = { mtime, records };
    }

    public delete(fileName: string) {
        delete this._data[fileName];
    }

    public keys(): string[] {
        return Object.keys(this._data);
    }

    public has(fileName: string): boolean {
        return !!this._data[fileName];
    }

    /**
     * Loads the cache file from disk, converting Base64 embeddings back to numbers.
     * Invalidates the cache if the stored model name does not match currentModelName.
     */
    public static async load(uri: vscode.Uri, currentModelName: string): Promise<VectorCache> {
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            const parsed = JSON.parse(Buffer.from(data).toString('utf8'));
            
            let modelName = 'bge-m3';
            let files: any = {};
            
            if (parsed.metadata && parsed.files) {
                modelName = parsed.metadata.modelName;
                files = parsed.files;
            } else {
                files = parsed;
                modelName = 'unknown';
            }

            if (modelName !== currentModelName) {
                logWarning(`Model mismatch in cache. Stored: "${modelName}", Current: "${currentModelName}". Invalidating cache.`);
                const emptyCache = new VectorCache({}, currentModelName);
                await emptyCache.save(uri);
                return emptyCache;
            }

            const cache: CacheData = {};
            for (const file of Object.keys(files)) {
                cache[file] = {
                    mtime: files[file].mtime,
                    records: files[file].records.map((r: any) => {
                        let embedding: number[] = [];
                        if (r.embeddingBase64) {
                            const buffer = Buffer.from(r.embeddingBase64, 'base64');
                            const float32 = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / Float32Array.BYTES_PER_ELEMENT);
                            embedding = Array.from(float32);
                        } else if (r.embedding) {
                            embedding = r.embedding; 
                        }
                        
                        return {
                            id: r.id,
                            fileName: r.fileName,
                            text: r.text,
                            embedding: embedding,
                            pinned: r.pinned,
                            hidden: r.hidden,
                            doi: r.doi,
                            url: r.url
                        };
                    })
                };
            }
            logSuccess('Binary vector cache loaded successfully.');
            return new VectorCache(cache, currentModelName);
        } catch (err) {
            logInfo('No vector cache file found or cache corrupted. Starting fresh.');
            const emptyCache = new VectorCache({}, currentModelName);
            await emptyCache.save(uri);
            return emptyCache;
        }
    }

    /**
     * Saves the cache to disk, converting heavy arrays to Base64 to save 70% space and avoid CPU blocks.
     */
    public async save(uri: vscode.Uri): Promise<void> {
        const optimizedCache: any = {};
        for (const file of Object.keys(this._data)) {
            optimizedCache[file] = {
                mtime: this._data[file].mtime,
                records: this._data[file].records.map(r => {
                    const float32 = new Float32Array(r.embedding);
                    return {
                        id: r.id,
                        fileName: r.fileName,
                        text: r.text,
                        embeddingBase64: Buffer.from(float32.buffer).toString('base64'),
                        pinned: r.pinned,
                        hidden: r.hidden,
                        doi: r.doi,
                        url: r.url
                    };
                })
            };
        }
        
        const payload = {
            metadata: {
                modelName: this._modelName
            },
            files: optimizedCache
        };
        
        const data = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(uri, data);
        logSave(`Vector cache written to disk for model "${this._modelName}".`);
    }
}

export class FileManager {
    private _ragEngine: any;
    private _settingsManager: SettingsManager;
    private _documentConverter: DocumentConverter;
    private _watcher: vscode.FileSystemWatcher | undefined;
    private _sourcesUri: vscode.Uri | undefined;
    private _cacheUri: vscode.Uri | undefined;
    private _cache: VectorCache = new VectorCache();
    private _processingCount = 0;
    private _activeModel = 'bge-m3';

    public onSourcesChanged?: () => void | Promise<void>;

    constructor(ragEngine: any, settingsManager: SettingsManager, documentConverter: DocumentConverter, onStatusChange?: (status: string) => void) {
        this._ragEngine = ragEngine;
        this._settingsManager = settingsManager;
        this._documentConverter = documentConverter;
        // The logger dynamically updates status, so we ignore onStatusChange and log directly.
    }

    private _updateStatus() {
        if (this._processingCount > 0) {
            logAction(`Processing sources (${this._processingCount} files)...`);
        } else {
            logIdle();
        }
    }

    /**
     * Initializes the FileManager: scans for the Sources directory, loads the cache,
     * and triggers a differential update of the RAG engine.
     */
    public async initialize() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            logWarning('No workspace folder open. CoRA deactivated.');
            return;
        }

        const rootUri = workspaceFolders[0].uri;
        this._sourcesUri = vscode.Uri.joinPath(rootUri, 'Sources');
        
        const coraFolderUri = vscode.Uri.joinPath(rootUri, '.cora');
        this._cacheUri = vscode.Uri.joinPath(coraFolderUri, 'cache.json');

        const settings = this._settingsManager.getSettings();
        this._activeModel = settings.embeddingsModel || vscode.workspace.getConfiguration('cora').get<string>('embeddingsModel') || 'bge-m3';

        try {
            await vscode.workspace.fs.stat(this._sourcesUri);
            logInfo('Sources folder found. Starting file indexing...');
            
            try {
                await vscode.workspace.fs.stat(coraFolderUri);
            } catch {
                await vscode.workspace.fs.createDirectory(coraFolderUri);
            }

            await this._loadCache();
            await this._scanAllFiles();
            this._setupWatcher();

        } catch (error) {
            logWarning('Sources folder not found. Waiting for folder creation...');
            this._setupRootWatcher(rootUri);
        }
    }

    /**
     * Forces a scan and ignores the current differential cache.
     */
    public async forceScan() {
        if (this._sourcesUri) {
            if (this._ragEngine.clearMemory) {
                this._ragEngine.clearMemory();
            }
            await this._scanAllFiles();
            vscode.window.showInformationMessage('CoRA: Sources synchronized successfully.');
        }
    }

    /**
     * Indexes all supported documents (.md, .txt, .pdf, .tex, .html, .htm) in Sources.
     */
    private async _scanAllFiles() {
        if (!this._sourcesUri) {
            return;
        }

        const pattern = new vscode.RelativePattern(this._sourcesUri, '**/*.{md,txt,pdf,tex,html,htm}');
        const files = await vscode.workspace.findFiles(pattern, '**/Processed/**');

        for (const fileUri of files) {
            await this._processFile(fileUri);
        }
    }

    /**
     * Processes a single file: checks cache validity, converts files if needed, 
     * chunks text, and vectorizes content.
     */
    private async _processFile(fileUri: vscode.Uri) {
        try {
            const stat = await vscode.workspace.fs.stat(fileUri);
            const fileName = fileUri.path.split('/').pop() || 'Unknown';
            const extension = fileName.split('.').pop()?.toLowerCase();

            if (extension === 'pdf' || extension === 'html' || extension === 'htm') {
                try {
                    const settings = this._settingsManager.getSettings();
                    const handling: any = 'discard';
                    const codeParsing = settings.textconverterCodeParsing ?? true;
                    const extractHtml = settings.textconverterExtractHtml ?? true;
                    logInfo(`Converting document ${fileName}...`);
                    await this._documentConverter.convert(fileUri, handling, codeParsing, extractHtml);
                } catch(e: any) {
                    logError(`Failed to convert document ${fileName}: ${e?.message || e}`);
                }
                return; // The converted .md will be picked up by the watcher
            }

            // Check cache differential
            const cached = this._cache.get(fileName);
            if (cached && cached.mtime === stat.mtime) {
                logInfo(`Loaded ${fileName} from vector cache.`);
                if (this._ragEngine.importVectors) {
                    this._ragEngine.importVectors(cached.records);
                }
                if (this._watcher) {
                    this.onSourcesChanged?.();
                }
                return;
            }

            // Indexing modified/new file
            this._processingCount++;
            this._updateStatus();
            
            try {
                const fileData = await vscode.workspace.fs.readFile(fileUri);
                let content = Buffer.from(fileData).toString('utf8');
                
                let doi: string | undefined = undefined;
                let url: string | undefined = undefined;
                const trimmed = content.trim();
                if (trimmed.startsWith('doi:')) {
                    const lines = content.split('\n');
                    doi = lines[0].replace('doi:', '').trim();
                    content = lines.slice(1).join('\n');
                } else if (trimmed.startsWith('url:')) {
                    const lines = content.split('\n');
                    url = lines[0].replace('url:', '').trim();
                    content = lines.slice(1).join('\n');
                }

                const chunks = this._chunkText(content);
                logAction(`Computing vectors for ${fileName} (${chunks.length} chunks)...`);

                if (this._ragEngine.addDocument) {
                    await this._ragEngine.addDocument(fileName, chunks, doi, url);
                }

                if (this._ragEngine.exportVectors) {
                    const newRecords = this._ragEngine.exportVectors(fileName);
                    this._cache.set(fileName, stat.mtime, newRecords);
                    await this._saveCache();
                }
            } finally {
                this._processingCount--;
                this._updateStatus();
                if (this._watcher && this._processingCount === 0) {
                    this.onSourcesChanged?.();
                }
            }

        } catch (error: any) {
            logError(`Failed to index file ${fileUri.fsPath}: ${error?.message || error}`);
        }
    }

    private _chunkText(text: string): string[] {
        const rawChunks = text.split(/\n\s*\n/);
        return rawChunks.map(c => c.trim()).filter(c => c.length > 20);
    }

    private async _loadCache() {
        if (!this._cacheUri) {
            return;
        }
        this._cache = await VectorCache.load(this._cacheUri, this._activeModel);
    }

    private async _saveCache() {
        if (!this._cacheUri) {
            return;
        }
        try {
            await this._cache.save(this._cacheUri);
        } catch (err: any) {
            logError(`Failed to save vector cache: ${err?.message || err}`);
        }
    }

    /**
     * Updates state (pinned/hidden/normal) for a particular snippet in-memory and on disk.
     */
    public async updateSnippetState(text: string, state: 'pinned' | 'hidden' | 'normal') {
        const updatedRecord = this._ragEngine.updateRecordState(text, state);
        if (updatedRecord) {
            const fileName = updatedRecord.fileName;
            const cached = this._cache.get(fileName);
            if (cached) {
                const cachedRecord = cached.records.find(r => r.text === text);
                if (cachedRecord) {
                    if (state === 'pinned') {
                        cachedRecord.pinned = true;
                        cachedRecord.hidden = false;
                    } else if (state === 'hidden') {
                        cachedRecord.pinned = false;
                        cachedRecord.hidden = true;
                    } else {
                        cachedRecord.pinned = false;
                        cachedRecord.hidden = false;
                    }
                }
            }
            await this._saveCache();
        }
    }

    private _setupWatcher() {
        if (!this._sourcesUri) {
            return;
        }
        const pattern = new vscode.RelativePattern(this._sourcesUri, '**/*.{md,txt,pdf}');
        this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

        const isProcessed = (uri: vscode.Uri) => uri.path.includes('/Processed/');

        this._watcher.onDidChange(uri => { 
            if (!isProcessed(uri)) {
                this._processFile(uri);
            }
        });
        this._watcher.onDidCreate(uri => { 
            if (!isProcessed(uri)) {
                this._processFile(uri);
            }
        });

        this._watcher.onDidDelete(async uri => {
            if (isProcessed(uri)) {
                return;
            }
            const fileName = uri.path.split('/').pop() || '';
            if (this._ragEngine.removeDocument) {
                this._ragEngine.removeDocument(fileName);
            }
            
            if (this._cache.has(fileName)) {
                this._cache.delete(fileName);
                await this._saveCache();
                logSuccess(`Removed ${fileName} from vector cache.`);
            }
            this.onSourcesChanged?.();
        });
    }

    private _setupRootWatcher(rootUri: vscode.Uri) {
        const pattern = new vscode.RelativePattern(rootUri, 'Sources');
        const rootWatcher = vscode.workspace.createFileSystemWatcher(pattern, false, true, true);
        rootWatcher.onDidCreate(async () => {
            rootWatcher.dispose(); 
            await this.initialize(); 
        });
    }

    public dispose() {
        if (this._watcher) {
            this._watcher.dispose();
        }
    }
}
import * as vscode from 'vscode';
import { WebviewManager } from './webview';
import { FileManager } from './fileManager';
import { RagEngine } from './ragEngine';
import { SettingsManager } from './settingsManager';
import { ApiManager } from './apiManager';
import { BibtexManager } from './bibtexManager';
import { KeywordExtractor } from './keywordExtractor';
import { DocumentConverter } from './documentConverter';
import { initLogger, logInfo, logAction, logSuccess, logError, logWarning, logIdle } from './logger';
import { setLastActiveEditor } from './editorUtils';

// Module-level global variables to hold extension state
let debounceTimer: NodeJS.Timeout | undefined;
let ragEngine: RagEngine;
let fileManager: FileManager;
let webviewManager: WebviewManager;
let settingsManager: SettingsManager;
let apiManager: ApiManager;
let bibtexManager: BibtexManager;
let keywordExtractor: KeywordExtractor;
let documentConverter: DocumentConverter;
let lastProcessedText = '';
let currentDelayMs = 2000;

export async function activate(context: vscode.ExtensionContext) {
    // Initialize Output Channel and Logger
    const outputChannel = vscode.window.createOutputChannel('CoRA');
    context.subscriptions.push(outputChannel);
    
    initLogger(outputChannel, (statusText: string) => {
        if (webviewManager) {
            webviewManager.updateStatus(statusText);
        }
    });

    logInfo('CoRA extension activated successfully.');

    // 1. Initialize architectural modules
    ragEngine = new RagEngine();
    settingsManager = new SettingsManager();
    apiManager = new ApiManager();
    bibtexManager = new BibtexManager();
    keywordExtractor = new KeywordExtractor(ragEngine);
    
    // Initialize SettingsManager if a workspace is open
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        try {
            await settingsManager.initialize(workspaceFolders[0].uri);
            const settings = settingsManager.getSettings();
            currentDelayMs = settings.responseDelayMs;
            ragEngine.setThreshold(settings.similarityThreshold);
            ragEngine.setTopK(settings.maxResultsTopK);

            const activeModel = settings.embeddingsModel || vscode.workspace.getConfiguration('cora').get<string>('embeddingsModel') || 'bge-m3';
            const activePort = settings.ollamaPort || vscode.workspace.getConfiguration('cora').get<number>('ollamaPort') || 11434;
            ragEngine.setModelAndPort(activeModel, activePort);

            const filterTitles = settings.filterTitles ?? vscode.workspace.getConfiguration('cora').get<boolean>('filterTitles') ?? true;
            ragEngine.setFilterTitles(filterTitles);
        } catch (err: any) {
            logError(`Failed to initialize settings: ${err?.message || err}`);
        }
    }
    
    // DocumentConverter requires settingsManager to resolve script path
    documentConverter = new DocumentConverter(settingsManager);

    // Temporary status callback until fileManager is refactored to use the logger directly
    fileManager = new FileManager(ragEngine, settingsManager, documentConverter, (status: string) => {
        logInfo(status);
    });
    
    webviewManager = new WebviewManager(context.extensionUri, ragEngine, fileManager, settingsManager, async (key, val) => {
        try {
            if (key === 'threshold') {
                await settingsManager.updateSetting('similarityThreshold', val as number);
                ragEngine.setThreshold(val as number);
                if (lastProcessedText) {
                    try {
                        const results = await ragEngine.processQuery(lastProcessedText);
                        webviewManager.updateResults(results);
                        logIdle();
                    } catch (err) {}
                }
            } else if (key === 'delay') {
                await settingsManager.updateSetting('responseDelayMs', (val as number) * 1000);
                currentDelayMs = (val as number) * 1000;
            } else if (key === 'topK') {
                await settingsManager.updateSetting('maxResultsTopK', val as number);
                ragEngine.setTopK(val as number);
                if (lastProcessedText) {
                    try {
                        const results = await ragEngine.processQuery(lastProcessedText);
                        webviewManager.updateResults(results);
                        logIdle();
                    } catch (err) {}
                }
            } else if (key === 'searchSources') {
                await settingsManager.updateSetting('searchSources', val as any);
            }
        } catch (err: any) {
            logError(`Failed to update setting ${key}: ${err?.message || err}`);
            vscode.window.showErrorMessage(`CoRA: Failed to update setting ${key}.`);
        }
    }, async (command, data) => {
        try {
            if (command === 'searchWeb') {
                if (!lastProcessedText) {
                    vscode.window.showInformationMessage('CoRA: No text selected for web search.');
                    return;
                }
                logAction('Extracting keywords from selection...');
                const topN = settingsManager.getSettings().searchTopNKeywords || 5;
                const keywords = await keywordExtractor.extractKeywords(lastProcessedText, topN);
                
                if (keywords.length === 0) {
                    logWarning('No keywords extracted from text.');
                    vscode.window.showInformationMessage('CoRA: Could not extract keywords from the text.');
                    return;
                }

                const query = keywords.join(' ');
                const commaSeparated = keywords.join(', ');
                logAction(`Searching web repositories for: "${query}"...`);
                
                if (webviewManager) {
                    (webviewManager as any)._panel?.webview.postMessage({ command: 'updateWebKeywords', data: commaSeparated });
                }

                let results: any[] = [];
                const searchSettings = settingsManager.getSettings().searchSources;
                const maxResults = settingsManager.getSettings().maxResultsTopK;

                if (searchSettings.arxiv) {
                    const arxivRes = await apiManager.searchArxiv(query, maxResults);
                    results.push(...arxivRes);
                }
                if (searchSettings.semanticScholar) {
                    const apiKey = vscode.workspace.getConfiguration('cora').get<string>('semanticScholarApiKey') || '';
                    const ssRes = await apiManager.searchSemanticScholar(query, maxResults, apiKey);
                    results.push(...ssRes);
                }
                if (searchSettings.duckduckgo) {
                    const ddgRes = await apiManager.searchDuckDuckGo(query, maxResults);
                    results.push(...ddgRes);
                }

                if (webviewManager) {
                    (webviewManager as any)._panel?.webview.postMessage({ command: 'updateWebResults', data: results });
                    logSuccess(`Web search complete. Found ${results.length} papers.`);
                }
            } else if (command === 'citeWeb') {
                if (workspaceFolders && workspaceFolders.length > 0) {
                    logAction(`Adding citation for DOI: ${data}`);
                    await bibtexManager.addCiteAndBibtex(data, workspaceFolders[0].uri);
                    logSuccess(`Citation added successfully.`);
                }
            } else if (command === 'addSourceWeb') {
                if (workspaceFolders && workspaceFolders.length > 0) {
                    const rootUri = workspaceFolders[0].uri;
                    const sourcesDir = vscode.Uri.joinPath(rootUri, 'Sources');
                    const safeTitle = data.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
                    const mdUri = vscode.Uri.joinPath(sourcesDir, `${safeTitle}.md`);
                    
                    if (data.source === 'DuckDuckGo' && data.url) {
                        logAction(`Downloading and converting webpage: ${data.url}...`);
                        const urlUri = vscode.Uri.parse(data.url);
                        try {
                            // Run the documentConverter directly on the URL
                            await documentConverter.convert(urlUri, 'discard', undefined, undefined, safeTitle);
                            
                            // Read the converted markdown file
                            const mdData = await vscode.workspace.fs.readFile(mdUri);
                            let mdText = Buffer.from(mdData).toString('utf8');
                            
                            // Scan for a DOI (case-insensitive search) in the first 25% of the document (min 1000 chars)
                            const doiRegex = /\b10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+\b/i;
                            const scanText = mdText.substring(0, Math.max(Math.floor(mdText.length * 0.25), 1000));
                            const doiMatch = doiRegex.exec(scanText);
                            if (doiMatch) {
                                const foundDoi = doiMatch[0];
                                logInfo(`Found DOI in converted webpage: ${foundDoi}`);
                                // Prepend doi to file
                                mdText = `doi: ${foundDoi}\n` + mdText;
                                await vscode.workspace.fs.writeFile(mdUri, Buffer.from(mdText, 'utf8'));
                            } else if (data.url) {
                                logInfo(`No DOI found in converted webpage. Prepending URL: ${data.url}`);
                                // Prepend url to file
                                mdText = `url: ${data.url}\n` + mdText;
                                await vscode.workspace.fs.writeFile(mdUri, Buffer.from(mdText, 'utf8'));
                            }
                            
                            logSuccess(`Added web source document: ${safeTitle}.md`);
                            vscode.window.showInformationMessage(`CoRA: Downloaded and converted ${safeTitle}.md to Sources.`);
                        } catch (convErr: any) {
                            logWarning(`Webpage conversion failed: ${convErr?.message || convErr}. Falling back to standard search snippet.`);
                            
                            // Fallback to standard snippet
                            let content = ``;
                            if (data.doi) {
                                content += `doi: ${data.doi}\n`;
                            } else if (data.url) {
                                content += `url: ${data.url}\n`;
                            }
                            content += `# ${data.title}\n\n${data.abstract}\n`;
                            await vscode.workspace.fs.writeFile(mdUri, Buffer.from(content, 'utf8'));
                            logSuccess(`Added fallback web source document: ${safeTitle}.md`);
                            vscode.window.showInformationMessage(`CoRA: Added fallback ${safeTitle}.md to Sources.`);
                        }
                    } else {
                        // Standard RAG sources (arXiv / Semantic Scholar)
                        let content = ``;
                        if (data.doi) {
                            content += `doi: ${data.doi}\n`;
                        } else if (data.url) {
                            content += `url: ${data.url}\n`;
                        }
                        content += `# ${data.title}\n\n${data.abstract}\n`;
                        
                        try {
                            await vscode.workspace.fs.writeFile(mdUri, Buffer.from(content, 'utf8'));
                            logSuccess(`Added web source document: ${safeTitle}.md`);
                            vscode.window.showInformationMessage(`CoRA: Added ${safeTitle}.md to Sources.`);
                        } catch(e: any) {
                            logError(`Failed to save web source document: ${e?.message || e}`);
                            vscode.window.showErrorMessage(`CoRA: Error adding web source to project.`);
                        }
                    }
                }
            }
        } catch (err: any) {
            logError(`Command execution failed: ${err?.message || err}`);
            vscode.window.showErrorMessage(`CoRA error: ${err?.message || err}`);
        }
    });

    fileManager.onSourcesChanged = async () => {
        if (lastProcessedText) {
            try {
                logAction('Sources changed. Recalculating suggestions...');
                const results = await ragEngine.processQuery(lastProcessedText);
                webviewManager.updateResults(results);
                logIdle();
            } catch (err: any) {
                logError(`Error recalculating suggestions: ${err?.message || err}`);
            }
        }
    };

    // Background engine load
    ragEngine.initialize().then(async () => {
        logSuccess('RAG Engine initialized successfully.');
        await fileManager.initialize();
        if (webviewManager) {
            webviewManager.sendInitialState();
        }
        checkForUpdates(context).catch(err => {
            logWarning(`Update checker encountered an error: ${err?.message || err}`);
        });
    }).catch(err => {
        logError(`Initialization failure: ${err?.message || err}`);
    });

    // Register command to open UI
    let openPanelCommand = vscode.commands.registerCommand('cora.openPanel', async () => {
        try {
            if (!fileManager.isInitialized()) {
                await fileManager.initialize();
                if (webviewManager) {
                    webviewManager.sendInitialState();
                }
            }
            webviewManager.show();
        } catch (err: any) {
            logError(`Failed to open panel: ${err?.message || err}`);
            vscode.window.showErrorMessage(`CoRA: Could not open Smart Context Panel.`);
        }
    });
    context.subscriptions.push(openPanelCommand);

    // Auto-open UI if document type matches and Sources exists
    const checkAutoOpen = async (editor: vscode.TextEditor | undefined) => {
        if (!editor) {
            return;
        }

        const settings = settingsManager.getSettings();
        const autoOpen = settings.autoOpenPanel ?? vscode.workspace.getConfiguration('cora').get<boolean>('autoOpenPanel') ?? true;
        if (!autoOpen) {
            return;
        }

        const lang = editor.document.languageId;
        if (lang === 'markdown' || lang === 'tex' || lang === 'latex') {
            if (workspaceFolders) {
                const sourcesUri = vscode.Uri.joinPath(workspaceFolders[0].uri, 'Sources');
                try {
                    await vscode.workspace.fs.stat(sourcesUri);
                    if (!fileManager.isInitialized()) {
                        await fileManager.initialize();
                        if (webviewManager) {
                            webviewManager.sendInitialState();
                        }
                    }
                    webviewManager.show(true); // Open in background
                } catch {
                    // Sources folder does not exist, ignore
                }
            }
        }
    };
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            setLastActiveEditor(editor);
        }
        checkAutoOpen(editor);
    }, null, context.subscriptions);
    if (vscode.window.activeTextEditor) {
        setLastActiveEditor(vscode.window.activeTextEditor);
    }
    checkAutoOpen(vscode.window.activeTextEditor);

    // Editor text selection listener with debouncing
    let selectionListener = vscode.window.onDidChangeTextEditorSelection(event => {
        const editor = event.textEditor;
        
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
            handleSmartContextExtraction(editor).catch(err => {
                logError(`Error handling context extraction: ${err?.message || err}`);
            });
        }, currentDelayMs);
    });
    
    context.subscriptions.push(selectionListener);

    // Listen for configuration changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('cora.autoOpenPanel')) {
            try {
                const autoOpen = vscode.workspace.getConfiguration('cora').get<boolean>('autoOpenPanel') ?? true;
                settingsManager.getSettings().autoOpenPanel = autoOpen;
            } catch (err: any) {
                logError(`Failed to apply autoOpenPanel change: ${err?.message || err}`);
            }
        }

        if (e.affectsConfiguration('cora.filterTitles')) {
            try {
                const filterTitles = vscode.workspace.getConfiguration('cora').get<boolean>('filterTitles') ?? true;
                settingsManager.getSettings().filterTitles = filterTitles;
                ragEngine.setFilterTitles(filterTitles);
                
                if (lastProcessedText) {
                    logAction('Re-evaluating active context with title filtering settings...');
                    const results = await ragEngine.processQuery(lastProcessedText);
                    if (webviewManager) {
                        webviewManager.updateResults(results);
                        logIdle();
                    }
                }
            } catch (err: any) {
                logError(`Failed to apply filterTitles change: ${err?.message || err}`);
            }
        }

        if (e.affectsConfiguration('cora.embeddingsModel') || e.affectsConfiguration('cora.ollamaPort')) {
            logWarning('Ollama settings changed. Re-initializing RAG Engine and cache...');
            
            try {
                // 1. Get new settings
                const activeModel = vscode.workspace.getConfiguration('cora').get<string>('embeddingsModel') || 'bge-m3';
                const activePort = vscode.workspace.getConfiguration('cora').get<number>('ollamaPort') || 11434;

                // 2. Clear old engine state and set new model/port
                ragEngine.clearMemory();
                ragEngine.setModelAndPort(activeModel, activePort);

                // 3. Re-initialize RAG engine
                await ragEngine.initialize();

                // 4. Dispose and re-initialize File Manager (handles cache mismatch automatically)
                if (fileManager) {
                    fileManager.dispose();
                    await fileManager.initialize();
                }

                // 5. Update UI
                if (webviewManager) {
                    webviewManager.sendInitialState();
                    
                    // Re-query the last active context if it exists, to refresh the results panel immediately
                    if (lastProcessedText) {
                        logAction('Re-evaluating active context with new embeddings model...');
                        const results = await ragEngine.processQuery(lastProcessedText);
                        webviewManager.updateResults(results);
                        logIdle();
                    }
                }
                
                logSuccess('RAG Engine and cache successfully updated with new settings.');
            } catch (err: any) {
                logError(`Failed to apply configuration change: ${err?.message || err}`);
                vscode.window.showErrorMessage(`CoRA: Failed to apply configuration changes.`);
            }
        }
    }));
}

/**
 * Handles the extraction of writing context and updates results from RAG engine.
 */
async function handleSmartContextExtraction(editor: vscode.TextEditor) {
    const document = editor.document;
    const selection = editor.selection;

    let textToProcess = '';

    if (!selection.isEmpty) {
        textToProcess = document.getText(selection);
        logInfo('Highlighted text captured.');
    } else {
        textToProcess = extractCurrentParagraph(document, selection.active);
        logInfo('Current paragraph extracted.');
    }

    if (textToProcess.trim().length > 0) {
        lastProcessedText = textToProcess;
        logAction(`Processing context for: "${textToProcess.substring(0, 40)}..."`);
        
        try {
            const results = await ragEngine.processQuery(textToProcess);
            webviewManager.updateResults(results);
            logIdle();
        } catch (err: any) {
            logError(`Error processing context query: ${err?.message || err}`);
        }
    }
}

/**
 * Extracts the paragraph at the cursor by finding empty line boundaries.
 */
function extractCurrentParagraph(document: vscode.TextDocument, position: vscode.Position): string {
    let startLine = position.line;
    let endLine = position.line;

    while (startLine > 0 && document.lineAt(startLine - 1).text.trim() !== '') {
        startLine--;
    }

    while (endLine < document.lineCount - 1 && document.lineAt(endLine + 1).text.trim() !== '') {
        endLine++;
    }

    const startPos = new vscode.Position(startLine, 0);
    const endPos = new vscode.Position(endLine, document.lineAt(endLine).text.length);
    
    return document.getText(new vscode.Range(startPos, endPos)).trim();
}

/**
 * Checks GitHub for newer versions of the extension.
 */
async function checkForUpdates(context: vscode.ExtensionContext) {
    try {
        const currentVersion = context.extension.packageJSON.version;
        if (!currentVersion) {
            return;
        }

        logAction('Checking for extension updates on GitHub...');
        const response = await fetch('https://api.github.com/repos/Kuig/CoRA/releases/latest', {
            headers: {
                'User-Agent': 'vscode-cora-extension'
            }
        });

        if (!response.ok) {
            logWarning(`GitHub update check returned status ${response.status}: ${response.statusText}`);
            return;
        }

        const data = await response.json() as any;
        if (!data || !data.tag_name) {
            return;
        }

        const latestVersion = data.tag_name;
        const releaseUrl = data.html_url || 'https://github.com/Kuig/CoRA/releases';

        if (isNewerVersion(currentVersion, latestVersion)) {
            logInfo(`A new version of CoRA (${latestVersion}) is available! Current: ${currentVersion}`);
            vscode.window.showInformationMessage(
                `CoRA: A new version (${latestVersion}) is available! Current: ${currentVersion}.`,
                'Download Update'
            ).then(selection => {
                if (selection === 'Download Update') {
                    vscode.env.openExternal(vscode.Uri.parse(releaseUrl));
                }
            });
        } else {
            logSuccess(`CoRA is up to date (version ${currentVersion}).`);
        }
    } catch (e: any) {
        logWarning(`Failed to check for CoRA updates: ${e?.message || e}`);
    }
}

/**
 * SemVer comparison helper: returns true if latest is strictly greater than current.
 */
function isNewerVersion(current: string, latest: string): boolean {
    const curParts = current.replace(/^v/i, '').split('.').map(Number);
    const latParts = latest.replace(/^v/i, '').split('.').map(Number);
    for (let i = 0; i < Math.max(curParts.length, latParts.length); i++) {
        const curPart = curParts[i] || 0;
        const latPart = latParts[i] || 0;
        if (latPart > curPart) {
            return true;
        }
        if (curPart > latPart) {
            return false;
        }
    }
    return false;
}

export function deactivate() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    if (fileManager) {
        fileManager.dispose();
    }
}
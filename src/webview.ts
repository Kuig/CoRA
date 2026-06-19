import * as vscode from 'vscode';
import { getActiveOrVisibleEditor } from './editorUtils';
import { getCurrentStatusText } from './logger';

export class WebviewManager {
    private _panel: vscode.WebviewPanel | undefined;
    private readonly _extensionUri: vscode.Uri;
    private _ragEngine: any; // Temporarily using 'any' until we create the RagEngine class
    private _fileManager: any; // Reference to FileManager to update sources
    private _settingsManager: any;
    private _onSettingsChange?: (key: string, val: any) => void;
    private _onCommand?: (command: string, data?: any) => void;

    constructor(extensionUri: vscode.Uri, ragEngine: any, fileManager?: any, settingsManager?: any, onSettingsChange?: (key: string, val: any) => void, onCommand?: (command: string, data?: any) => void) {
        this._extensionUri = extensionUri;
        this._ragEngine = ragEngine;
        this._fileManager = fileManager;
        this._settingsManager = settingsManager;
        this._onSettingsChange = onSettingsChange;
        this._onCommand = onCommand;
    }

    /**
     * Shows the Webview panel. If it already exists, reveals it (brings to foreground).
     * Otherwise, creates a new one.
     */
    public show(preserveFocus: boolean = false) {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.Two, preserveFocus);
        } else {
            this._panel = vscode.window.createWebviewPanel(
                'coraPanel', // Internal identifier
                'CoRA - Smart Context', // Title shown to user
                { viewColumn: vscode.ViewColumn.Two, preserveFocus: preserveFocus }, // Opens panel in the right column
                {
                    enableScripts: true, // Required to run interface JS
                    retainContextWhenHidden: true // Retains UI state when the panel is hidden
                }
            );

            // Handles panel disposal (closing)
            this._panel.onDidDispose(() => {
                this._panel = undefined;
            });

            // Sets the HTML content
            this._panel.webview.html = this._getHtmlForWebview();

            // Activates listener for incoming messages from the HTML interface
            this._setWebviewMessageListener(this._panel.webview);
        }
    }

    /**
     * Sends the initial state of snippets (pinned and hidden) and settings to the user interface.
     */
    public sendInitialState() {
        if (this._panel && this._ragEngine) {
            const pinned = typeof this._ragEngine.getPinnedRecords === 'function' ? this._ragEngine.getPinnedRecords() : [];
            const hidden = typeof this._ragEngine.getHiddenRecords === 'function' ? this._ragEngine.getHiddenRecords() : [];
            const settings = this._settingsManager ? this._settingsManager.getSettings() : undefined;
            this._panel.webview.postMessage({
                command: 'restoreState',
                pinned: pinned,
                hidden: hidden,
                settings: settings
            });
            this._panel.webview.postMessage({
                command: 'updateStatus',
                text: getCurrentStatusText()
            });
        }
    }

    /**
     * Sends the new RAG results to the user interface.
     */
    public updateResults(results: { text: string; source: string; score: number; doi?: string; url?: string }[]) {
        if (this._panel) {
            this._panel.webview.postMessage({ command: 'updateResults', data: results });
        }
    }

    /**
     * Sends a status update (e.g. Analysis in progress) to the user interface.
     */
    public updateStatus(statusText: string) {
        if (this._panel) {
            this._panel.webview.postMessage({ command: 'updateStatus', text: statusText });
        }
    }

    /**
     * Listens for messages (events) sent from the HTML interface JavaScript.
     */
    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'ready':
                        this.sendInitialState();
                        return;
                    case 'updateSnippetState':
                        if (this._fileManager) {
                            this._fileManager.updateSnippetState(message.text, message.state);
                        }
                        this._focusEditor();
                        return;
                    case 'refreshSources':
                        vscode.window.showInformationMessage('CoRA: Manual scan of sources started...');
                        if (this._fileManager) {
                            this._fileManager.forceScan().then(() => {
                                this.sendInitialState();
                            });
                        } else {
                            vscode.window.showErrorMessage('CoRA: FileManager is not connected to the Webview.');
                        }
                        this._focusEditor();
                        return;
                    case 'insertSnippet':
                        this._insertTextIntoEditor(message.text);
                        this._focusEditor();
                        return;
                    case 'openFile':
                        this._openSourceFile(message.fileName);
                        return;
                    case 'updateThreshold':
                        if (this._onSettingsChange) {
                            this._onSettingsChange('threshold', message.value);
                        }
                        return;
                    case 'updateDelay':
                        if (this._onSettingsChange) {
                            this._onSettingsChange('delay', message.value);
                        }
                        return;
                    case 'updateTopK':
                        if (this._onSettingsChange) {
                            this._onSettingsChange('topK', message.value);
                        }
                        return;
                    case 'updateSettings':
                        if (this._onSettingsChange) {
                            this._onSettingsChange(message.key, message.value);
                        }
                        this._focusEditor();
                        return;
                    case 'searchWeb':
                        if (this._onCommand) {
                            this._onCommand('searchWeb');
                        }
                        this._focusEditor();
                        return;
                    case 'citeWeb':
                        if (this._onCommand) {
                            this._onCommand('citeWeb', message.doi);
                        }
                        this._focusEditor();
                        return;
                    case 'addSourceWeb':
                        if (this._onCommand) {
                            this._onCommand('addSourceWeb', message.data);
                        }
                        this._focusEditor();
                        return;
                    case 'copySnippet':
                        this._focusEditor();
                        return;
                    case 'visitWeb':
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                        return;
                    case 'logInfo':
                        console.log(`[Webview Info]: ${message.text}`);
                        return;
                }
            },
            undefined,
            []
        );
    }

    private _insertTextIntoEditor(text: string) {
        const editor = getActiveOrVisibleEditor();

        if (editor) {
            editor.edit(editBuilder => {
                editBuilder.insert(editor.selection.active, `\n\n> ${text}`);
            });
        } else {
            vscode.window.showErrorMessage('No active editor to insert text into.');
        }
    }

    /**
     * Searches for the source file in the workspace and opens it in the first editor column.
     */
    private async _openSourceFile(fileName: string) {
        try {
            // Search for the file in the Sources folder of the current workspace
            const files = await vscode.workspace.findFiles(`**/Sources/**/${fileName}`);

            if (files && files.length > 0) {
                // Open the document
                const document = await vscode.workspace.openTextDocument(files[0]);
                // Reveal the document in the first column (ViewColumn.One)
                await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
            } else {
                vscode.window.showErrorMessage(`CoRA: Could not find source file "${fileName}".`);
            }
        } catch (error) {
            console.error('CoRA - Error opening file:', error);
            vscode.window.showErrorMessage(`CoRA: An error occurred while opening "${fileName}".`);
        }
    }

    /**
     * Refocuses the editor to avoid focus traps inside the webview panel.
     */
    private _focusEditor() {
        const editor = getActiveOrVisibleEditor();

        if (editor) {
            vscode.window.showTextDocument(editor.document, {
                viewColumn: editor.viewColumn,
                preserveFocus: false
            });
        } else {
            vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        }
    }

    /**
     * Generates HTML, CSS, and JS markup for the interface.
     */
    private _getHtmlForWebview(): string {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>CoRA Context</title>
                <style>
                    body {
                        font-family: var(--vscode-font-family);
                        padding: 10px;
                        color: var(--vscode-editor-foreground);
                        background-color: var(--vscode-editor-background);
                        display: flex;
                        flex-direction: column;
                        min-height: calc(100vh - 20px);
                        box-sizing: border-box;
                    }
                    h2, .section-details summary {
                        font-size: 14px;
                        text-transform: uppercase;
                        letter-spacing: 1px;
                        color: var(--vscode-textPreformat-foreground);
                        border-bottom: 1px solid var(--vscode-panel-border);
                        padding-bottom: 5px;
                        margin-top: 20px;
                        cursor: pointer;
                        user-select: none;
                        outline: none;
                    }
                    .section-details {
                        margin-bottom: 10px;
                    }
                    #status-bar {
                        padding: 8px;
                        background-color: var(--vscode-editorWidget-background);
                        color: var(--vscode-foreground);
                        font-weight: 500;
                        border: 1px solid var(--vscode-widget-border);
                        border-radius: 4px;
                        font-size: 11px;
                        margin-top: 10px;
                        margin-bottom: 15px;
                        text-align: center;
                    }
                    .settings-details, .hidden-details {
                        margin-top: 15px;
                        margin-bottom: 10px;
                    }
                    .hidden-details {
                        margin-top: auto;
                        margin-bottom: 10px;
                    }
                    .settings-details {
                        margin-bottom: 15px;
                    }
                    .settings-panel {
                        padding: 10px;
                        background-color: var(--vscode-editorWidget-background);
                        border: 1px solid var(--vscode-widget-border);
                        border-radius: 4px;
                    }
                    .settings-panel label {
                        display: block;
                        font-size: 12px;
                        margin-bottom: 5px;
                        font-weight: bold;
                    }
                    .settings-panel input[type="range"] {
                        width: 100%;
                    }
                    button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 8px 12px;
                        cursor: pointer;
                        width: 100%;
                        margin-bottom: 15px;
                        font-weight: bold;
                        border-radius: 2px;
                    }
                    button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    .snippet-card {
                        background-color: var(--vscode-editorWidget-background);
                        border: 1px solid var(--vscode-widget-border);
                        padding: 10px;
                        margin-bottom: 10px;
                        border-radius: 4px;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                        transition: opacity 0.2s ease, border-color 0.2s ease;
                    }
                    .hidden-card {
                        opacity: 0.65;
                        border-style: dashed;
                    }
                    .hidden-card:hover {
                        opacity: 0.95;
                        border-style: solid;
                        border-color: var(--vscode-textLink-foreground);
                    }
                    .snippet-text {
                        font-size: 13px;
                        line-height: 1.4;
                        margin-bottom: 8px;
                        white-space: pre-wrap; /* Preserves real line breaks */
                    }
                    .snippet-meta {
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        flex-wrap: wrap;
                        gap: 5px;
                    }
                    .action-links {
                        display: flex;
                        gap: 12px;
                    }
                    .action-link {
                        color: var(--vscode-textLink-foreground);
                        cursor: pointer;
                        text-decoration: none;
                        user-select: none;
                    }
                    .action-link:hover {
                        text-decoration: underline;
                    }
                    .source-link {
                        font-weight: bold;
                    }
                    #results-container, #pinned-container {
                        display: flex;
                        flex-direction: column;
                        gap: 10px;
                    }
                    .empty-state {
                        opacity: 0.6;
                        text-align: center;
                        font-style: italic;
                        margin-top: 20px;
                        margin-bottom: 20px;
                    }
                </style>
            </head>
            <body>
                <details class="section-details" open>
                    <summary>📌 Pinned</summary>
                    <div id="pinned-container" style="margin-top: 10px;">
                        <div class="empty-state">No pinned snippets.</div>
                    </div>
                </details>

                <details class="section-details" open>
                    <summary>📄 Smart Context</summary>
                    <div id="results-container" style="margin-top: 10px;">
                        <div class="empty-state">Start writing. CoRA will suggest relevant snippets here based on the context...</div>
                    </div>
                </details>

                <details class="section-details">
                    <summary>🌐 Web Results</summary>
                    <button id="search-web-btn" style="background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); margin-top: 10px; margin-bottom: 5px;">🔍 Search Web for Selected Text</button>
                    <div id="web-search-keywords" style="font-size: 11px; font-style: italic; opacity: 0.8; margin-bottom: 10px; display: none; text-align: center;"></div>
                    <div id="web-results-container" style="margin-top: 10px;">
                        <div class="empty-state">Press "Search Web" to search external sources...</div>
                    </div>
                </details>

                <details class="hidden-details">
                    <summary style="cursor: pointer; font-weight: bold; font-size: 12px; margin-bottom: 5px; color: var(--vscode-descriptionForeground);">👁️ Hidden Snippets (<span id="hidden-count">0</span>)</summary>
                    <div id="hidden-container" class="settings-panel" style="display: flex; flex-direction: column; gap: 10px; max-height: 200px; overflow-y: auto;">
                        <div class="empty-state">No hidden snippets.</div>
                    </div>
                </details>

                <details class="settings-details">
                    <summary style="cursor: pointer; font-weight: bold; font-size: 12px; margin-bottom: 5px; color: var(--vscode-descriptionForeground);">⚙️ Settings</summary>
                    <div class="settings-panel">
                        <label for="threshold-slider">Match Threshold: <span id="threshold-val">43%</span></label>
                        <input type="range" id="threshold-slider" min="10" max="90" value="43" step="1">
                        
                        <label for="delay-slider" style="margin-top: 10px;">Response Delay: <span id="delay-val">2s</span></label>
                        <input type="range" id="delay-slider" min="1" max="10" value="2" step="1">
                        
                        <label for="topk-slider" style="margin-top: 10px;">Max Results: <span id="topk-val">5</span></label>
                        <input type="range" id="topk-slider" min="1" max="20" value="5" step="1">

                        <hr style="border: 0; border-top: 1px solid var(--vscode-widget-border); margin: 15px 0;">
                        <label style="margin-bottom: 8px;">Web Search Sources:</label>
                        <div style="display: flex; gap: 15px; font-size: 12px; margin-bottom: 10px; flex-wrap: wrap;">
                            <label style="font-weight: normal; display: flex; align-items: center; gap: 5px;">
                                <input type="checkbox" id="arxiv-check" checked> arXiv
                            </label>
                            <label style="font-weight: normal; display: flex; align-items: center; gap: 5px;">
                                <input type="checkbox" id="semantic-scholar-check" checked> Semantic Scholar
                            </label>
                            <label style="font-weight: normal; display: flex; align-items: center; gap: 5px;">
                                <input type="checkbox" id="duckduckgo-check" checked> DuckDuckGo
                            </label>
                        </div>
                        <hr style="border: 0; border-top: 1px solid var(--vscode-widget-border); margin: 15px 0 10px 0;">
                        <button id="refresh-btn" style="margin-bottom: 0;">🔄 Update Sources</button>
                    </div>
                </details>
                <div id="status-bar">⚪ Idle...</div>

                <script>
                    const vscode = acquireVsCodeApi();
                    
                    // Local interface state
                    let pinnedItems = [];
                    let hiddenItems = [];
                    let lastResults = [];

                    // Refresh button handler
                    document.getElementById('refresh-btn').addEventListener('click', () => {
                        vscode.postMessage({ command: 'refreshSources' });
                    });

                    // Listen for incoming messages from the VS Code extension
                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.command) {
                            case 'restoreState':
                                pinnedItems = message.pinned || [];
                                hiddenItems = message.hidden || [];
                                if (message.settings) {
                                    document.getElementById('threshold-slider').value = Math.round(message.settings.similarityThreshold * 100);
                                    document.getElementById('threshold-val').innerText = Math.round(message.settings.similarityThreshold * 100) + '%';
                                    document.getElementById('delay-slider').value = message.settings.responseDelayMs / 1000;
                                    document.getElementById('delay-val').innerText = (message.settings.responseDelayMs / 1000) + 's';
                                    document.getElementById('topk-slider').value = message.settings.maxResultsTopK;
                                    document.getElementById('topk-val').innerText = message.settings.maxResultsTopK;
                                    
                                    if(document.getElementById('arxiv-check')) {
                                         document.getElementById('arxiv-check').checked = message.settings.searchSources.arxiv;
                                    }
                                    if(document.getElementById('semantic-scholar-check')) {
                                         document.getElementById('semantic-scholar-check').checked = message.settings.searchSources.semanticScholar;
                                    }
                                    if(document.getElementById('duckduckgo-check')) {
                                         document.getElementById('duckduckgo-check').checked = message.settings.searchSources.duckduckgo;
                                    }
                                }
                                renderPinned();
                                renderHidden();
                                renderResults(lastResults);
                                break;
                            case 'updateResults':
                                renderResults(message.data);
                                break;
                            case 'updateWebResults':
                                renderWebResults(message.data);
                                break;
                            case 'updateWebKeywords':
                                const keywordsDiv = document.getElementById('web-search-keywords');
                                if (keywordsDiv) {
                                    keywordsDiv.innerText = \`Keywords: \${message.data}\`;
                                    keywordsDiv.style.display = 'block';
                                }
                                break;
                            case 'updateStatus':
                                const statusBar = document.getElementById('status-bar');
                                statusBar.innerText = message.text || '⚪ Idle...';
                                break;
                        }
                    });

                    // Threshold slider handler
                    const slider = document.getElementById('threshold-slider');
                    const valDisplay = document.getElementById('threshold-val');
                    slider.addEventListener('input', (e) => {
                        valDisplay.innerText = e.target.value + '%';
                    });
                    slider.addEventListener('change', (e) => {
                        vscode.postMessage({ command: 'updateThreshold', value: parseInt(e.target.value) / 100 });
                    });

                    // Delay slider handler
                    const delaySlider = document.getElementById('delay-slider');
                    const delayDisplay = document.getElementById('delay-val');
                    delaySlider.addEventListener('input', (e) => {
                        delayDisplay.innerText = e.target.value + 's';
                    });
                    delaySlider.addEventListener('change', (e) => {
                        vscode.postMessage({ command: 'updateDelay', value: parseInt(e.target.value) });
                    });

                    // TopK slider handler
                    const topkSlider = document.getElementById('topk-slider');
                    const topkDisplay = document.getElementById('topk-val');
                    topkSlider.addEventListener('input', (e) => {
                        topkDisplay.innerText = e.target.value;
                    });
                    topkSlider.addEventListener('change', (e) => {
                        vscode.postMessage({ command: 'updateTopK', value: parseInt(e.target.value) });
                    });

                    // Web search checkboxes handler
                    const updateSearchSources = () => {
                        vscode.postMessage({
                            command: 'updateSettings',
                            key: 'searchSources',
                            value: {
                                arxiv: document.getElementById('arxiv-check').checked,
                                semanticScholar: document.getElementById('semantic-scholar-check').checked,
                                duckduckgo: document.getElementById('duckduckgo-check').checked
                            }
                        });
                    };
                    document.getElementById('arxiv-check').addEventListener('change', updateSearchSources);
                    document.getElementById('semantic-scholar-check').addEventListener('change', updateSearchSources);
                    document.getElementById('duckduckgo-check').addEventListener('change', updateSearchSources);

                    // Copy to clipboard helper
                    function copyToClipboard(text, element) {
                        const textarea = document.createElement('textarea');
                        textarea.value = text;
                        document.body.appendChild(textarea);
                        textarea.select();
                        document.execCommand('copy');
                        document.body.removeChild(textarea);
                        
                        const originalText = element.innerText;
                        element.innerText = '✅ Copied!';
                        setTimeout(() => { element.innerText = originalText; }, 1500);

                        vscode.postMessage({ command: 'copySnippet' });
                    }

                    // --- PINNED SNIPPETS MANAGEMENT ---

                    function pinResult(res) {
                        if (!pinnedItems.find(p => p.text === res.text)) {
                            hiddenItems = hiddenItems.filter(h => h.text !== res.text);
                            pinnedItems.push(res);
                            renderPinned();
                            renderHidden();
                            renderResults(lastResults);
                            vscode.postMessage({ command: 'updateSnippetState', text: res.text, state: 'pinned' });
                        }
                    }

                    function unpinResult(text) {
                        pinnedItems = pinnedItems.filter(p => p.text !== text);
                        renderPinned();
                        renderResults(lastResults);
                        vscode.postMessage({ command: 'updateSnippetState', text: text, state: 'normal' });
                    }

                    function renderPinned() {
                        const container = document.getElementById('pinned-container');
                        container.innerHTML = ''; 

                        if (pinnedItems.length === 0) {
                            container.innerHTML = '<div class="empty-state">No pinned snippets.</div>';
                            return;
                        }

                        pinnedItems.forEach(res => {
                            const card = document.createElement('div');
                            card.className = 'snippet-card';
                            
                            card.innerHTML = \`
                                <div class="snippet-text">\${res.text}</div>
                                <div class="snippet-meta">
                                    <span class="action-link source-link" title="Open source file">📄 \${res.source}</span>
                                    <div class="action-links">
                                        <span class="action-link copy-btn" title="Copy text">📋 Copy</span>
                                        <span class="action-link unpin-btn" title="Unpin snippet">❌ Unpin</span>
                                        <span class="action-link insert-btn" title="Insert into text">➕ Insert</span>
                                    </div>
                                </div>
                            \`;

                            card.querySelector('.source-link').addEventListener('click', () => {
                                vscode.postMessage({ command: 'openFile', fileName: res.source });
                            });
                            card.querySelector('.copy-btn').addEventListener('click', (e) => copyToClipboard(res.text, e.target));
                            card.querySelector('.unpin-btn').addEventListener('click', () => unpinResult(res.text));
                            card.querySelector('.insert-btn').addEventListener('click', () => {
                                vscode.postMessage({ command: 'insertSnippet', text: res.text });
                            });

                            container.appendChild(card);
                        });
                    }

                    // --- HIDDEN SNIPPETS MANAGEMENT ---

                    function hideResult(res) {
                        pinnedItems = pinnedItems.filter(p => p.text !== res.text);
                        if (!hiddenItems.find(h => h.text === res.text)) {
                            hiddenItems.push(res);
                        }
                        renderPinned();
                        renderHidden();
                        renderResults(lastResults);
                        vscode.postMessage({ command: 'updateSnippetState', text: res.text, state: 'hidden' });
                    }

                    function unhideResult(text) {
                        hiddenItems = hiddenItems.filter(h => h.text !== text);
                        renderHidden();
                        renderResults(lastResults);
                        vscode.postMessage({ command: 'updateSnippetState', text: text, state: 'normal' });
                    }

                    function renderHidden() {
                        const container = document.getElementById('hidden-container');
                        const countDisplay = document.getElementById('hidden-count');
                        container.innerHTML = ''; 

                        countDisplay.innerText = hiddenItems.length;

                        if (hiddenItems.length === 0) {
                            container.innerHTML = '<div class="empty-state">No hidden snippets.</div>';
                            return;
                        }

                        hiddenItems.forEach(res => {
                            const card = document.createElement('div');
                            card.className = 'snippet-card hidden-card';
                            
                            card.innerHTML = \`
                                <div class="snippet-text">\${res.text}</div>
                                <div class="snippet-meta">
                                    <span class="action-link source-link" title="Open source file">📄 \${res.source}</span>
                                    <div class="action-links">
                                        <span class="action-link copy-btn" title="Copy text">📋 Copy</span>
                                        <span class="action-link show-btn" title="Make visible">👁️ Show</span>
                                        <span class="action-link insert-btn" title="Insert into text">➕ Insert</span>
                                    </div>
                                </div>
                            \`;

                            card.querySelector('.source-link').addEventListener('click', () => {
                                vscode.postMessage({ command: 'openFile', fileName: res.source });
                            });
                            card.querySelector('.copy-btn').addEventListener('click', (e) => copyToClipboard(res.text, e.target));
                            card.querySelector('.show-btn').addEventListener('click', () => unhideResult(res.text));
                            card.querySelector('.insert-btn').addEventListener('click', () => {
                                vscode.postMessage({ command: 'insertSnippet', text: res.text });
                            });

                            container.appendChild(card);
                        });
                    }

                    // --- DYNAMIC RAG RESULTS RENDERING ---

                    document.getElementById('search-web-btn').addEventListener('click', () => {
                        vscode.postMessage({ command: 'searchWeb' });
                    });

                    function renderWebResults(results) {
                        const container = document.getElementById('web-results-container');
                        container.innerHTML = ''; 

                        if (!results || results.length === 0) {
                            container.innerHTML = '<div class="empty-state">No web results found.</div>';
                            return;
                        }

                        results.forEach(res => {
                            const card = document.createElement('div');
                            card.className = 'snippet-card';
                            
                            card.innerHTML = \`
                                <div class="snippet-text" style="font-weight: bold; margin-bottom: 4px;">\${res.title}</div>
                                <div class="snippet-text" style="font-size: 11px; max-height: 80px; overflow: hidden; text-overflow: ellipsis;">\${res.abstract}</div>
                                <div class="snippet-meta" style="margin-top: 8px;">
                                    <span class="action-link source-link" style="font-weight: normal; font-size: 10px;">🌐 \${res.source}\${res.doi ? ' (DOI)' : res.url ? ' (URL)' : ''}\${res.year ? \` - \${res.year}\` : ''}\${res.citationCount !== undefined ? \` - Cit: \${res.citationCount}\` : ''}</span>
                                    <div class="action-links">
                                        \${(res.doi || res.url) ? '<span class="action-link cite-web-btn" title="Cite directly">🔖 Cite</span>' : ''}
                                        <span class="action-link add-source-btn" title="Add to sources">📥 Add</span>
                                        \${res.url ? '<span class="action-link visit-btn" title="Visit page">↗ Visit</span>' : ''}
                                    </div>
                                </div>
                            \`;

                            if (res.doi || res.url) {
                                card.querySelector('.cite-web-btn').addEventListener('click', () => {
                                    vscode.postMessage({ command: 'citeWeb', doi: res.doi || res.url });
                                });
                            }
                            card.querySelector('.add-source-btn').addEventListener('click', () => {
                                vscode.postMessage({ command: 'addSourceWeb', data: res });
                            });
                            if (res.url) {
                                card.querySelector('.visit-btn').addEventListener('click', () => {
                                    vscode.postMessage({ command: 'visitWeb', url: res.url });
                                });
                            }

                            container.appendChild(card);
                        });
                    }

                    function renderResults(results) {
                        lastResults = results || [];
                        const container = document.getElementById('results-container');
                        container.innerHTML = ''; 

                        const filteredResults = lastResults.filter(res => 
                            !pinnedItems.find(p => p.text === res.text) && 
                            !hiddenItems.find(h => h.text === res.text)
                        );

                        if (filteredResults.length === 0) {
                            container.innerHTML = '<div class="empty-state">No relevant results found.</div>';
                            return;
                        }

                        filteredResults.forEach(res => {
                            const card = document.createElement('div');
                            card.className = 'snippet-card';
                            
                            const matchPercent = Math.round(res.score * 100);

                            card.innerHTML = \`
                                <div class="snippet-text">\${res.text}</div>
                                <div class="snippet-meta">
                                    <span class="action-link source-link" title="Open source file">📄 \${res.source} (\${matchPercent}% match)\${res.doi ? ' (DOI)' : res.url ? ' (URL)' : ''}</span>
                                    <div class="action-links">
                                        \${(res.doi || res.url) ? '<span class="action-link cite-local-btn" title="Cite directly">🔖 Cite</span>' : ''}
                                        <span class="action-link copy-btn" title="Copy text">📋 Copy</span>
                                        <span class="action-link pin-btn" title="Pin to top">📌 Pin</span>
                                        <span class="action-link hide-btn" title="Hide snippet">🙈 Hide</span>
                                        <span class="action-link insert-btn" title="Insert into text">➕ Insert</span>
                                    </div>
                                </div>
                            \`;

                            card.querySelector('.source-link').addEventListener('click', () => {
                                vscode.postMessage({ command: 'openFile', fileName: res.source });
                            });
                            if (res.doi || res.url) {
                                card.querySelector('.cite-local-btn').addEventListener('click', () => {
                                    vscode.postMessage({ command: 'citeWeb', doi: res.doi || res.url });
                                });
                            }
                            card.querySelector('.copy-btn').addEventListener('click', (e) => copyToClipboard(res.text, e.target));
                            card.querySelector('.pin-btn').addEventListener('click', () => pinResult(res));
                            card.querySelector('.hide-btn').addEventListener('click', () => hideResult(res));
                            card.querySelector('.insert-btn').addEventListener('click', () => {
                                vscode.postMessage({ command: 'insertSnippet', text: res.text });
                            });

                            container.appendChild(card);
                        });
                    }

                    vscode.postMessage({ command: 'ready' });
                </script>
            </body>
            </html>
        `;
    }
}
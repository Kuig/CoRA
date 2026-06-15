import * as vscode from 'vscode';
import * as path from 'path';
import { getActiveOrVisibleEditor } from './editorUtils';
import { logInfo, logAction, logSuccess, logError, logWarning } from './logger';

export class BibtexManager {
    /**
     * Resolves DOI or URL to a BibTeX entry, updates references.bib, and inserts a cite key into the active editor.
     */
    public async addCiteAndBibtex(doiOrUrl: string, rootUri: vscode.Uri) {
        const editor = getActiveOrVisibleEditor();

        // 1. Locate and read the bibliography file
        const pattern = new vscode.RelativePattern(rootUri, '*.bib');
        const files = await vscode.workspace.findFiles(pattern);
        let bibUri: vscode.Uri;
        let bibContent = '';
        
        if (files.length > 0) {
            bibUri = files[0];
            try {
                const data = await vscode.workspace.fs.readFile(bibUri);
                bibContent = Buffer.from(data).toString('utf8');
            } catch (err) {
                logWarning(`Could not read existing bibliography file ${bibUri.fsPath}: ${err}`);
            }
        } else {
            bibUri = vscode.Uri.joinPath(rootUri, 'references.bib');
        }

        // 2. Scan the bibliography to check if this DOI/URL has already been cited
        let citeKey = '';
        let isAlreadyCited = false;

        if (bibContent) {
            const entries = bibContent.split('@');
            for (const entry of entries) {
                if (entry.toLowerCase().includes(doiOrUrl.toLowerCase())) {
                    const match = entry.match(/^\w+\{([^,]+),/);
                    if (match) {
                        citeKey = match[1].trim();
                        isAlreadyCited = true;
                        logInfo(`Document ${doiOrUrl} is already cited under key: ${citeKey}`);
                        break;
                    }
                }
            }
        }

        // 3. If not cited yet, fetch or generate the BibTeX entry
        if (!isAlreadyCited) {
            let bibtexEntry = '';
            let isUrl = false;
            try {
                isUrl = doiOrUrl.startsWith('http://') || doiOrUrl.startsWith('https://');
                if (isUrl) {
                    logAction(`Generating offline BibTeX entry for URL: ${doiOrUrl}...`);
                    let title = '';
                    let key = '';
                    try {
                        const parsedUrl = new URL(doiOrUrl);
                        const domain = parsedUrl.hostname.replace('www.', '');
                        const cleanDomain = domain.replace(/[^a-zA-Z0-9]/g, '_');
                        
                        const segments = parsedUrl.pathname.split('/').filter(s => s.length > 0);
                        let lastSegment = segments[segments.length - 1] || 'index';
                        try {
                            lastSegment = decodeURIComponent(lastSegment);
                        } catch (e) {}
                        
                        const cleanSegment = lastSegment.replace(/[^a-zA-Z0-9_-]/g, '_');
                        title = lastSegment.replace(/[_-]+/g, ' ').trim();
                        title = title.split(' ')
                            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                            .join(' ');
                        
                        if (!title || title.trim() === '') {
                            title = domain;
                        }
                        
                        // Deterministic URL hash to prevent duplicates and generate consistent keys
                        let hash = 0;
                        for (let i = 0; i < doiOrUrl.length; i++) {
                            hash = (hash << 5) - hash + doiOrUrl.charCodeAt(i);
                            hash |= 0;
                        }
                        const hashStr = Math.abs(hash).toString(36).substring(0, 4);
                        
                        key = `web_${cleanDomain.toLowerCase()}_${cleanSegment.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${hashStr}`;
                    } catch (e) {
                        title = doiOrUrl;
                        let hash = 0;
                        for (let i = 0; i < doiOrUrl.length; i++) {
                            hash = (hash << 5) - hash + doiOrUrl.charCodeAt(i);
                            hash |= 0;
                        }
                        const hashStr = Math.abs(hash).toString(36).substring(0, 4);
                        key = `web_url_${hashStr}`;
                    }
                    const today = new Date().toISOString().split('T')[0];
                    bibtexEntry = `@misc{${key},\n  title = {${title}},\n  howpublished = {\\url{${doiOrUrl}}},\n  note = {Accessed: ${today}}\n}`;
                } else {
                    logAction(`Fetching BibTeX entry for DOI: ${doiOrUrl}...`);
                    const response = await fetch(`https://doi.org/${doiOrUrl}`, {
                        headers: { 'Accept': 'application/x-bibtex' }
                    });
                    if (response.ok) {
                        bibtexEntry = await response.text();
                    } else {
                        throw new Error(`DOI resolution returned status ${response.status}`);
                    }
                }
            } catch (e: any) {
                const errorMsg = isUrl ? `Could not generate BibTeX for URL: ${doiOrUrl}.` : `Could not generate BibTeX for DOI: ${doiOrUrl}.`;
                logError(`${errorMsg} Details: ${e?.message || e}`);
                vscode.window.showErrorMessage(`CoRA: ${errorMsg}`);
                return;
            }

            const keyMatch = bibtexEntry.match(/@\w+\{([^,]+),/);
            citeKey = keyMatch ? keyMatch[1] : `cite_${Date.now()}`;

            // Append the new BibTeX entry to the .bib file
            if (!bibContent.includes(citeKey)) {
                const newContent = bibContent ? bibContent.trim() + '\n\n' + bibtexEntry : bibtexEntry;
                await vscode.workspace.fs.writeFile(bibUri, Buffer.from(newContent, 'utf8'));
                logSuccess(`Added citation key ${citeKey} to ${path.basename(bibUri.fsPath)}`);
                vscode.window.showInformationMessage(`CoRA: Added ${citeKey} to ${path.basename(bibUri.fsPath)}`);
            } else {
                logInfo(`Citation key ${citeKey} already exists in bibliography.`);
            }
        } else {
            logInfo(`Reusing existing citation key "${citeKey}" for document: ${doiOrUrl}`);
        }

        // 4. Insert the citation tag into the active editor
        if (editor) {
            editor.edit(editBuilder => {
                editBuilder.insert(editor.selection.active, `\\cite{${citeKey}}`);
            });
            logSuccess(`Inserted \\cite{${citeKey}} into the active editor.`);
        } else {
            const errorMsg = 'No active text editor found to insert \\cite tag.';
            logWarning(errorMsg);
            vscode.window.showErrorMessage(`CoRA: ${errorMsg}`);
        }
    }
}

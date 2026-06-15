import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import { SettingsManager } from './settingsManager';
import { logInfo, logAction, logSuccess, logError } from './logger';

export class DocumentConverter {
    constructor(private _settingsManager: SettingsManager) {}

    /**
     * Converts a source document (pdf/html/htm or remote webpage URL) into markdown using TextConverter.
     */
    public async convert(sourceUri: vscode.Uri, imageHandling: 'discard' | 'describe' | 'auto_latex', codeParsing?: boolean, extractHtml?: boolean, destFileName?: string) {
        const rootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!rootPath) {
            return;
        }

        const settings = this._settingsManager.getSettings();
        const configuredPath = settings.textconverterPath || vscode.workspace.getConfiguration('cora').get<string>('textconverterPath') || '';

        let pythonExe = 'python';
        let mainScriptPath = '';
        let useConfiguredScript = false;

        const workspacePythonCandidate = process.platform === 'win32'
            ? path.join(rootPath, '.venv', 'Scripts', 'python.exe')
            : path.join(rootPath, '.venv', 'bin', 'python');

        if (configuredPath && configuredPath.trim() !== '' && await this._exists(configuredPath)) {
            const venvPythonPath = process.platform === 'win32'
                ? path.join(configuredPath, '.venv', 'Scripts', 'python.exe')
                : path.join(configuredPath, '.venv', 'bin', 'python');

            if (await this._exists(venvPythonPath)) {
                pythonExe = venvPythonPath;
            } else {
                pythonExe = await this._exists(workspacePythonCandidate) ? workspacePythonCandidate : 'python';
            }

            const scriptCandidate = path.join(configuredPath, 'textconverter', '__main__.py');
            if (await this._exists(scriptCandidate)) {
                mainScriptPath = scriptCandidate;
                useConfiguredScript = true;
            }
        } else {
            pythonExe = await this._exists(workspacePythonCandidate) ? workspacePythonCandidate : 'python';
        }

        const processedDir = path.join(rootPath, 'Sources', 'Processed');
        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(processedDir));
        } catch (e) {}

        const isRemote = sourceUri.scheme === 'http' || sourceUri.scheme === 'https';
        const srcFsPath = isRemote ? sourceUri.toString() : sourceUri.fsPath;
        
        let destMdPath: string;
        if (destFileName) {
            const finalName = destFileName.endsWith('.md') ? destFileName : `${destFileName}.md`;
            destMdPath = path.join(rootPath, 'Sources', finalName);
        } else {
            const baseName = isRemote 
                ? (sourceUri.path.split('/').pop()?.replace(/[^a-z0-9]/gi, '_') || 'downloaded_page')
                : path.basename(srcFsPath);
            const fileNameWithoutExt = baseName.includes('.') ? baseName.substring(0, baseName.lastIndexOf('.')) : baseName;
            destMdPath = path.join(rootPath, 'Sources', `${fileNameWithoutExt}.md`);
        }

        const imgHandling = 'discard';
        const codeFlag = (typeof codeParsing !== 'undefined' ? codeParsing : settings.textconverterCodeParsing) ? '--code-parsing' : '';
        const extractFlag = (typeof extractHtml !== 'undefined' ? extractHtml : settings.textconverterExtractHtml) ? '--extract-html' : '';

        let cmd: string;
        if (useConfiguredScript && mainScriptPath) {
            cmd = `"${pythonExe}" -m textconverter convert "${srcFsPath}" "${destMdPath}" --image-handling ${imgHandling}${codeFlag ? ' ' + codeFlag : ''}${extractFlag ? ' ' + extractFlag : ''}`;
        } else if (await this._commandExists('textconverter')) {
            cmd = `textconverter convert "${srcFsPath}" "${destMdPath}" --image-handling ${imgHandling}${codeFlag ? ' ' + codeFlag : ''}${extractFlag ? ' ' + extractFlag : ''}`;
        } else {
            cmd = `"${pythonExe}" -m textconverter convert "${srcFsPath}" "${destMdPath}" --image-handling ${imgHandling}${codeFlag ? ' ' + codeFlag : ''}${extractFlag ? ' ' + extractFlag : ''}`;
        }

        logAction(`Executing text converter: ${cmd}`);

        const env = { ...process.env };
        if (configuredPath) {
            const separator = process.platform === 'win32' ? ';' : ':';
            env.PYTHONPATH = env.PYTHONPATH
                ? `${configuredPath}${separator}${env.PYTHONPATH}`
                : configuredPath;
        }

        return new Promise<void>((resolve, reject) => {
            exec(cmd, { cwd: rootPath, env }, async (error: Error | null, stdout: string, stderr: string) => {
                if (error) {
                    logError(`Failed to convert document: ${error.message}. ${stderr}`);
                    reject(error);
                    return;
                }

                logSuccess(`Document ${isRemote ? srcFsPath : path.basename(srcFsPath)} converted to markdown successfully.`);

                const stripLinks = settings.stripLinksAndImages ?? vscode.workspace.getConfiguration('cora').get<boolean>('stripLinksAndImages') ?? true;
                if (stripLinks) {
                    try {
                        const fileUri = vscode.Uri.file(destMdPath);
                        const dataBytes = await vscode.workspace.fs.readFile(fileUri);
                        let text = Buffer.from(dataBytes).toString('utf8');
                        
                        const stripImagesRegex = /!\[([^\[\]]*?)\]\(([^)]+)\)/g;
                        const stripLinksRegex = /\[([^\[\]]*?)\]\(([^)]+)\)/g;
                        
                        let strippedText = text.replace(stripImagesRegex, '');
                        strippedText = strippedText.replace(stripLinksRegex, '$1');
                        
                        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(strippedText, 'utf8'));
                        logInfo(`Stripped Markdown links and images from ${path.basename(destMdPath)}.`);
                    } catch (e: any) {
                        logError(`Failed to strip links and images from converted document: ${e?.message || e}`);
                    }
                }

                // Move original file to Processed folder only if it is a local file
                if (!isRemote) {
                    try {
                        const fileName = path.basename(srcFsPath);
                        const ext = path.extname(srcFsPath).toLowerCase();
                        if (['.pdf', '.html', '.htm'].includes(ext)) {
                            const destUri = vscode.Uri.file(path.join(processedDir, fileName));
                            await vscode.workspace.fs.rename(sourceUri, destUri, { overwrite: true });
                            logInfo(`Moved original file ${fileName} to Sources/Processed.`);
                        }
                    } catch (e: any) {
                        logError(`Failed to move original file: ${e?.message || e}`);
                    }
                }

                resolve();
            });
        });
    }

    private async _exists(p: string): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(p));
            return true;
        } catch {
            return false;
        }
    }

    private async _commandExists(cmd: string): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const check = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
            exec(check, (err) => {
                resolve(!err);
            });
        });
    }
}

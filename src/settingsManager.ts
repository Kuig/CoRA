import * as vscode from 'vscode';
import { logError, logSave } from './logger';

export class ProjectSettings {
    public similarityThreshold: number;
    public responseDelayMs: number;
    public maxResultsTopK: number;
    public searchSources: {
        arxiv: boolean;
        semanticScholar: boolean;
        duckduckgo: boolean;
    };
    public pdfImageHandling: 'discard' | 'describe' | 'auto_latex';
    public searchTopNKeywords: number;
    public textconverterPath?: string;
    public stripLinksAndImages?: boolean;
    public textconverterCodeParsing?: boolean;
    public textconverterExtractHtml?: boolean;
    public embeddingsModel?: string;
    public ollamaPort?: number;
    public filterTitles?: boolean;

    constructor(data?: Partial<ProjectSettings>) {
        this.similarityThreshold = data?.similarityThreshold ?? 0.43;
        this.responseDelayMs = data?.responseDelayMs ?? 2000;
        this.maxResultsTopK = data?.maxResultsTopK ?? 5;
        this.searchSources = {
            arxiv: data?.searchSources?.arxiv ?? true,
            semanticScholar: data?.searchSources?.semanticScholar ?? true,
            duckduckgo: data?.searchSources?.duckduckgo ?? true,
        };
        this.pdfImageHandling = data?.pdfImageHandling ?? 'discard';
        this.searchTopNKeywords = data?.searchTopNKeywords ?? 5;
        this.textconverterPath = data?.textconverterPath ?? '';
        this.stripLinksAndImages = data?.stripLinksAndImages ?? true;
        this.textconverterCodeParsing = data?.textconverterCodeParsing ?? true;
        this.textconverterExtractHtml = data?.textconverterExtractHtml ?? true;
        this.embeddingsModel = data?.embeddingsModel;
        this.ollamaPort = data?.ollamaPort;
        this.filterTitles = data?.filterTitles ?? true;
    }

    /**
     * Loads settings from the specified URI, falling back to default values if the file is missing or corrupted.
     */
    public static async load(uri: vscode.Uri): Promise<ProjectSettings> {
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            const parsed = JSON.parse(Buffer.from(data).toString('utf8'));
            return new ProjectSettings(parsed);
        } catch {
            const defaults = new ProjectSettings();
            await defaults.save(uri);
            return defaults;
        }
    }

    /**
     * Saves the current settings to the specified URI.
     */
    public async save(uri: vscode.Uri): Promise<void> {
        const data = Buffer.from(JSON.stringify(this, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(uri, data);
    }
}

export class SettingsManager {
    private _settingsUri: vscode.Uri | undefined;
    private _settings: ProjectSettings = new ProjectSettings();

    constructor() { }

    public async initialize(rootUri: vscode.Uri) {
        const coraFolderUri = vscode.Uri.joinPath(rootUri, '.cora');
        this._settingsUri = vscode.Uri.joinPath(coraFolderUri, 'project_settings.json');

        try {
            await vscode.workspace.fs.stat(coraFolderUri);
        } catch {
            await vscode.workspace.fs.createDirectory(coraFolderUri);
        }

        await this.loadSettings();
    }

    public getSettings(): ProjectSettings {
        return this._settings;
    }

    public async updateSetting<K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]) {
        this._settings[key] = value;
        await this.saveSettings();
    }

    public async loadSettings() {
        if (!this._settingsUri) {
            return;
        }
        this._settings = await ProjectSettings.load(this._settingsUri);
    }

    public async saveSettings() {
        if (!this._settingsUri) {
            return;
        }
        try {
            await this._settings.save(this._settingsUri);
            logSave('Project settings updated.');
        } catch (err: any) {
            logError(`Failed to save project settings: ${err?.message || err}`);
        }
    }
}

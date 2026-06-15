import * as vscode from 'vscode';

let lastActiveEditor: vscode.TextEditor | undefined;

/**
 * Saves the reference of the last active text editor.
 */
export function setLastActiveEditor(editor: vscode.TextEditor | undefined) {
    if (editor) {
        lastActiveEditor = editor;
    }
}

/**
 * Resolves the target text editor.
 * Returns the currently active text editor.
 * If the active editor is undefined (e.g., when a webview has focus),
 * it returns the last active text editor if it is still visible in the workspace.
 * Otherwise, falls back to the first visible text editor.
 */
export function getActiveOrVisibleEditor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (active) {
        lastActiveEditor = active;
        return active;
    }

    if (lastActiveEditor) {
        const isStillVisible = vscode.window.visibleTextEditors.some(
            visible => visible.document.uri.toString() === lastActiveEditor!.document.uri.toString()
        );
        if (isStillVisible) {
            const visibleInstance = vscode.window.visibleTextEditors.find(
                visible => visible.document.uri.toString() === lastActiveEditor!.document.uri.toString()
            );
            if (visibleInstance) {
                return visibleInstance;
            }
        }
    }

    if (vscode.window.visibleTextEditors.length > 0) {
        return vscode.window.visibleTextEditors[0];
    }

    return undefined;
}

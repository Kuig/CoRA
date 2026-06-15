import * as vscode from 'vscode';

interface Level {
    emoji: string;
    color: string; // Used for potential html/rich logging if we implement it, or just metadata
    label: string;
}

const LEVELS: Record<string, Level> = {
    success: { emoji: '✅', color: '#2ebd59', label: 'SUCCESS' },
    error: { emoji: '❌', color: '#ff4b4b', label: 'ERROR' },
    warning: { emoji: '⚠️', color: '#ffa500', label: 'WARNING' },
    action: { emoji: '→', color: '#00b0ff', label: 'ACTION' },
    info: { emoji: '📌', color: '#00e5ff', label: 'INFO' },
    save: { emoji: '💾', color: '#2ebd59', label: 'SAVE' },
    ai: { emoji: '🤖', color: '#b388ff', label: 'AI' },
    metric: { emoji: '📊', color: '#888888', label: 'METRIC' },
    idle: { emoji: '⚪', color: '#888888', label: 'IDLE' },
};

let outputChannel: vscode.OutputChannel | undefined;
let webviewStatusCallback: ((msg: string) => void) | undefined;
let currentStatusText = '⚪ Idle...';

/**
 * Gets the current persistent status message.
 */
export function getCurrentStatusText(): string {
    return currentStatusText;
}

/**
 * Initializes the logger with a VSCode output channel and an optional status update callback.
 * 
 * @param channel The VSCode output channel.
 * @param callback Callback to update status messages, typically bound to a Webview.
 */
export function initLogger(channel: vscode.OutputChannel, callback?: (msg: string) => void) {
    outputChannel = channel;
    webviewStatusCallback = callback;
}

/**
 * Internal dispatch logger.
 */
function _log(level: keyof typeof LEVELS, msg: string) {
    const lvl = LEVELS[level];
    const formattedMsg = `${lvl.emoji} ${msg}`;

    if (outputChannel) {
        outputChannel.appendLine(formattedMsg);
    }
    // Still output to the Debug Console for extensions development
    console.log(formattedMsg);

    // Keep track of the last persistent status message
    if (level === 'action' || level === 'ai' || level === 'info' || level === 'metric' || level === 'idle') {
        currentStatusText = formattedMsg;
    }

    if (webviewStatusCallback) {
        // Continuous status (no auto-clear)
        if (level === 'action' || level === 'ai' || level === 'info' || level === 'metric' || level === 'idle') {
            webviewStatusCallback(formattedMsg);
        } else if (level === 'success' || level === 'error' || level === 'warning' || level === 'save') {
            webviewStatusCallback(formattedMsg);
            // Auto-clear temporary alerts after 4 seconds and restore the previous persistent status
            setTimeout(() => {
                if (webviewStatusCallback) {
                    webviewStatusCallback(currentStatusText);
                }
            }, 4000);
        }
    }
}

export function logSuccess(msg: string) { _log('success', msg); }
export function logError(msg: string) { _log('error', msg); }
export function logWarning(msg: string) { _log('warning', msg); }
export function logAction(msg: string) { _log('action', msg); }
export function logInfo(msg: string) { _log('info', msg); }
export function logSave(msg: string) { _log('save', msg); }
export function logAi(msg: string) { _log('ai', msg); }
export function logMetric(msg: string) { _log('metric', msg); }
export function logIdle(msg: string = 'Idle...') { _log('idle', msg); }

export function logSeparator() {
    if (outputChannel) {
        outputChannel.appendLine('─'.repeat(40));
    }
    console.log('─'.repeat(40));
}

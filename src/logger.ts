/**
 * Logger module for Codemap extension
 * Outputs logs to VSCode Output Channel for debugging
 */

import * as vscode from 'vscode';
import * as fs from 'fs';

let outputChannel: vscode.OutputChannel | null = null;
let agentOutputChannel: vscode.OutputChannel | null = null;
let captureEntries: string[] | null = null;

/**
 * Initialize the logger with a VSCode Output Channel
 */
export function initLogger(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Codemap Agent');
  }
  return outputChannel;
}

/**
 * Initialize the agent output logger with a VSCode Output Channel
 */
export function initAgentLogger(): vscode.OutputChannel {
  if (!agentOutputChannel) {
    agentOutputChannel = vscode.window.createOutputChannel('Codemap Agent (Raw)');
  }
  return agentOutputChannel;
}

/**
 * Get the logger instance
 */
export function getLogger(): vscode.OutputChannel | null {
  return outputChannel;
}

/**
 * Log a message with timestamp
 */
export function log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string, ...args: unknown[]): void {
  if (!outputChannel) {
    initLogger();
  }
  
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}]`;
  
  let fullMessage = `${prefix} ${message}`;
  
  if (args.length > 0) {
    const argsStr = args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
    fullMessage += ` ${argsStr}`;
  }
  
  outputChannel!.appendLine(fullMessage);
  if (captureEntries) {
    captureEntries.push(fullMessage);
  }
  
  // Also log to console for development
  if (level === 'ERROR') {
    console.error(fullMessage);
  } else if (level === 'WARN') {
    console.warn(fullMessage);
  } else {
    console.log(fullMessage);
  }
}

/**
 * Log info message
 */
export function info(message: string, ...args: unknown[]): void {
  log('INFO', message, ...args);
}

/**
 * Log warning message
 */
export function warn(message: string, ...args: unknown[]): void {
  log('WARN', message, ...args);
}

/**
 * Log error message
 */
export function error(message: string, ...args: unknown[]): void {
  log('ERROR', message, ...args);
}

/**
 * Log debug message
 */
export function debug(message: string, ...args: unknown[]): void {
  log('DEBUG', message, ...args);
}

/**
 * Log raw agent output message
 */
export function agentRaw(message: string): void {
  if (!agentOutputChannel) {
    initAgentLogger();
  }
  
  const timestamp = new Date().toISOString();
  agentOutputChannel!.appendLine(`[${timestamp}] ${message}`);
  if (captureEntries) {
    captureEntries.push(`[${timestamp}] [RAW] ${message}`);
  }
}

/**
 * Show the output channel
 */
export function show(): void {
  outputChannel?.show(true);
}

/**
 * Show the agent output channel
 */
export function showRaw(): void {
  agentOutputChannel?.show(true);
}

/**
 * Clear the output channel
 */
export function clear(): void {
  outputChannel?.clear();
}

/**
 * Dispose the output channel
 */
export function dispose(): void {
  outputChannel?.dispose();
  outputChannel = null;
  agentOutputChannel?.dispose();
  agentOutputChannel = null;
}

/**
 * Log a separator line for visual clarity
 */
export function separator(title?: string): void {
  if (title) {
    outputChannel?.appendLine(`\n${'='.repeat(20)} ${title} ${'='.repeat(20)}`);
  } else {
    outputChannel?.appendLine('='.repeat(60));
  }
}

/**
 * Start capturing logs into an in-memory buffer.
 */
export function startCapture(label?: string): void {
  captureEntries = [];
  if (label) {
    const timestamp = new Date().toISOString();
    captureEntries.push(`[${timestamp}] [CAPTURE] ${label}`);
  }
}

/**
 * Stop capturing and return the captured log content.
 */
export function endCapture(): string | null {
  if (!captureEntries) {
    return null;
  }
  const content = captureEntries.join('\n');
  captureEntries = null;
  return content;
}

/**
 * Snapshot current capture buffer without clearing it.
 */
export function snapshotCapture(): string | null {
  if (!captureEntries) {
    return null;
  }
  return captureEntries.join('\n');
}

/**
 * Write a captured log string to disk.
 */
export function writeCaptureToFile(filePath: string, content: string): boolean {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}





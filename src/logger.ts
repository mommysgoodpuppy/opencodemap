/**
 * Logger module for Codemap extension
 * Outputs logs to VSCode Output Channel for debugging
 */

import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | null = null;
let agentOutputChannel: vscode.OutputChannel | null = null;

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





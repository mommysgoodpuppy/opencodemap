/**
 * Shared utilities for codemap agents
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Codemap } from '../types';

/**
 * Generate workspace layout tree structure
 */
export function generateWorkspaceLayout(workspaceRoot: string, maxDepth: number = 3): string {
  const lines: string[] = [];
  
  const ignoredPatterns = [
    'node_modules', '.git', '.vscode', '__pycache__', '.pytest_cache',
    'dist', 'build', 'out', '.next', 'coverage', '.nyc_output'
  ];
  
  function walkDir(dir: string, prefix: string = '', depth: number = 0): void {
    if (depth > maxDepth) {
      lines.push(`${prefix}[...]`);
      return;
    }
    
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    
    entries = entries.filter(e => !ignoredPatterns.includes(e.name) && !e.name.startsWith('.'));
    
    const maxEntries = 15;
    const hasMore = entries.length > maxEntries;
    const displayEntries = entries.slice(0, maxEntries);
    
    for (let i = 0; i < displayEntries.length; i++) {
      const entry = displayEntries[i];
      const isLast = i === displayEntries.length - 1 && !hasMore;
      const marker = isLast ? '└── ' : '├── ';
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      
      if (entry.isDirectory()) {
        lines.push(`${prefix}${marker}${entry.name}/`);
        walkDir(path.join(dir, entry.name), childPrefix, depth + 1);
      } else {
        lines.push(`${prefix}${marker}${entry.name}`);
      }
    }
    
    if (hasMore) {
      lines.push(`${prefix}└── [+${entries.length - maxEntries} more items]`);
    }
  }
  
  walkDir(workspaceRoot);
  return lines.join('\n');
}

/**
 * Extract codemap JSON from model response
 */
export function extractCodemapFromResponse(text: string): Codemap | null {
  // Try to extract from <CODEMAP> tags
  const codemapMatch = text.match(/<CODEMAP>\s*([\s\S]*?)\s*<\/CODEMAP>/);
  if (codemapMatch) {
    try {
      return JSON.parse(codemapMatch[1]) as Codemap;
    } catch (e) {
      console.error('Failed to parse CODEMAP JSON:', e);
    }
  }
  
  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*"title"[\s\S]*"traces"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]) as Codemap;
    } catch (e) {
      console.error('Failed to parse JSON from response:', e);
    }
  }
  
  return null;
}

/**
 * Extract trace text diagram from response
 */
export function extractTraceDiagram(text: string): string | null {
  const match = text.match(/<TRACE_TEXT_DIAGRAM>\s*([\s\S]*?)\s*<\/TRACE_TEXT_DIAGRAM>/);
  return match ? match[1].trim() : null;
}

/**
 * Extract trace guide from response
 */
export function extractTraceGuide(text: string): string | null {
  const match = text.match(/<TRACE_GUIDE>\s*([\s\S]*?)\s*<\/TRACE_GUIDE>/);
  return match ? match[1].trim() : null;
}

/**
 * Extract mermaid diagram code block from response
 */
export function extractMermaidDiagram(text: string): string | null {
  const mermaidMatch = text.match(/```mermaid\s*([\s\S]*?)\s*```/i);
  if (mermaidMatch) {
    return mermaidMatch[1].trim();
  }
  const codeBlockMatch = text.match(/```[\s\S]*?```/);
  if (codeBlockMatch) {
    return codeBlockMatch[0].replace(/```/g, '').trim();
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Check if the model indicates research is complete
 */
export function isResearchComplete(text: string): boolean {
  const indicators = [
    'I am done researching',
    'done researching',
    'research is complete',
    'finished exploring',
    'completed my analysis',
    'Would you like to hear more?'
  ];
  const lowerText = text.toLowerCase();
  return indicators.some(ind => lowerText.includes(ind.toLowerCase()));
}

/**
 * Format current date for prompts
 */
export function formatCurrentDate(): string {
  return new Date().toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  });
}

/**
 * Get OS name for prompts
 */
export function getUserOs(): string {
  return process.platform === 'win32' ? 'windows' : process.platform;
}




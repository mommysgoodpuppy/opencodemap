/**
 * Codemap Storage - persists codemaps to ~/.cometix/codemap/<project>/
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Codemap } from '../types';

const COMETIX_DIR = '.cometix';
const CODEMAP_SUBDIR = 'codemap';

// Cache for storage directory to avoid repeated filesystem checks
let cachedStorageDir: string | null = null;
let cachedWorkspaceName: string | null = null;

/**
 * Get the storage directory for the current workspace
 * Returns: ~/.cometix/codemap/<workspace-name>/
 */
export function getCodemapStorageDir(): string {
  const workspaceName = getWorkspaceName();
  
  // Return cached directory if workspace hasn't changed
  if (cachedStorageDir && cachedWorkspaceName === workspaceName) {
    return cachedStorageDir;
  }
  
  const homeDir = os.homedir();
  const storageDir = path.join(homeDir, COMETIX_DIR, CODEMAP_SUBDIR, workspaceName);
  
  // Ensure directory exists
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  
  // Update cache
  cachedStorageDir = storageDir;
  cachedWorkspaceName = workspaceName;
  
  return storageDir;
}

/**
 * Get a sanitized workspace name for use as directory name
 */
function getWorkspaceName(): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return 'default';
  }
  
  const workspacePath = workspaceFolders[0].uri.fsPath;
  // Use the last component of the path as the project name
  const projectName = path.basename(workspacePath);
  // Sanitize: replace invalid chars with underscore
  return projectName.replace(/[<>:"/\\|?*]/g, '_');
}

/**
 * Generate a unique filename for a codemap
 */
function generateCodemapFilename(codemap: Codemap): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const titleSlug = codemap.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 50);
  return `${timestamp}_${titleSlug}.json`;
}

function generateDebugLogFilename(label: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'codemap';
  return `${timestamp}_${slug}.debug.log`;
}

/**
 * Save a codemap to storage
 */
export function saveCodemap(codemap: Codemap): string {
  const storageDir = getCodemapStorageDir();
  const filename = generateCodemapFilename(codemap);
  const filePath = path.join(storageDir, filename);
  
  const data = {
    ...codemap,
    savedAt: new Date().toISOString(),
    workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
  };
  
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  
  return filePath;
}

/**
 * Update an existing codemap file in-place.
 * Used when we want to add/refresh fields (e.g., mermaidDiagram) without creating a new history entry.
 */
export function updateCodemap(filename: string, codemap: Codemap): boolean {
  const storageDir = getCodemapStorageDir();
  const filePath = path.join(storageDir, filename);

  try {
    const data = {
      ...codemap,
      savedAt: codemap.savedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || codemap.workspacePath || '',
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * List all saved codemaps for current workspace
 */
export function listCodemaps(): Array<{ filename: string; codemap: Codemap & { savedAt: string } }> {
  const storageDir = getCodemapStorageDir();
  
  try {
    const files = fs.readdirSync(storageDir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.context.json'))
      .sort()
      .reverse(); // Most recent first
    
    return files.map(filename => {
      const filePath = path.join(storageDir, filename);
      const content = fs.readFileSync(filePath, 'utf-8');
      const codemap = JSON.parse(content) as Codemap & { savedAt: string };
      return { filename, codemap };
    });
  } catch {
    return [];
  }
}

/**
 * Load a specific codemap by filename
 */
export function loadCodemap(filename: string): (Codemap & { savedAt: string }) | null {
  const storageDir = getCodemapStorageDir();
  const filePath = path.join(storageDir, filename);
  
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as Codemap & { savedAt: string };
  } catch {
    return null;
  }
}

/**
 * Delete a codemap by filename
 */
export function deleteCodemap(filename: string): boolean {
  const storageDir = getCodemapStorageDir();
  const filePath = path.join(storageDir, filename);
  
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the full storage path for display
 */
export function getStoragePath(): string {
  return getCodemapStorageDir();
}

/**
 * Get the full file path for a codemap by filename
 */
export function getCodemapFilePath(filename: string): string {
  const storageDir = getCodemapStorageDir();
  return path.join(storageDir, filename);
}

/**
 * Save a debug log to storage and return the full file path.
 */
export function saveDebugLog(content: string, label: string = 'codemap'): string {
  const storageDir = getCodemapStorageDir();
  const filename = generateDebugLogFilename(label);
  const filePath = path.join(storageDir, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

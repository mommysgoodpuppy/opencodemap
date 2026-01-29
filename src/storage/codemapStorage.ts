/**
 * Codemap Storage - persists codemaps to ~/.cometix/codemap/<project>/
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Codemap } from '../types';
import { getActiveWorkspaceRoot } from '../workspace';

const COMETIX_DIR = '.cometix';
const CODEMAP_SUBDIR = 'codemap';

// Cache for storage directories to avoid repeated filesystem checks
const cachedStorageDirs = new Map<string, string>();

/**
 * Get the storage directory for the current workspace
 * Returns: ~/.cometix/codemap/<workspace-name>/
 */
export function getCodemapStorageDir(workspacePath?: string): string {
  const workspaceName = getWorkspaceName(workspacePath);
  const cached = cachedStorageDirs.get(workspaceName);
  if (cached) {
    return cached;
  }

  const homeDir = os.homedir();
  const storageDir = path.join(homeDir, COMETIX_DIR, CODEMAP_SUBDIR, workspaceName);
  
  // Ensure directory exists
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  
  cachedStorageDirs.set(workspaceName, storageDir);
  
  return storageDir;
}

/**
 * Get a sanitized workspace name for use as directory name
 */
function getWorkspaceName(workspacePath?: string): string {
  const resolvedPath = workspacePath || getActiveWorkspaceRoot();
  if (!resolvedPath) {
    return 'default';
  }

  // Use the last component of the path as the project name
  const projectName = path.basename(resolvedPath);
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
export function saveCodemap(codemap: Codemap, workspacePath?: string): string {
  const resolvedWorkspacePath = workspacePath || codemap.workspacePath || getActiveWorkspaceRoot() || '';
  const storageDir = getCodemapStorageDir(resolvedWorkspacePath);
  const filename = generateCodemapFilename(codemap);
  const filePath = path.join(storageDir, filename);
  
  const data = {
    ...codemap,
    savedAt: new Date().toISOString(),
    workspacePath: resolvedWorkspacePath,
  };
  
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  
  return filePath;
}

/**
 * Update an existing codemap file in-place.
 * Used when we want to add/refresh fields (e.g., mermaidDiagram) without creating a new history entry.
 */
export function updateCodemap(filename: string, codemap: Codemap, workspacePath?: string): boolean {
  const resolvedWorkspacePath = workspacePath || codemap.workspacePath || getActiveWorkspaceRoot() || '';
  const storageDir = getCodemapStorageDir(resolvedWorkspacePath);
  const filePath = path.join(storageDir, filename);

  try {
    const data = {
      ...codemap,
      savedAt: codemap.savedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspacePath: resolvedWorkspacePath,
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
export function listCodemaps(
  workspacePath?: string
): Array<{ filename: string; codemap: Codemap & { savedAt: string } }> {
  const storageDir = getCodemapStorageDir(workspacePath);
  
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
export function loadCodemap(
  filename: string,
  workspacePath?: string
): (Codemap & { savedAt: string }) | null {
  const storageDir = getCodemapStorageDir(workspacePath);
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
export function deleteCodemap(filename: string, workspacePath?: string): boolean {
  const storageDir = getCodemapStorageDir(workspacePath);
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
export function getStoragePath(workspacePath?: string): string {
  return getCodemapStorageDir(workspacePath);
}

/**
 * Get the full file path for a codemap by filename
 */
export function getCodemapFilePath(filename: string, workspacePath?: string): string {
  const storageDir = getCodemapStorageDir(workspacePath);
  return path.join(storageDir, filename);
}

/**
 * Save a debug log to storage and return the full file path.
 */
export function saveDebugLog(content: string, label: string = 'codemap', workspacePath?: string): string {
  const storageDir = getCodemapStorageDir(workspacePath);
  const filename = generateDebugLogFilename(label);
  const filePath = path.join(storageDir, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

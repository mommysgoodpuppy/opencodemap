/**
 * Tool definitions for Codemap agent
 * Implements tools similar to Windsurf's Cascade
 */

import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import { z } from 'zod';
import { tool } from 'ai';
import { getActiveWorkspaceRoot, findWorkspaceRootForPath } from '../workspace';

const MAX_READ_LINES = 500;
const MAX_READ_BYTES = 32000;
const DEFAULT_IGNORED_PATTERNS = [
  '.git/**',
  '.vscode/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  'out/**',
  '.next/**',
  'coverage/**',
  '.nyc_output/**',
  '**/*.exe',
  '**/*.dll',
  '**/*.so',
  '**/*.dylib',
  '**/*.dat',
];

const ignoreCache = new Map<string, ReturnType<typeof ignore>>();

function getWorkspaceRoot(targetPath?: string): string | undefined {
  if (targetPath && path.isAbsolute(targetPath)) {
    return findWorkspaceRootForPath(targetPath) || getActiveWorkspaceRoot();
  }
  return getActiveWorkspaceRoot();
}

function loadGitignore(workspaceRoot: string): ReturnType<typeof ignore> {
  const cached = ignoreCache.get(workspaceRoot);
  if (cached) {
    return cached;
  }
  const ig = ignore();
  ig.add(DEFAULT_IGNORED_PATTERNS);

  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      ig.add(content.split(/\r?\n/).filter((line) => line.trim().length > 0));
    } catch {
      // Ignore gitignore read errors
    }
  }

  const gitInfoExclude = path.join(workspaceRoot, '.git', 'info', 'exclude');
  if (fs.existsSync(gitInfoExclude)) {
    try {
      const content = fs.readFileSync(gitInfoExclude, 'utf-8');
      ig.add(content.split(/\r?\n/).filter((line) => line.trim().length > 0));
    } catch {
      // Ignore git exclude read errors
    }
  }

  ignoreCache.set(workspaceRoot, ig);
  return ig;
}

function resolveWorkspacePath(workspaceRoot: string, targetPath: string): string {
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(workspaceRoot, targetPath);
}

function normalizeRelativePath(workspaceRoot: string, targetPath: string): string | null {
  const resolvedTarget = resolveWorkspacePath(workspaceRoot, targetPath);
  if (path.resolve(workspaceRoot) === path.resolve(resolvedTarget)) {
    return '';
  }
  const relative = path.relative(workspaceRoot, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join('/');
}

function isPathAllowed(workspaceRoot: string, targetPath: string, ig: ReturnType<typeof ignore>): boolean {
  const relative = normalizeRelativePath(workspaceRoot, targetPath);
  if (relative === '') {
    return true;
  }
  if (!relative) {
    return false;
  }
  return !ig.ignores(relative);
}

function readFileInternal(file_path: string, offset?: number, limit?: number): string {
  try {
    const workspaceRoot = getWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return 'Error: Workspace root not available.';
    }
    const ig = loadGitignore(workspaceRoot);
    const resolvedPath = resolveWorkspacePath(workspaceRoot, file_path);
    if (!isPathAllowed(workspaceRoot, resolvedPath, ig)) {
      return `Error: File is outside workspace or ignored: ${file_path}`;
    }
    if (!fs.existsSync(resolvedPath)) {
      return `Error: File not found: ${resolvedPath}`;
    }
    
    const stat = fs.statSync(resolvedPath);
    if (stat.size > MAX_READ_BYTES * 4) {
      // Large file - require offset/limit
      if (!offset || !limit) {
        return `File is too large (${stat.size} bytes). Please specify offset and limit.`;
      }
    }
    
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const lines = content.split('\n');
    
    const startLine = (offset ?? 1) - 1;
    const endLine = limit ? startLine + limit : lines.length;
    const selectedLines = lines.slice(startLine, endLine);
    
    const numberedLines = selectedLines.map((line, i) => {
      const lineNum = startLine + i + 1;
      const truncated = line.length > 2000 ? line.slice(0, 2000) + '...' : line;
      return `${String(lineNum).padStart(6)}→${truncated}`;
    });
    
    return `<file name="${resolvedPath}" start_line="${startLine + 1}" end_line="${endLine}" full_length="${lines.length}">\n${numberedLines.join('\n')}\n</file>`;
  } catch (error) {
    return `Error reading file: ${error}`;
  }
}

/**
 * read_file tool - reads file content (parallel by default)
 */
export const readFileTool = tool({
  description: `Reads one or more files at the specified paths. Returns file contents with line numbers.
- Provide an array of files (use a single-item array for one file)
- Each entry must include an absolute file_path
- You can optionally specify offset and limit per entry
- Lines longer than 2000 chars will be truncated`,
  inputSchema: z.object({
    files: z.array(z.object({
      file_path: z.string().describe('The absolute path to the file to read'),
      offset: z.number().optional().describe('1-indexed line number to start from'),
      limit: z.number().optional().describe('Number of lines to read'),
    })).describe('Array of file read requests'),
  }),
  execute: async ({ files }) => {
    const results = files.map((entry) =>
      readFileInternal(entry.file_path, entry.offset, entry.limit)
    );
    return results.join('\n\n');
  },
});

/**
 * list_dir tool - lists directory contents
 */
export const listDirTool = tool({
  description: `Lists files and directories for one or more paths. Returns relative paths with sizes.
- Provide an array of directories (use a single-item array for one directory)`,
  inputSchema: z.object({
    directories: z.array(z.string().describe('Absolute path to the directory to list')),
  }),
  execute: async ({ directories }) => {
    const outputs: string[] = [];
    for (const DirectoryPath of directories) {
      try {
        const workspaceRoot = getWorkspaceRoot(DirectoryPath);
        if (!workspaceRoot) {
          outputs.push('Error: Workspace root not available.');
          continue;
        }
        const ig = loadGitignore(workspaceRoot);
        const resolvedDir = resolveWorkspacePath(workspaceRoot, DirectoryPath);
        if (!isPathAllowed(workspaceRoot, resolvedDir, ig)) {
          outputs.push(`Error: Directory is outside workspace or ignored: ${DirectoryPath}`);
          continue;
        }
        if (!fs.existsSync(resolvedDir)) {
          outputs.push(`Error: Directory not found: ${resolvedDir}`);
          continue;
        }
        
        const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
        const results: string[] = [`${resolvedDir}/`];
        
        for (const entry of entries.slice(0, 50)) {
          const fullPath = path.join(resolvedDir, entry.name);
          if (!isPathAllowed(workspaceRoot, fullPath, ig)) {
            continue;
          }
          if (entry.isDirectory()) {
            try {
              const items = fs.readdirSync(fullPath);
              results.push(`\t${entry.name}/ (${items.length} items)`);
            } catch {
              results.push(`\t${entry.name}/ (access denied)`);
            }
          } else {
            try {
              const stat = fs.statSync(fullPath);
              results.push(`\t${entry.name} (${stat.size} bytes)`);
            } catch {
              results.push(`\t${entry.name} (unknown size)`);
            }
          }
        }
        
        if (entries.length > 50) {
          results.push(`\t... and ${entries.length - 50} more items`);
        }
        
        outputs.push(results.join('\n'));
      } catch (error) {
        outputs.push(`Error listing directory: ${error}`);
      }
    }
    return outputs.join('\n\n');
  },
});

/**
 * grep_search tool - searches for patterns in files
 */
export const grepSearchTool = tool({
  description: `A powerful search tool. Searches for patterns in files within directories.
- Provide an array of searches (use a single-item array for one search)
- Set IsRegex to true for regex patterns
- Use Includes to filter by glob patterns`,
  inputSchema: z.object({
    searches: z.array(z.object({
      SearchPath: z.string().describe('The path to search (directory or file)'),
      Query: z.string().describe('The search term or regex pattern'),
      CaseSensitive: z.boolean().optional().describe('Case-sensitive search'),
      IsRegex: z.boolean().optional().describe('Treat Query as regex'),
      Includes: z.array(z.string()).optional().describe('Glob patterns to filter files'),
      MatchPerLine: z.boolean().optional().describe('Show surrounding context'),
    })).describe('Array of search requests'),
  }),
  execute: async ({ searches }) => {
    const outputs: string[] = [];
    for (const search of searches) {
      const { SearchPath, Query, CaseSensitive, IsRegex, Includes, MatchPerLine } = search;
      try {
        const workspaceRoot = getWorkspaceRoot(SearchPath);
        if (!workspaceRoot) {
          outputs.push('Error: Workspace root not available.');
          continue;
        }
        const ig = loadGitignore(workspaceRoot);
        const resolvedSearchPath = resolveWorkspacePath(workspaceRoot, SearchPath);
        if (!isPathAllowed(workspaceRoot, resolvedSearchPath, ig)) {
          outputs.push(`Error: Search path is outside workspace or ignored: ${SearchPath}`);
          continue;
        }
        // Simple implementation using vscode's findFiles and grep
        const results: string[] = [];
        const flags = CaseSensitive ? '' : 'i';
        const regex = IsRegex ? new RegExp(Query, flags) : new RegExp(Query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
        
        const searchInFile = (filePath: string): string[] => {
          const matches: string[] = [];
          try {
            if (!isPathAllowed(workspaceRoot, filePath, ig)) {
              return matches;
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                if (MatchPerLine) {
                  const start = Math.max(0, i - 2);
                  const end = Math.min(lines.length, i + 3);
                  const context = lines.slice(start, end).map((l, idx) => {
                    const lineNum = start + idx + 1;
                    const marker = lineNum === i + 1 ? '>' : ' ';
                    return `${marker}${lineNum}: ${l.slice(0, 200)}`;
                  }).join('\n');
                  matches.push(`${filePath}:${i + 1}\n${context}`);
                } else {
                  matches.push(`${filePath}:${i + 1}`);
                }
              }
            }
          } catch {
            // Skip unreadable files
          }
          return matches;
        };
        
        const walkDir = (dir: string, depth = 0): string[] => {
          if (depth > 10) { return []; }
          const allMatches: string[] = [];
          
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
              
              const fullPath = path.join(dir, entry.name);
              if (!isPathAllowed(workspaceRoot, fullPath, ig)) {
                continue;
              }
              if (entry.isDirectory()) {
                allMatches.push(...walkDir(fullPath, depth + 1));
              } else if (entry.isFile()) {
                // Check includes filter
                if (Includes && Includes.length > 0) {
                  const matches = Includes.some(pattern => {
                    if (pattern.startsWith('*.')) {
                      return entry.name.endsWith(pattern.slice(1));
                    }
                    return entry.name.includes(pattern);
                  });
                  if (!matches) { continue; }
                }
                allMatches.push(...searchInFile(fullPath));
              }
            }
          } catch {
            // Skip inaccessible directories
          }
          
          return allMatches;
        };
        
        const stat = fs.statSync(resolvedSearchPath);
        if (stat.isFile()) {
          results.push(...searchInFile(resolvedSearchPath));
        } else {
          results.push(...walkDir(resolvedSearchPath));
        }
        
        if (results.length === 0) {
          outputs.push(`No matches found for "${Query}" in ${resolvedSearchPath}`);
          continue;
        }
        
        const limited = results.slice(0, 50);
        outputs.push(`Found ${results.length} matches:\n${limited.join('\n\n')}${results.length > 50 ? `\n\n... and ${results.length - 50} more` : ''}`);
      } catch (error) {
        outputs.push(`Error searching: ${error}`);
      }
    }
    return outputs.join('\n\n');
  },
});

/**
 * find_by_name tool - finds files by name pattern
 */
export const findByNameTool = tool({
  description: `Search for files and subdirectories by name pattern (glob format).
- Provide an array of searches (use a single-item array for one search).`,
  inputSchema: z.object({
    searches: z.array(z.object({
      SearchDirectory: z.string().describe('The directory to search within'),
      Pattern: z.string().describe('Pattern to search for (glob format)'),
      Type: z.enum(['file', 'directory', 'any']).optional(),
      MaxDepth: z.number().optional(),
      Extensions: z.array(z.string()).optional(),
    })).describe('Array of find requests'),
  }),
  execute: async ({ searches }) => {
    const outputs: string[] = [];
    for (const search of searches) {
      const { SearchDirectory, Pattern, Type, MaxDepth, Extensions } = search;
      try {
        const workspaceRoot = getWorkspaceRoot(SearchDirectory);
        if (!workspaceRoot) {
          outputs.push('Error: Workspace root not available.');
          continue;
        }
        const ig = loadGitignore(workspaceRoot);
        const resolvedSearchDir = resolveWorkspacePath(workspaceRoot, SearchDirectory);
        if (!isPathAllowed(workspaceRoot, resolvedSearchDir, ig)) {
          outputs.push(`Error: Search directory is outside workspace or ignored: ${SearchDirectory}`);
          continue;
        }
        const results: string[] = [];
        const maxDepth = MaxDepth ?? 5;
        
        const matchesPattern = (name: string): boolean => {
          // Simple glob matching
          const regexPattern = Pattern
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
          return new RegExp(regexPattern, 'i').test(name);
        };
        
        const walkDir = (dir: string, depth = 0): void => {
          if (depth > maxDepth || results.length >= 50) { return; }
          
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name.startsWith('.')) { continue; }
              if (results.length >= 50) { break; }
              
              const fullPath = path.join(dir, entry.name);
              if (!isPathAllowed(workspaceRoot, fullPath, ig)) {
                continue;
              }
              const isDir = entry.isDirectory();
              
              // Check type filter
              if (Type === 'file' && isDir) {
                walkDir(fullPath, depth + 1);
                continue;
              }
              if (Type === 'directory' && !isDir) { continue; }
              
              // Check extensions filter
              if (Extensions && Extensions.length > 0 && !isDir) {
                const ext = path.extname(entry.name).slice(1);
                if (!Extensions.includes(ext)) {
                  continue;
                }
              }
              
              // Check pattern match
              if (matchesPattern(entry.name)) {
                results.push(fullPath);
              }
              
              if (isDir && entry.name !== 'node_modules') {
                walkDir(fullPath, depth + 1);
              }
            }
          } catch {
            // Skip inaccessible directories
          }
        };
        
        walkDir(resolvedSearchDir);
        
        if (results.length === 0) {
          outputs.push(`Found 0 results for pattern "${Pattern}" in ${resolvedSearchDir}`);
          continue;
        }
        
        outputs.push(`Found ${results.length} results:\n${results.join('\n')}`);
      } catch (error) {
        outputs.push(`Error finding files: ${error}`);
      }
    }
    return outputs.join('\n\n');
  },
});

/**
 * Get all available tools as an object
 */
export const allTools = {
  read_file: readFileTool,
  list_dir: listDirTool,
  grep_search: grepSearchTool,
  find_by_name: findByNameTool,
};

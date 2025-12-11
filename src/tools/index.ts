/**
 * Tool definitions for Codemap agent
 * Implements tools similar to Windsurf's Cascade
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { tool } from 'ai';

const MAX_READ_LINES = 500;
const MAX_READ_BYTES = 32000;

/**
 * read_file tool - reads file content
 */
export const readFileTool = tool({
  description: `Reads a file at the specified path. Returns file content with line numbers.
- The file_path parameter must be an absolute path
- You can optionally specify offset and limit for large files
- Lines longer than 2000 chars will be truncated`,
  parameters: z.object({
    file_path: z.string().describe('The absolute path to the file to read'),
    offset: z.number().optional().describe('1-indexed line number to start from'),
    limit: z.number().optional().describe('Number of lines to read'),
  }),
  execute: async ({ file_path, offset, limit }) => {
    try {
      if (!fs.existsSync(file_path)) {
        return `Error: File not found: ${file_path}`;
      }
      
      const stat = fs.statSync(file_path);
      if (stat.size > MAX_READ_BYTES * 4) {
        // Large file - require offset/limit
        if (!offset || !limit) {
          return `File is too large (${stat.size} bytes). Please specify offset and limit.`;
        }
      }
      
      const content = fs.readFileSync(file_path, 'utf-8');
      const lines = content.split('\n');
      
      const startLine = (offset ?? 1) - 1;
      const endLine = limit ? startLine + limit : lines.length;
      const selectedLines = lines.slice(startLine, endLine);
      
      const numberedLines = selectedLines.map((line, i) => {
        const lineNum = startLine + i + 1;
        const truncated = line.length > 2000 ? line.slice(0, 2000) + '...' : line;
        return `${String(lineNum).padStart(6)}→${truncated}`;
      });
      
      return `<file name="${file_path}" start_line="${startLine + 1}" end_line="${endLine}" full_length="${lines.length}">\n${numberedLines.join('\n')}\n</file>`;
    } catch (error) {
      return `Error reading file: ${error}`;
    }
  },
});

/**
 * list_dir tool - lists directory contents
 */
export const listDirTool = tool({
  description: `Lists files and directories in a given path. Returns relative paths with sizes.`,
  parameters: z.object({
    DirectoryPath: z.string().describe('The absolute path to the directory to list'),
  }),
  execute: async ({ DirectoryPath }) => {
    try {
      if (!fs.existsSync(DirectoryPath)) {
        return `Error: Directory not found: ${DirectoryPath}`;
      }
      
      const entries = fs.readdirSync(DirectoryPath, { withFileTypes: true });
      const results: string[] = [`${DirectoryPath}/`];
      
      for (const entry of entries.slice(0, 50)) {
        const fullPath = path.join(DirectoryPath, entry.name);
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
      
      return results.join('\n');
    } catch (error) {
      return `Error listing directory: ${error}`;
    }
  },
});

/**
 * grep_search tool - searches for patterns in files
 */
export const grepSearchTool = tool({
  description: `A powerful search tool. Searches for patterns in files within a directory.
- Set IsRegex to true for regex patterns
- Use Includes to filter by glob patterns`,
  parameters: z.object({
    SearchPath: z.string().describe('The path to search (directory or file)'),
    Query: z.string().describe('The search term or regex pattern'),
    CaseSensitive: z.boolean().optional().describe('Case-sensitive search'),
    IsRegex: z.boolean().optional().describe('Treat Query as regex'),
    Includes: z.array(z.string()).optional().describe('Glob patterns to filter files'),
    MatchPerLine: z.boolean().optional().describe('Show surrounding context'),
  }),
  execute: async ({ SearchPath, Query, CaseSensitive, IsRegex, Includes, MatchPerLine }) => {
    try {
      // Simple implementation using vscode's findFiles and grep
      const results: string[] = [];
      const flags = CaseSensitive ? '' : 'i';
      const regex = IsRegex ? new RegExp(Query, flags) : new RegExp(Query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      
      const searchInFile = (filePath: string): string[] => {
        const matches: string[] = [];
        try {
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
      
      const stat = fs.statSync(SearchPath);
      if (stat.isFile()) {
        results.push(...searchInFile(SearchPath));
      } else {
        results.push(...walkDir(SearchPath));
      }
      
      if (results.length === 0) {
        return `No matches found for "${Query}" in ${SearchPath}`;
      }
      
      const limited = results.slice(0, 50);
      return `Found ${results.length} matches:\n${limited.join('\n\n')}${results.length > 50 ? `\n\n... and ${results.length - 50} more` : ''}`;
    } catch (error) {
      return `Error searching: ${error}`;
    }
  },
});

/**
 * find_by_name tool - finds files by name pattern
 */
export const findByNameTool = tool({
  description: `Search for files and subdirectories by name pattern (glob format).`,
  parameters: z.object({
    SearchDirectory: z.string().describe('The directory to search within'),
    Pattern: z.string().describe('Pattern to search for (glob format)'),
    Type: z.enum(['file', 'directory', 'any']).optional(),
    MaxDepth: z.number().optional(),
    Extensions: z.array(z.string()).optional(),
  }),
  execute: async ({ SearchDirectory, Pattern, Type, MaxDepth, Extensions }) => {
    try {
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
      
      walkDir(SearchDirectory);
      
      if (results.length === 0) {
        return `Found 0 results for pattern "${Pattern}" in ${SearchDirectory}`;
      }
      
      return `Found ${results.length} results:\n${results.join('\n')}`;
    } catch (error) {
      return `Error finding files: ${error}`;
    }
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

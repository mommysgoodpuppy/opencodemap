import * as path from 'path';
import * as vscode from 'vscode';

const WINDOWS_PATH_REGEX = /[a-zA-Z]:\\[^\s"'<>]+/g;

function getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

export function getActiveWorkspaceRoot(): string | undefined {
  const folders = getWorkspaceFolders();
  if (folders.length === 0) {
    return undefined;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri?.scheme === 'file') {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (activeFolder) {
      return activeFolder.uri.fsPath;
    }
  }

  return folders[0].uri.fsPath;
}

export function findWorkspaceRootForPath(targetPath: string): string | undefined {
  const folders = getWorkspaceFolders();
  if (folders.length === 0) {
    return undefined;
  }

  const resolvedTarget = path.resolve(targetPath);
  const directFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(resolvedTarget));
  if (directFolder) {
    return directFolder.uri.fsPath;
  }

  let bestMatch: vscode.WorkspaceFolder | undefined;
  for (const folder of folders) {
    const folderPath = path.resolve(folder.uri.fsPath);
    if (resolvedTarget === folderPath || resolvedTarget.startsWith(folderPath + path.sep)) {
      if (!bestMatch || folderPath.length > path.resolve(bestMatch.uri.fsPath).length) {
        bestMatch = folder;
      }
    }
  }

  return bestMatch?.uri.fsPath;
}

export function findWorkspaceRootForQuery(query: string): string | undefined {
  const folders = getWorkspaceFolders();
  if (folders.length === 0) {
    return undefined;
  }

  const lowerQuery = query.toLowerCase();
  let bestMatch: vscode.WorkspaceFolder | undefined;
  for (const folder of folders) {
    const folderPath = folder.uri.fsPath;
    const lowerPath = folderPath.toLowerCase();
    const slashPath = lowerPath.replace(/\\/g, '/');
    if (lowerQuery.includes(lowerPath) || lowerQuery.includes(slashPath)) {
      if (!bestMatch || folderPath.length > bestMatch.uri.fsPath.length) {
        bestMatch = folder;
      }
    }
  }

  if (bestMatch) {
    return bestMatch.uri.fsPath;
  }

  const windowsPaths = query.match(WINDOWS_PATH_REGEX) ?? [];
  for (const candidate of windowsPaths) {
    const root = findWorkspaceRootForPath(candidate);
    if (root) {
      return root;
    }
  }

  return undefined;
}

export function pickWorkspaceRoot(query?: string): string | undefined {
  if (query) {
    const fromQuery = findWorkspaceRootForQuery(query);
    if (fromQuery) {
      return fromQuery;
    }
  }

  return getActiveWorkspaceRoot();
}

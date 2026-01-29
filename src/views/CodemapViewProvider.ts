/**
 * Codemap Webview View Provider - Sidebar integrated webview
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import type { Codemap, CodemapMetadata, DetailLevel } from '../types';
import {
  generateFastCodemap,
  generateSmartCodemap,
  isConfigured,
  generateSuggestions,
  retryTraceFromStage12Context,
  retryMermaidFromStage12Context,
  generateMermaidFromCodemapSnapshot,
  getAvailableModels,
  setModel,
  type ModelInfo,
} from '../agent';
import { allTools } from '../tools';
import {
  saveCodemap,
  listCodemaps,
  deleteCodemap,
  loadCodemap,
  getCodemapFilePath,
  saveDebugLog,
  updateCodemap,
} from '../storage/codemapStorage';
import { pickWorkspaceRoot, getActiveWorkspaceRoot } from '../workspace';
import * as logger from '../logger';

interface ActiveAgent {
  id: string;
  label: string;
  startTime: number;
}

interface ProgressState {
  totalStages: number;
  completedStages: number;
  activeAgents: ActiveAgent[];
  currentPhase: string;
  startedAt?: number;
  logPath?: string;
  parallelToolsActive?: boolean;
  totalTokens?: number;
  tokenSamples?: Array<{ time: number; tokens: number }>;
  totalToolCalls?: number;
  stageNumber?: number;
  filesRead?: number;
  linesRead?: number;
  lastFile?: string;
  lastTool?: string;
  recentFiles?: string[];
  toolBreakdown?: {
    internal: number;
    vscode: number;
  };
}

export class CodemapViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codemap.mainView';

  private _view?: vscode.WebviewView;
  private _codemap: Codemap | null = null;
  private _currentCodemapFilename: string | null = null;
  private _messages: Array<{ role: string; content: string }> = [];
  private _isProcessing = false;
  private _mode: 'fast' | 'smart' = 'smart';
  private _detailLevel: DetailLevel = 'overview';
  private _suggestions: Array<{ id: string; text: string; sub?: string; startingPoints?: string[] }> = [];
  private _recentFiles: string[] = [];
  private _refreshTimer: NodeJS.Timeout | null = null;
  private _progress: ProgressState | null = null;
  private _unreadCodemaps: Set<string> = new Set();
  private _availableModels: ModelInfo[] = [];
  private _selectedModel: string = '';
  private _abortController: AbortController | null = null;
  private _currentGenerationId: number = 0;
  private _lastTokenUpdateAt: number = 0;
  private _filesRead: Set<string> = new Set();
  private _linesRead: number = 0;
  private _toolUsage = { internal: 0, vscode: 0 };
  private _lastTool: string = '';
  private _lastFile: string = '';
  private _recentFilesRead: string[] = [];
  private _builtinToolNames: Set<string> = new Set(Object.keys(allTools));
  private _generationStartAt: number = 0;
  private _lastGenerationError: string | null = null;
  private _lastTokenCharCount: number = 0;
  private _tokenSamples: Array<{ time: number; tokens: number }> = [];
  private _activeDebugLogPath: string | null = null;
  private _lastLogFlushAt: number = 0;
  private _parallelFireTimeout: NodeJS.Timeout | null = null;
  private _currentWorkspaceRoot: string | null = null;

  constructor(private readonly _extensionUri: vscode.Uri) {
    // Track recent file access
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri.scheme === 'file') {
        this.addRecentFile(editor.document.uri.fsPath);
      }
    });
    
    // Track file saves
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === 'file') {
        this.addRecentFile(doc.uri.fsPath);
      }
    });

    // Refresh models when configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codemap')) {
        this._refreshModels();
      }
    });
  }

  private addRecentFile(filePath: string) {
    // Remove if exists, add to front
    this._recentFiles = this._recentFiles.filter(f => f !== filePath);
    this._recentFiles.unshift(filePath);
    
    // Keep only last 20 files
    if (this._recentFiles.length > 20) {
      this._recentFiles = this._recentFiles.slice(0, 20);
    }
    
    // Debounced refresh
    this.scheduleRefresh();
  }
  
  private scheduleRefresh() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
    }
    
    // Refresh suggestions every 30 seconds of activity
    this._refreshTimer = setTimeout(() => {
      this.refreshSuggestions();
    }, 30000);
  }

  private _resetProgressStats() {
    this._filesRead = new Set();
    this._linesRead = 0;
    this._toolUsage = { internal: 0, vscode: 0 };
    this._lastTool = '';
    this._lastFile = '';
    this._recentFilesRead = [];
    this._generationStartAt = Date.now();
    this._lastTokenCharCount = 0;
    this._tokenSamples = [];
    this._lastLogFlushAt = 0;
    if (this._parallelFireTimeout) {
      clearTimeout(this._parallelFireTimeout);
      this._parallelFireTimeout = null;
    }
  }

  private _flushActiveLog(force: boolean = false) {
    if (!this._activeDebugLogPath) {
      return;
    }
    const now = Date.now();
    if (!force && now - this._lastLogFlushAt < 500) {
      return;
    }
    const snapshot = logger.snapshotCapture();
    if (!snapshot) {
      return;
    }
    logger.writeCaptureToFile(this._activeDebugLogPath, snapshot);
    this._lastLogFlushAt = now;
  }

  private _recordTokenDelta(deltaText: string) {
    if (!deltaText || !this._progress) {
      return;
    }
    const chars = deltaText.length;
    this._lastTokenCharCount += chars;
    const estimatedTokens = Math.max(1, Math.ceil(chars / 4));
    this._recordTokenEstimate(estimatedTokens);
  }

  private _recordTokenEstimate(estimatedTokens: number) {
    if (!this._progress || !Number.isFinite(estimatedTokens) || estimatedTokens <= 0) {
      return;
    }
    this._progress.totalTokens = (this._progress.totalTokens || 0) + estimatedTokens;
    const now = Date.now();
    this._tokenSamples.push({ time: now, tokens: estimatedTokens });
    const cutoff = now - 4000;
    if (this._tokenSamples.length > 80 || (this._tokenSamples[0] && this._tokenSamples[0].time < cutoff)) {
      this._tokenSamples = this._tokenSamples.filter((s) => s.time >= cutoff);
    }
    this._progress.tokenSamples = [...this._tokenSamples];
  }

  private _recordToolTokenEstimate(args: string, result: string) {
    const combined = `${args ?? ''}${result ?? ''}`;
    if (!combined) {
      return;
    }
    const cappedLength = Math.min(2000, combined.length);
    const estimatedTokens = Math.max(1, Math.ceil(cappedLength / 4));
    this._recordTokenEstimate(estimatedTokens);
  }

  private _resolveWorkspaceRoot(query: string): string {
    const root = pickWorkspaceRoot(query) || '';
    return root;
  }

  private _getHistoryWorkspaceRoot(): string | undefined {
    return (
      this._currentWorkspaceRoot ||
      this._codemap?.workspacePath ||
      getActiveWorkspaceRoot()
    );
  }

  private _getModelId(): string {
    const config = vscode.workspace.getConfiguration('codemap');
    const provider = config.get<string>('provider') || 'openai';
    const model = config.get<string>('model') || '';
    return `${provider}:${model}`;
  }

  private _runGit(args: string[], cwd: string): string | undefined {
    try {
      const out = cp.execFileSync('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return String(out).trim();
    } catch {
      return undefined;
    }
  }

  private _getGitMetadata(workspaceRoot: string): { repoId?: string; git?: CodemapMetadata['git'] } {
    if (!workspaceRoot) {
      return {};
    }

    const commit = this._runGit(['rev-parse', 'HEAD'], workspaceRoot);
    const branch = this._runGit(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot);
    const dirtyOutput = this._runGit(['status', '--porcelain'], workspaceRoot);
    const dirty = dirtyOutput ? dirtyOutput.length > 0 : undefined;

    const remote =
      this._runGit(['config', '--get', 'remote.origin.url'], workspaceRoot) ||
      this._runGit(['config', '--get', 'remote.upstream.url'], workspaceRoot);

    const repoId = remote || path.basename(workspaceRoot);

    const gitMeta: CodemapMetadata['git'] = {};
    if (commit) gitMeta.commit = commit;
    if (branch) gitMeta.branch = branch;
    if (dirty !== undefined) gitMeta.dirty = dirty;

    return {
      repoId,
      git: Object.keys(gitMeta).length ? gitMeta : undefined,
    };
  }

  private _buildCodemapMetadata(workspaceRoot: string): CodemapMetadata {
    const durationMs = this._generationStartAt ? Date.now() - this._generationStartAt : undefined;
    const { repoId, git } = this._getGitMetadata(workspaceRoot);
    const totalTokens = this._progress?.totalTokens;

    const metadata: CodemapMetadata = {};

    const modelId = this._getModelId();
    if (modelId) metadata.model = modelId;
    if (typeof totalTokens === 'number' && totalTokens > 0) metadata.totalTokens = totalTokens;
    if (typeof durationMs === 'number' && durationMs > 0) metadata.timeTakenMs = durationMs;
    if (this._linesRead > 0) metadata.linesRead = this._linesRead;
    if (this._filesRead.size > 0) metadata.filesRead = Array.from(this._filesRead);
    if (repoId) metadata.repoId = repoId;
    if (git) metadata.git = git;

    return metadata;
  }

  private _recordToolCall(tool: string, args: string, result: string) {
    const isBuiltin = this._builtinToolNames.has(tool);
    if (isBuiltin) {
      this._toolUsage.internal += 1;
    } else {
      this._toolUsage.vscode += 1;
    }

    const filePaths: string[] = [];
    let linesRead = 0;

    if (tool === 'read_file') {
      let hasTagLines = false;
      try {
        const parsed = JSON.parse(args);
        if (parsed && Array.isArray(parsed.files)) {
          for (const entry of parsed.files) {
            if (entry && typeof entry.file_path === 'string') {
              filePaths.push(entry.file_path);
            }
            if (typeof entry?.limit === 'number') {
              linesRead += entry.limit;
            }
          }
        }
      } catch {
        // Ignore args parse errors
      }

      const tagMatches = Array.from(result.matchAll(/<file name="([^"]+)" start_line="(\d+)" end_line="(\d+)"/g));
      if (tagMatches.length > 0) {
        hasTagLines = true;
        linesRead = 0;
        for (const match of tagMatches) {
          const tagPath = match[1];
          const start = Number(match[2]);
          const end = Number(match[3]);
          if (tagPath && !filePaths.includes(tagPath)) {
            filePaths.push(tagPath);
          }
          if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
            linesRead += end - start + 1;
          }
        }
      }

      if (!hasTagLines && linesRead < 0) {
        linesRead = 0;
      }
    } else if (tool === 'parallel_read_file') {
      let hasTagLines = false;
      try {
        const parsed = JSON.parse(args);
        if (parsed && Array.isArray(parsed.files)) {
          for (const entry of parsed.files) {
            if (entry && typeof entry.file_path === 'string') {
              filePaths.push(entry.file_path);
            }
            if (typeof entry?.limit === 'number') {
              linesRead += entry.limit;
            }
          }
        }
      } catch {
        // Ignore args parse errors
      }

      const tagMatches = Array.from(result.matchAll(/<file name="([^"]+)" start_line="(\d+)" end_line="(\d+)"/g));
      if (tagMatches.length > 0) {
        hasTagLines = true;
        linesRead = 0;
        for (const match of tagMatches) {
          const tagPath = match[1];
          const start = Number(match[2]);
          const end = Number(match[3]);
          if (tagPath && !filePaths.includes(tagPath)) {
            filePaths.push(tagPath);
          }
          if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
            linesRead += end - start + 1;
          }
        }
      }

      if (!hasTagLines && linesRead < 0) {
        linesRead = 0;
      }
    }

    if (filePaths.length > 0) {
      for (const filePath of filePaths) {
        if (!this._filesRead.has(filePath)) {
          this._filesRead.add(filePath);
        }
        this._recentFilesRead = [
          filePath,
          ...this._recentFilesRead.filter((p) => p !== filePath),
        ].slice(0, 5);
      }
      this._lastFile = filePaths[filePaths.length - 1];
    }

    if (linesRead > 0) {
      this._linesRead += linesRead;
    }

    this._lastTool = tool;

    if (this._progress) {
      this._progress.toolBreakdown = { ...this._toolUsage };
      if (this._filesRead.size > 0) {
        this._progress.filesRead = this._filesRead.size;
      }
      if (this._linesRead > 0) {
        this._progress.linesRead = this._linesRead;
      }
      if (this._lastFile) {
        this._progress.lastFile = this._lastFile;
      }
      if (this._lastTool) {
        this._progress.lastTool = this._lastTool;
      }
      if (this._recentFilesRead.length > 0) {
        this._progress.recentFiles = [...this._recentFilesRead];
      }
      const toolLabel = (() => {
        if (filePaths.length === 1) {
          const base = path.basename(filePaths[0]);
          if (linesRead > 0) {
            return `Reading ${base} (${linesRead} lines)`;
          }
          return `Reading ${base}`;
        }
        if (filePaths.length > 1) {
          if (linesRead > 0) {
            return `Reading ${filePaths.length} files (${linesRead} lines)`;
          }
          return `Reading ${filePaths.length} files`;
        }
        return `Tool: ${tool}`;
      })();

      const existingIdx = this._progress.activeAgents.findIndex((a) => a.id === 'tool-activity');
      if (existingIdx >= 0) {
        this._progress.activeAgents[existingIdx].label = toolLabel;
      } else {
        this._progress.activeAgents.push({
          id: 'tool-activity',
          label: toolLabel,
          startTime: Date.now(),
        });
      }
    }
  }
  
  private async refreshSuggestions(): Promise<void> {
    if (!isConfigured() || this._recentFiles.length < 3) {
      return;
    }
    
    try {
      const suggestions = await generateSuggestions(this._recentFiles.slice(0, 10));
      this._suggestions = suggestions.map(s => ({
        id: s.id,
        text: s.text,
        sub: s.sub || 'Based on recent activity',
        startingPoints: s.startingPoints,
      }));
      this._updateWebview();
    } catch (error) {
      console.error('Failed to refresh suggestions:', error);
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist')],
    };

    webviewView.webview.html = this._getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'ready':
          this._updateWebview();
          // Initial load of suggestions
          this.refreshSuggestions();
          // Initialize models
          await this._refreshModels();
          break;
        case 'selectModel':
          await setModel(message.modelId);
          this._selectedModel = message.modelId;
          this._updateWebview();
          break;
        case 'submit':
          await this._handleSubmit(message.query, message.mode, message.detailLevel);
          break;
        case 'ensureMermaidDiagram':
          await this._generateMermaidDiagram(false);
          break;
        case 'retryTrace':
          await this._retryTrace(message.traceId);
          break;
        case 'retryAllTraces':
          await this._retryAllTraces();
          break;
        case 'regenerateMermaidDiagram':
          await this._generateMermaidDiagram(true);
          break;
        case 'openFile':
          this._openFile(message.path, message.line);
          break;
        case 'refreshHistory':
          this._updateWebview();
          break;
        case 'deleteHistory':
          this._deleteHistory(message.filename);
          break;
        case 'loadHistory':
          this._loadHistory(message.filename);
          break;
        case 'refreshSuggestions':
          await this.refreshSuggestions();
          break;
        case 'navigate':
          this._updateWebview();
          break;
        case 'cancel':
          if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
          }
          this._isProcessing = false;
          this._progress = null;
          this._updateWebview();
          break;
        case 'openJson':
          this._openCodemapJson();
          break;
        case 'openMermaid':
          this._openCodemapMermaid();
          break;
        case 'openDebugLog':
          this._openDebugLog();
          break;
        case 'pickTools':
          vscode.commands.executeCommand('codemap.pickTools');
          break;
      }
    });
  }

  /**
   * Generate or regenerate Mermaid diagram
   * @param force - If true, regenerate even if diagram already exists
   */
  private async _generateMermaidDiagram(force: boolean = false): Promise<void> {
    if (this._isProcessing) {
      return;
    }
    if (!this._view || !this._codemap) {
      return;
    }
    
    // Non-force mode: skip if diagram already exists
    if (!force && this._codemap.mermaidDiagram && this._codemap.mermaidDiagram.trim().length > 0) {
      return;
    }

    if (!isConfigured()) {
      vscode.window.showErrorMessage('Please set your OpenAI API key first');
      return;
    }

    this._isProcessing = true;
    this._resetProgressStats();
    const actionLabel = force ? 'Regenerating' : 'Generating';
    this._progress = {
      totalStages: 1,
      completedStages: 0,
      activeAgents: [
        { id: 'mermaid', label: `${actionLabel} Mermaid diagram...`, startTime: Date.now() },
      ],
      currentPhase: `${actionLabel} Mermaid diagram...`,
      startedAt: this._generationStartAt,
      totalTokens: 0,
      totalToolCalls: 0,
      stageNumber: 6,
      toolBreakdown: { ...this._toolUsage },
    };
    this._updateWebview();

    this._abortController = new AbortController();
    try {
      const callbacks = {
        onToken: (deltaText: string) => {
          if (this._progress) {
            this._recordTokenDelta(deltaText);
            const now = Date.now();
            if (!this._lastTokenUpdateAt || now - this._lastTokenUpdateAt > 100) {
              this._lastTokenUpdateAt = now;
              this._updateWebview();
            }
          }
        }
      };
      
      const result = this._codemap.stage12Context
        ? await retryMermaidFromStage12Context(this._codemap.stage12Context, callbacks, this._abortController.signal)
        : await generateMermaidFromCodemapSnapshot(this._codemap, callbacks, this._abortController.signal);

      if (result.error) {
        throw new Error(result.error);
      }
      if (!result.diagram || result.diagram.trim().length === 0) {
        throw new Error('No mermaid diagram returned');
      }

      this._codemap = {
        ...this._codemap,
        mermaidDiagram: result.diagram.trim(),
        updatedAt: new Date().toISOString(),
      };

      if (this._currentCodemapFilename) {
        updateCodemap(
          this._currentCodemapFilename,
          this._codemap,
          this._codemap.workspacePath || this._currentWorkspaceRoot || getActiveWorkspaceRoot()
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const action = force ? 'regenerate' : 'generate';
      vscode.window.showErrorMessage(`Failed to ${action} Mermaid diagram: ${msg}`);
    } finally {
      this._isProcessing = false;
      this._progress = null;
      this._updateWebview();
    }
  }

  private async _retryTrace(traceId: string): Promise<void> {
    if (this._isProcessing) {
      return;
    }
    if (!this._view || !this._codemap) {
      return;
    }

    const ctx = this._codemap.stage12Context;
    if (!ctx) {
      vscode.window.showErrorMessage(
        'This codemap cannot be retried (missing stage12Context). Regenerate the codemap first.'
      );
      return;
    }
    if (!isConfigured()) {
      vscode.window.showErrorMessage('Please set your OpenAI API key first');
      return;
    }

    const trace = this._codemap.traces.find((t) => t.id === traceId);
    if (!trace) {
      vscode.window.showErrorMessage(`Trace not found: ${traceId}`);
      return;
    }

    this._isProcessing = true;
    this._resetProgressStats();
    const completed = new Set<number>();
    this._progress = {
      totalStages: 3,
      completedStages: 0,
      activeAgents: [{ id: `trace-${traceId}`, label: `Retrying Trace ${traceId}...`, startTime: Date.now() }],
      currentPhase: 'Retrying trace...',
      startedAt: this._generationStartAt,
      totalTokens: 0,
      totalToolCalls: 0,
      stageNumber: 3,
      toolBreakdown: { ...this._toolUsage },
    };
    this._updateWebview();

    this._abortController = new AbortController();
    try {
      const stageLabels: Record<number, string> = {
        3: `Generating relation tree for Trace ${traceId}...`,
        4: `Adding location decorations for Trace ${traceId}...`,
        5: `Generating trace guide for Trace ${traceId}...`,
      };

      const result = await retryTraceFromStage12Context(traceId, ctx, {
        onToken: (deltaText: string) => {
          if (this._progress) {
            this._recordTokenDelta(deltaText);
            const now = Date.now();
            if (!this._lastTokenUpdateAt || now - this._lastTokenUpdateAt > 100) {
              this._lastTokenUpdateAt = now;
              this._updateWebview();
            }
          }
        },
        onToolCall: (tool, args, result) => {
          if (this._progress) {
            this._progress.totalToolCalls = (this._progress.totalToolCalls || 0) + 1;
            this._recordToolCall(tool, args ?? '', result ?? '');
            this._recordToolTokenEstimate(args ?? '', result ?? '');
          }
          this._updateWebview();
        },
        onTraceProcessing: (_tid, stage, status) => {
          if (!this._progress) {
            return;
          }
          if (status === 'start') {
            this._progress.stageNumber = stage;
            const idx = this._progress.activeAgents.findIndex((a) => a.id === `trace-${traceId}`);
            const label = stageLabels[stage] || `Retrying Trace ${traceId}...`;
            if (idx >= 0) {
              this._progress.activeAgents[idx].label = label;
            }
            this._progress.currentPhase = 'Retrying trace...';
          } else {
            completed.add(stage);
            this._progress.completedStages = completed.size;
            if (completed.size >= 3) {
              this._progress.activeAgents = this._progress.activeAgents.filter((a) => a.id !== `trace-${traceId}`);
            }
          }
          this._updateWebview();
        },
      }, this._abortController.signal);

      if (result.error) {
        throw new Error(result.error);
      }
      if (result.diagram) {
        trace.traceTextDiagram = result.diagram;
      }
      if (result.guide) {
        trace.traceGuide = result.guide;
      }

      this._codemap = {
        ...this._codemap,
        query: this._codemap.query || ctx.query,
        mode: this._codemap.mode || ctx.mode,
        updatedAt: new Date().toISOString(),
      };

      if (this._currentCodemapFilename) {
        updateCodemap(
          this._currentCodemapFilename,
          this._codemap,
          this._codemap.workspacePath || this._currentWorkspaceRoot || getActiveWorkspaceRoot()
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to retry trace ${traceId}: ${msg}`);
    } finally {
      this._isProcessing = false;
      this._progress = null;
      this._updateWebview();
    }
  }

  private async _retryAllTraces(): Promise<void> {
    if (this._isProcessing) {
      return;
    }
    if (!this._view || !this._codemap) {
      return;
    }

    const ctx = this._codemap.stage12Context;
    if (!ctx) {
      vscode.window.showErrorMessage(
        'This codemap cannot be retried (missing stage12Context). Regenerate the codemap first.'
      );
      return;
    }
    if (!isConfigured()) {
      vscode.window.showErrorMessage('Please set your OpenAI API key first');
      return;
    }
    if (this._codemap.traces.length === 0) {
      return;
    }

    const traceStages: Map<string, Set<number>> = new Map();
    const stageLabelsFor = (traceId: string): Record<number, string> => ({
      3: `Generating relation tree for Trace ${traceId}...`,
      4: `Adding location decorations for Trace ${traceId}...`,
      5: `Generating trace guide for Trace ${traceId}...`,
    });

    this._isProcessing = true;
    this._resetProgressStats();
    this._progress = {
      totalStages: this._codemap.traces.length * 3,
      completedStages: 0,
      activeAgents: [{ id: 'retry-all', label: 'Retrying all traces...', startTime: Date.now() }],
      currentPhase: 'Retrying all traces...',
      startedAt: this._generationStartAt,
      totalTokens: 0,
      totalToolCalls: 0,
      stageNumber: 3,
      toolBreakdown: { ...this._toolUsage },
    };
    this._updateWebview();

    this._abortController = new AbortController();
    try {
      const results = await Promise.all(
        this._codemap.traces.map(async (t) => {
          const traceId = t.id;
          const labels = stageLabelsFor(traceId);
          const res = await retryTraceFromStage12Context(traceId, ctx, {
            onToken: (deltaText: string) => {
              if (this._progress) {
                this._recordTokenDelta(deltaText);
                const now = Date.now();
                if (!this._lastTokenUpdateAt || now - this._lastTokenUpdateAt > 100) {
                  this._lastTokenUpdateAt = now;
                  this._updateWebview();
                }
              }
            },
            onToolCall: (tool, args, result) => {
              if (this._progress) {
                this._progress.totalToolCalls = (this._progress.totalToolCalls || 0) + 1;
                this._recordToolCall(tool, args ?? '', result ?? '');
                this._recordToolTokenEstimate(args ?? '', result ?? '');
              }
              this._updateWebview();
            },
            onTraceProcessing: (tid, stage, status) => {
              if (!this._progress) {
                return;
              }
              if (!traceStages.has(tid)) {
                traceStages.set(tid, new Set());
              }

              if (status === 'start') {
                this._progress.stageNumber = stage;
                const label = labels[stage] || `Retrying Trace ${tid}...`;
                const existingIdx = this._progress.activeAgents.findIndex((a) => a.id === `trace-${tid}`);
                if (existingIdx >= 0) {
                  this._progress.activeAgents[existingIdx].label = label;
                } else {
                  this._progress.activeAgents.push({ id: `trace-${tid}`, label, startTime: Date.now() });
                }
                this._progress.currentPhase = 'Retrying all traces...';
              } else {
                traceStages.get(tid)!.add(stage);
                let completedStages = 0;
                for (const s of traceStages.values()) {
                  completedStages += s.size;
                }
                this._progress.completedStages = completedStages;
                if (traceStages.get(tid)!.size >= 3) {
                  this._progress.activeAgents = this._progress.activeAgents.filter((a) => a.id !== `trace-${tid}`);
                }
              }
              this._updateWebview();
            },
          }, this._abortController!.signal);
          return { traceId, res };
        })
      );

      for (const { traceId, res } of results) {
        const trace = this._codemap.traces.find((x) => x.id === traceId);
        if (!trace) {
          continue;
        }
        if (res.error) {
          logger.warn(`Retry trace ${traceId} failed: ${res.error}`);
          continue;
        }
        if (res.diagram) {
          trace.traceTextDiagram = res.diagram;
        }
        if (res.guide) {
          trace.traceGuide = res.guide;
        }
      }

      this._codemap = {
        ...this._codemap,
        query: this._codemap.query || ctx.query,
        mode: this._codemap.mode || ctx.mode,
        updatedAt: new Date().toISOString(),
      };

      if (this._currentCodemapFilename) {
        updateCodemap(
          this._currentCodemapFilename,
          this._codemap,
          this._codemap.workspacePath || this._currentWorkspaceRoot || getActiveWorkspaceRoot()
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to retry all traces: ${msg}`);
    } finally {
      this._isProcessing = false;
      this._progress = null;
      this._updateWebview();
    }
  }


  public showHome() {
    if (this._view) {
      this._view.show?.(true);
      this._view.webview.postMessage({
        type: 'navigate',
        page: 'home',
      });
    }
  }

  public showWithQuery(query: string, mode: 'fast' | 'smart' = 'smart') {
    if (this._view) {
      this._view.show?.(true);
      this._view.webview.postMessage({
        type: 'setQuery',
        query,
      });
      this._mode = mode;
    }
  }

  public loadCodemap(codemap: Codemap) {
    this._codemap = codemap;
    this._messages = [
      { role: 'assistant', content: `Loaded saved codemap: ${codemap.title}` }
    ];
    this._updateWebview();
    // Navigate to detail page
    this._view?.webview.postMessage({
      type: 'navigate',
      page: 'detail',
    });
  }

  private async _handleSubmit(query: string, mode: 'fast' | 'smart', detailLevel: DetailLevel) {
    logger.separator('WEBVIEW SUBMIT');
    logger.info(`Submit received - query: "${query}", mode: ${mode}`);
    
    if (this._isProcessing) {
      logger.warn('Already processing a request, ignoring submit');
      vscode.window.showWarningMessage('Already processing a request');
      return;
    }

    if (!isConfigured()) {
      logger.error('OpenAI API key not configured');
      vscode.window.showErrorMessage('Please set your OpenAI API key first');
      return;
    }

    const workspaceRoot = this._resolveWorkspaceRoot(query);
    this._currentWorkspaceRoot = workspaceRoot || null;
    logger.startCapture(`Codemap generation: "${query}" (mode=${mode}, detail=${detailLevel})`);
    this._activeDebugLogPath = saveDebugLog('', query, workspaceRoot);
    this._flushActiveLog(true);
    logger.info('Starting codemap generation...');
    this._isProcessing = true;
    this._mode = mode;
    this._detailLevel = detailLevel;
    this._messages = [];
    this._codemap = null;
    this._lastGenerationError = null;
    let suppressFailureSave = false;
    let codemapSaved = false;
    this._resetProgressStats();
    
    // Initialize progress state
    // Stages: Research(1) + Structure(1) + Traces(N*3) + Mermaid(1)
    // We'll update totalStages once we know the number of traces
    this._progress = {
      totalStages: 3, // Initial: Research + Structure + Mermaid
      completedStages: 0,
      activeAgents: [{
        id: 'init',
        label: 'Starting codemap generation...',
        startTime: Date.now(),
      }],
      currentPhase: 'Starting codemap generation...',
      startedAt: this._generationStartAt,
      totalTokens: 0,
      totalToolCalls: 0,
      toolBreakdown: { ...this._toolUsage },
    };
    if (this._activeDebugLogPath) {
      (this._progress as ProgressState & { logPath?: string }).logPath = this._activeDebugLogPath;
    }
    
    this._updateWebview();

    const generationId = ++this._currentGenerationId;
    logger.info(`Workspace root: ${workspaceRoot}`);

    // Track trace stages for progress calculation
    const traceStages: Map<string, Set<number>> = new Map();
    let numTraces = 0;
    let stage12Context: Codemap['stage12Context'] | undefined = undefined;

    const callbacks = {
      onMessage: (role: string, content: string) => {
        if (this._currentGenerationId !== generationId) return;
        logger.debug(`[Callback] onMessage - role: ${role}, content length: ${content.length}`);
        this._messages.push({ role, content });
        this._flushActiveLog();
        this._updateWebview();
      },
      onToolCall: (tool: string, args: string, result: string) => {
        if (this._currentGenerationId !== generationId) return;
        logger.debug(`[Callback] onToolCall - tool: ${tool}`);
        
        if (this._progress) {
          this._progress.totalToolCalls = (this._progress.totalToolCalls || 0) + 1;
          this._recordToolCall(tool, args, result);
          this._recordToolTokenEstimate(args, result);
          if (this._progress.stageNumber === 1) {
            const expectedStage1Tools = 13;
            const ratio = Math.min(1, (this._progress.totalToolCalls || 0) / expectedStage1Tools);
            this._progress.completedStages = Math.max(this._progress.completedStages, ratio);
          }
        }

        this._messages.push({
          role: 'tool',
          content: `[${tool}]\n${args}\n---\n${result.slice(0, 300)}${result.length > 300 ? '...' : ''}`,
        });
        this._flushActiveLog();
        this._updateWebview();
      },
      onParallelToolState: (activeCount: number) => {
        if (this._currentGenerationId !== generationId || !this._progress) return;
        const wasActive = this._progress.parallelToolsActive;
        const isActive = activeCount > 1;
        this._progress.parallelToolsActive = isActive;
        if (wasActive !== isActive) {
          this._updateWebview();
        }
      },
      onCodemapUpdate: (codemap: Codemap) => {
        if (this._currentGenerationId !== generationId) return;
        logger.info(`[Callback] onCodemapUpdate - title: ${codemap.title}, traces: ${codemap.traces.length}`);
        this._codemap = stage12Context
          ? { ...codemap, stage12Context, query, mode, detailLevel }
          : { ...codemap, query, mode, detailLevel };
        
        // Update total stages when we know the number of traces
        if (codemap.traces.length > 0 && numTraces !== codemap.traces.length) {
          numTraces = codemap.traces.length;
          // Research(1) + Structure(1) + Traces(N*3) + Mermaid(1)
          if (this._progress) {
            this._progress.totalStages = 2 + (numTraces * 3) + 1;
          }
        }
        
        this._updateWebview();
      },
      onStage12ContextReady: (context: Codemap['stage12Context']) => {
        if (this._currentGenerationId !== generationId) return;
        stage12Context = context;
        if (this._codemap) {
          this._codemap = { ...this._codemap, stage12Context, query, mode, detailLevel };
          this._updateWebview();
        }
      },
      onPhaseChange: (phase: string, stageNumber: number) => {
        if (this._currentGenerationId !== generationId) return;
        logger.info(`[Callback] onPhaseChange - phase: ${phase}, stage: ${stageNumber}`);
        
        if (this._progress) {
          // Map phase to user-friendly progress text
          const phaseLabels: Record<number, string> = {
            1: 'Researching codebase...',
            2: 'Generating codemap structure...',
            3: 'Processing traces...',
            6: 'Generating Mermaid diagram...',
          };
          
          this._progress.currentPhase = phaseLabels[stageNumber] || phase;
          this._progress.stageNumber = stageNumber;
          
          // Update completed stages based on phase
          if (stageNumber === 2) {
            // Research complete
            this._progress.completedStages = 1;
          } else if (stageNumber === 3) {
            // Structure complete
            this._progress.completedStages = 2;
          } else if (stageNumber === 6) {
            // Starting mermaid - all trace stages should be complete
            this._progress.completedStages = 2 + (numTraces * 3);
          }
          
          // Clear active agents when phase changes (except for trace processing)
          if (stageNumber !== 3) {
            this._progress.activeAgents = [{
              id: `phase-${stageNumber}`,
              label: phaseLabels[stageNumber] || phase,
              startTime: Date.now(),
            }];
          }
        }
        
        this._updateWebview();
      },
      onTraceProcessing: (traceId: string, stage: number, status: 'start' | 'complete') => {
        if (this._currentGenerationId !== generationId) return;
        logger.debug(`[Callback] onTraceProcessing - trace: ${traceId}, stage: ${stage}, status: ${status}`);
        
        if (this._progress) {
          // Track completed stages per trace
          if (!traceStages.has(traceId)) {
            traceStages.set(traceId, new Set());
          }
          
          // Get trace title from codemap if available
          const traceIndex = parseInt(traceId) - 1;
          const trace = this._codemap?.traces[traceIndex];
          const traceTitle = trace?.title ? ` "${trace.title}"` : '';
          
          // Map stage to user-friendly label
          const stageLabels: Record<number, string> = {
            3: `Generating relation tree for Trace ${traceId}${traceTitle}...`,
            4: `Adding location decorations for Trace ${traceId}${traceTitle}...`,
            5: `Generating trace guide for Trace ${traceId}${traceTitle}...`,
          };
          
          if (status === 'start') {
            this._progress.stageNumber = stage;
            const label = stageLabels[stage] || `Processing Trace ${traceId}...`;
            
            // Add to active agents
            const existingIdx = this._progress.activeAgents.findIndex(a => a.id === `trace-${traceId}`);
            if (existingIdx >= 0) {
              this._progress.activeAgents[existingIdx].label = label;
            } else {
              this._progress.activeAgents.push({
                id: `trace-${traceId}`,
                label,
                startTime: Date.now(),
              });
            }
            this._progress.currentPhase = 'Processing traces...';
          } else if (status === 'complete') {
            // Mark stage as complete
            traceStages.get(traceId)!.add(stage);
            
            // Count total completed trace stages
            let completedTraceStages = 0;
            for (const stages of traceStages.values()) {
              completedTraceStages += stages.size;
            }
            
            // Update progress: Research(1) + Structure(1) + completed trace stages
            this._progress.completedStages = 2 + completedTraceStages;
            
            // Remove from active agents if all stages complete for this trace
            if (traceStages.get(traceId)!.size >= 3) {
              this._progress.activeAgents = this._progress.activeAgents.filter(
                a => a.id !== `trace-${traceId}`
              );
            }
          }
        }
        
        this._updateWebview();
      },
      onToken: (deltaText: string) => {
        if (this._currentGenerationId !== generationId) return;
        if (this._progress) {
          this._recordTokenDelta(deltaText);
          
          // Throttle updates to webview to avoid overwhelming it with messages
          // but enough to show smooth "streaming" effect
          const now = Date.now();
          if (!this._lastTokenUpdateAt || now - this._lastTokenUpdateAt > 100) {
            this._lastTokenUpdateAt = now;
            this._flushActiveLog();
            this._updateWebview();
          }
        }
      },
    };

    this._abortController = new AbortController();
    try {
      logger.info(`Calling generate${mode === 'fast' ? 'Fast' : 'Smart'}Codemap...`);
      if (mode === 'fast') {
        await generateFastCodemap(query, workspaceRoot, detailLevel, callbacks, this._abortController.signal);
      } else {
        await generateSmartCodemap(query, workspaceRoot, detailLevel, callbacks, this._abortController.signal);
      }
      logger.info('Codemap generation function returned');

      // Save codemap to storage if generation succeeded
      const codemap = this._codemap as Codemap | null;
      if (codemap) {
        const metadata = this._buildCodemapMetadata(workspaceRoot);
        const updatedCodemap: Codemap = {
          ...(codemap as Codemap),
          workspacePath: workspaceRoot || codemap.workspacePath,
          metadata,
          updatedAt: new Date().toISOString(),
        };
        this._codemap = updatedCodemap;
        logger.info('Saving codemap to storage...');
        const savedPath = saveCodemap(updatedCodemap, workspaceRoot);
        logger.info(`Codemap saved to: ${savedPath}`);
        codemapSaved = true;
        
        // Extract filename from path and track it
        const filename = savedPath.split(/[/\\]/).pop() || savedPath;
        this._currentCodemapFilename = filename;
        
        // Mark as unread
        this._unreadCodemaps.add(filename);
        
        this._messages.push({
          role: 'assistant',
          content: `Codemap saved to: ${savedPath}`,
        });
        
        // Update progress to complete
        if (this._progress) {
          this._progress.completedStages = this._progress.totalStages;
          this._progress.currentPhase = 'Codemap generated successfully!';
          this._progress.activeAgents = [{
            id: 'complete',
            label: 'Codemap generated successfully!',
            startTime: Date.now(),
          }];
        }
        
        this._updateWebview();
      } else {
        const msg = 'No codemap was generated (this._codemap is null)';
        logger.warn(msg);
        this._lastGenerationError = this._lastGenerationError || msg;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isCancelled =
        this._abortController?.signal.aborted ||
        (error instanceof Error && (error.message.includes('cancelled') || error.message.includes('aborted')));
      const isOutputBudget = errorMsg.toLowerCase().includes('output budget reached');

      if (isCancelled) {
        logger.info('Generation cancelled by user');
        this._lastGenerationError = 'Generation cancelled by user';
        return;
      }

      if (isOutputBudget) {
        logger.warn(`Codemap generation paused due to output budget: ${errorMsg}`);
        suppressFailureSave = true;
        const action = await vscode.window.showWarningMessage(
          'Output limit reached. How would you like to proceed?',
          { modal: false },
          'Continue',
          'Retry',
          'Cancel'
        );
        if (action === 'Continue') {
          if (this._codemap?.stage12Context) {
            await this._retryAllTraces();
            await this._generateMermaidDiagram(false);
          } else {
            await this._handleSubmit(query, mode, detailLevel);
          }
        } else if (action === 'Retry') {
          await this._handleSubmit(query, mode, detailLevel);
        }
        return;
      }

      this._lastGenerationError = errorMsg;
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(`Codemap generation failed: ${errorMsg}`);
      if (errorStack) {
        logger.error(`Stack trace: ${errorStack}`);
      }
      vscode.window.showErrorMessage(`Codemap generation failed: ${errorMsg}`);
    } finally {
      logger.info('Submit handler complete, resetting isProcessing to false');
      this._isProcessing = false;
      this._progress = null;
      this._updateWebview();
      logger.separator('WEBVIEW SUBMIT END');
      const captured = logger.endCapture();
      if (captured) {
        try {
          const logPath = this._activeDebugLogPath || saveDebugLog(captured, query, workspaceRoot);
          if (this._activeDebugLogPath) {
            logger.writeCaptureToFile(this._activeDebugLogPath, captured);
          }
          const baseCodemap: Codemap | null = this._codemap;
          const fallbackWorkspacePath =
            workspaceRoot ||
            baseCodemap?.workspacePath ||
            this._currentWorkspaceRoot ||
            getActiveWorkspaceRoot() ||
            '';
          if (baseCodemap) {
            this._codemap = {
              ...baseCodemap,
              debugLogPath: logPath,
              updatedAt: new Date().toISOString(),
            };
            if (this._currentCodemapFilename) {
              updateCodemap(this._currentCodemapFilename, this._codemap, workspaceRoot);
            }
          }
          if (!suppressFailureSave && this._lastGenerationError && !codemapSaved) {
            const metadata = this._buildCodemapMetadata(workspaceRoot);
            const cancelled = this._lastGenerationError.toLowerCase().includes('cancelled');
            const failureDescription = cancelled
              ? 'Generation cancelled by user'
              : `Generation failed: ${this._lastGenerationError}`;
            const failedCodemap: Codemap = baseCodemap
              ? {
                  ...baseCodemap,
                  title: `${cancelled ? 'Cancelled' : 'Failed'} codemap: ${query}`,
                  description: baseCodemap.description
                    ? `${baseCodemap.description}\n\n${failureDescription}`
                    : failureDescription,
                  debugLogPath: logPath,
                  metadata,
                  query,
                  mode,
                  detailLevel,
                  workspacePath: fallbackWorkspacePath,
                  updatedAt: new Date().toISOString(),
                }
              : {
                  title: `${cancelled ? 'Cancelled' : 'Failed'} codemap: ${query}`,
                  description: failureDescription,
                  traces: [],
                  debugLogPath: logPath,
                  metadata,
                  query,
                  mode,
                  detailLevel,
                  workspacePath: fallbackWorkspacePath,
                  updatedAt: new Date().toISOString(),
                };
            const savedPath = saveCodemap(failedCodemap, workspaceRoot);
            const filename = savedPath.split(/[/\\]/).pop() || savedPath;
            this._currentCodemapFilename = filename;
            this._codemap = failedCodemap;
            this._messages.push({
              role: 'assistant',
              content: `Failed codemap saved to: ${savedPath}`,
            });
          }
          this._messages.push({
            role: 'assistant',
            content: `Debug log saved to: ${logPath}`,
          });
          this._updateWebview();
        } catch {
          // Ignore debug log failures
        }
      }
      this._activeDebugLogPath = null;
    }
  }

  private _openFile(filePath: string, line: number) {
    const uri = vscode.Uri.file(filePath);
    vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(line - 1, 0, line - 1, 0),
      preview: false,
    });
  }

  private async _openCodemapJson() {
    if (!this._codemap || !this._currentCodemapFilename) {
      vscode.window.showWarningMessage('No codemap loaded');
      return;
    }

    // Open the actual JSON file from storage
    const filePath = getCodemapFilePath(
      this._currentCodemapFilename,
      this._codemap.workspacePath || this._currentWorkspaceRoot || getActiveWorkspaceRoot()
    );
    const uri = vscode.Uri.file(filePath);
    
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        preview: false,
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open codemap file: ${filePath}`);
    }
  }

  private async _openCodemapMermaid() {
    if (!this._codemap || !this._codemap.mermaidDiagram) {
      vscode.window.showWarningMessage('No Mermaid diagram available');
      return;
    }

    const content = `\`\`\`mermaid\n${this._codemap.mermaidDiagram}\n\`\`\``.replace(/\r\n/g, '\n');

    try {
      const doc = await vscode.workspace.openTextDocument({
        content,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, {
        preview: false,
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open Mermaid export: ${error}`);
    }
  }

  private async _openDebugLog() {
    const logPath = this._activeDebugLogPath || this._codemap?.debugLogPath;
    if (!logPath) {
      vscode.window.showWarningMessage('No debug log available');
      return;
    }

    const uri = vscode.Uri.file(logPath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        preview: false,
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open debug log: ${error}`);
    }
  }

  private _deleteHistory(filename: string) {
    if (deleteCodemap(filename, this._getHistoryWorkspaceRoot())) {
      this._unreadCodemaps.delete(filename);
      vscode.window.showInformationMessage('Codemap deleted');
      this._updateWebview();
    }
  }

  private _loadHistory(filename: string) {
    const codemap = loadCodemap(filename, this._getHistoryWorkspaceRoot());
    if (codemap) {
      this._codemap = codemap;
      this._currentCodemapFilename = filename;
      // Mark as read
      this._unreadCodemaps.delete(filename);
      this._messages = [
        { role: 'assistant', content: `Loaded saved codemap: ${codemap.title}` }
      ];
      this._updateWebview();
      // Navigate to detail page
      this._view?.webview.postMessage({
        type: 'navigate',
        page: 'detail',
      });
    } else {
      vscode.window.showErrorMessage(`Failed to load codemap: ${filename}`);
    }
  }

  private _getHistory() {
    const codemaps = listCodemaps(this._getHistoryWorkspaceRoot());
    return codemaps.map(({ filename, codemap }) => ({
      id: filename,
      codemap,
      timestamp: new Date(codemap.savedAt || Date.now()).getTime(),
      isUnread: this._unreadCodemaps.has(filename),
    }));
  }

  private _updateWebview() {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'update',
        codemap: this._codemap,
        messages: this._messages,
        isProcessing: this._isProcessing,
        mode: this._mode,
        detailLevel: this._detailLevel,
        suggestions: this._suggestions,
        history: this._getHistory(),
        progress: this._progress,
        availableModels: this._availableModels,
        selectedModel: (() => {
          const config = vscode.workspace.getConfiguration('codemap');
          const provider = config.get<string>('provider') || 'openai';
          const model = config.get<string>('model') || '';
          return `${provider}:${model}`;
        })(),
      });
    }
  }

  private _getHtmlContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'main.js')
    );

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'main.css')
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; font-src https://fonts.gstatic.com; connect-src https://cdn.jsdelivr.net;">
  <link rel="stylesheet" href="${styleUri}">
  <title>Codemap</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
  private async _refreshModels() {
    try {
      this._availableModels = await getAvailableModels();
      this._updateWebview();
    } catch (e) {
      console.error('Failed to refresh models:', e);
    }
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

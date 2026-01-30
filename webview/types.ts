export type DetailLevel = 'overview' | 'low' | 'medium' | 'high' | 'ultra';

/**
 * Shared types for Webview <-> Extension communication
 */

export interface CodemapLocation {
  id: string;
  path: string;
  lineNumber: number;
  lineContent: string;
  title: string;
  description: string;
}

export interface CodemapTrace {
  id: string;
  title: string;
  description: string;
  locations: CodemapLocation[];
  traceTextDiagram?: string;
  traceGuide?: string;
}

export interface CodemapStage12ContextV1 {
  schemaVersion: 1;
  createdAt: string;
  query: string;
  mode: 'fast' | 'smart';
  workspaceRoot: string;
  currentDate: string;
  language: string;
  systemPrompt: string;
  baseMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface Codemap {
  title: string;
  description: string;
  traces: CodemapTrace[];
  mermaidDiagram?: string;
  debugLogPath?: string;
  metadata?: CodemapMetadata;
  savedAt?: string;
  // Optional metadata persisted by extension storage (backwards compatible)
  updatedAt?: string;
  workspacePath?: string;
  query?: string;
  mode?: 'fast' | 'smart';
  detailLevel?: DetailLevel;
  schemaVersion?: number;
  // Persisted Stage 1-2 shared context for retries
  stage12Context?: CodemapStage12ContextV1;
}

export interface CodemapMetadata {
  model?: string;
  totalTokens?: number;
  timeTakenMs?: number;
  linesRead?: number;
  filesRead?: string[];
  repoId?: string;
  git?: {
    commit?: string;
    branch?: string;
    dirty?: boolean;
  };
  verification?: {
    fixedLocations?: number;
    unmatchedLocations?: number;
    fixedDetails?: Array<{
      traceId: string;
      locationId: string;
      from: { path: string; lineNumber: number };
      to: { path: string; lineNumber: number };
      matchKind?: 'exact' | 'approximate';
    }>;
  };
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool' | 'error';
  content: string;
}

export interface CodemapSuggestion {
  id: string;
  text: string;
  sub?: string;
}

export interface CodemapHistoryItem {
  id: string;
  codemap: Codemap;
  timestamp: number;
  isUnread?: boolean;
}

/** Progress state for codemap generation */
export interface ProgressState {
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
  toolBreakdown?: ToolBreakdown;
}

export interface ActiveAgent {
  id: string;
  label: string;
  startTime: number;
}

export interface ToolBreakdown {
  internal: number;
  vscode: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  family: string;
  vendor: string;
  isFree?: boolean;
}

// Messages from Webview to Extension
export type WebviewToExtensionMessage =
  | { command: 'submit'; query: string; mode: 'fast' | 'smart'; detailLevel: DetailLevel }
  | { command: 'openFile'; path: string; line: number }
  | { command: 'ready' }
  | { command: 'refreshHistory' }
  | { command: 'deleteHistory'; filename: string }
  | { command: 'loadHistory'; filename: string }
  | { command: 'refreshSuggestions' }
  | { command: 'openJson' }
  | { command: 'openMermaid' }
  | { command: 'openDebugLog' }
  | { command: 'ensureMermaidDiagram' }
  | { command: 'retryTrace'; traceId: string }
  | { command: 'retryAllTraces' }
  | { command: 'regenerateMermaidDiagram' }
  | { command: 'selectModel'; modelId: string }
  | { command: 'cancel' }
  | { command: 'pickTools' };

// Messages from Extension to Webview
export type ExtensionToWebviewMessage =
  | {
      type: 'update';
      codemap: Codemap | null;
      messages: AgentMessage[];
      isProcessing: boolean;
      mode: 'fast' | 'smart';
      detailLevel: DetailLevel;
      suggestions: CodemapSuggestion[];
      history: CodemapHistoryItem[];
      progress?: ProgressState;
      availableModels?: ModelInfo[];
      selectedModel?: string;
    }
  | { type: 'setQuery'; query: string }
  | { type: 'navigate'; page: 'home' | 'detail' };

// VSCode API type declaration for webview
export interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  function acquireVsCodeApi(): VsCodeApi;
}

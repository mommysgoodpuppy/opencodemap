/**
 * Codemap type definitions
 */

import type { CodemapStage12ContextV1 } from './agent';

export type DetailLevel = 'overview' | 'low' | 'medium' | 'high' | 'ultra';

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

export interface Codemap {
  title: string;
  description: string;
  traces: CodemapTrace[];
  mermaidDiagram?: string;
  /**
   * Persisted Stage 1-2 shared context for retrying later stages without re-running research.
   * Stored inside the same codemap JSON (no sidecar file).
   */
  stage12Context?: CodemapStage12ContextV1;
  /**
   * Optional metadata persisted by Codemap storage layer (backwards compatible).
   */
  savedAt?: string;
  workspacePath?: string;
  query?: string;
  mode?: 'fast' | 'smart';
  detailLevel?: DetailLevel;
  schemaVersion?: number;
  updatedAt?: string;
}

export interface CodemapSuggestion {
  id: string;
  text: string;
  sub?: string;
  startingPoints?: string[];
  timestamp: number;
}

export interface ToolCallResult {
  toolName: string;
  callId: string;
  arguments: Record<string, unknown>;
  result: string;
  error?: string;
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCallResult[];
}

export interface AgentState {
  messages: AgentMessage[];
  currentCodemap: Codemap | null;
  isProcessing: boolean;
}

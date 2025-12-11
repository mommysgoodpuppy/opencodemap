/**
 * Codemap type definitions
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

export interface Codemap {
  title: string;
  description: string;
  traces: CodemapTrace[];
  mermaidDiagram?: string;
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

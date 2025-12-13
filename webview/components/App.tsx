import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { GitFork, LayoutDashboard, Info, FileJson, RefreshCw } from 'lucide-react';
import { QueryBar } from './QueryBar';
import { SuggestionSection } from './SuggestionSection';
import { CodemapList } from './CodemapList';
import { CodemapTreeView, renderInlineMarkdown } from './CodemapTreeView';
import { CodemapDiagramView } from './CodemapDiagramView';
import { useExtensionCommands, useVsCodeApi } from '../extensionBridge';
import type {
  Codemap,
  CodemapSuggestion,
  CodemapHistoryItem,
  CodemapLocation,
  ExtensionToWebviewMessage,
  ProgressState,
} from '../types';

interface AppState {
  query: string;
  mode: 'fast' | 'smart';
  isProcessing: boolean;
  codemap: Codemap | null;
  suggestions: CodemapSuggestion[];
  history: CodemapHistoryItem[];
  activeView: 'tree' | 'diagram';
  page: 'home' | 'detail';
  progress?: ProgressState;
}

/**
 * Main application component for Codemap webview.
 */
export const App: React.FC = () => {
  const api = useVsCodeApi();
  const commands = useExtensionCommands();

  const [state, setState] = useState<AppState>(() => {
    // Try to restore state from VS Code
    const saved = api.getState() as Partial<AppState> | null;
    return {
      query: saved?.query || '',
      mode: saved?.mode || 'smart',
      isProcessing: false,
      codemap: null,
      suggestions: [],
      history: [],
      activeView: saved?.activeView || 'tree',
      page: saved?.page || 'home',
    };
  });

  // Persist state changes
  useEffect(() => {
    api.setState({
      query: state.query,
      mode: state.mode,
      activeView: state.activeView,
      page: state.page,
    });
  }, [api, state.query, state.mode, state.activeView, state.page]);

  // Handle messages from extension
  useEffect(() => {
    const handleMessage = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const message = event.data;
      
      switch (message.type) {
        case 'update':
          setState((prev) => {
            // Don't auto-navigate to detail page when codemap is generated
            // User needs to manually click to view it
            const shouldReturnHome =
              !message.codemap &&
              !message.isProcessing &&
              prev.page === 'detail';

            return {
              ...prev,
              codemap: message.codemap,
              isProcessing: message.isProcessing,
              mode: message.mode,
              suggestions: message.suggestions,
              history: message.history,
              progress: message.progress,
              // Stay on current page, only go home if detail page has no codemap
              page: shouldReturnHome ? 'home' : prev.page,
            };
          });
          break;
          
        case 'setQuery':
          setState((prev) => ({
            ...prev,
            query: message.query,
          }));
          break;

        case 'navigate':
          setState((prev) => ({
            ...prev,
            page: message.page,
          }));
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    
    // Signal that webview is ready
    commands.ready();
    
    return () => window.removeEventListener('message', handleMessage);
  }, [commands]);

  // Handlers
  const handleQueryChange = useCallback((query: string) => {
    setState((prev) => ({ ...prev, query }));
  }, []);

  const handleModeChange = useCallback((mode: 'fast' | 'smart') => {
    setState((prev) => ({ ...prev, mode }));
  }, []);

  const handleSubmit = useCallback(() => {
    if (state.query.trim() && !state.isProcessing) {
      commands.submit(state.query.trim(), state.mode);
    }
  }, [commands, state.query, state.mode, state.isProcessing]);

  const handleSuggestionClick = useCallback((suggestion: CodemapSuggestion) => {
    // Only fill query, don't auto-submit
    setState((prev) => ({ ...prev, query: suggestion.text }));
  }, []);

  const handleRefreshSuggestions = useCallback(() => {
    commands.refreshSuggestions();
  }, [commands]);

  const handleLoadHistory = useCallback((id: string) => {
    commands.loadHistory(id);
  }, [commands]);

  const handleDeleteHistory = useCallback((id: string) => {
    commands.deleteHistory(id);
  }, [commands]);

  const handleRefreshHistory = useCallback(() => {
    commands.refreshHistory();
  }, [commands]);

  const handleLocationClick = useCallback((location: CodemapLocation) => {
    commands.openFile(location.path, location.lineNumber);
  }, [commands]);

  const handleViewChange = useCallback((view: 'tree' | 'diagram') => {
    setState((prev) => ({ ...prev, activeView: view }));
  }, []);

  const handleOpenJson = useCallback(() => {
    commands.openJson();
  }, [commands]);

  const handleRetryTrace = useCallback((traceId: string) => {
    if (state.isProcessing) return;
    commands.retryTrace(traceId);
  }, [commands, state.isProcessing]);

  const handleRetryAllTraces = useCallback(() => {
    if (state.isProcessing) return;
    commands.retryAllTraces();
  }, [commands, state.isProcessing]);

  const handleRegenerateMermaidDiagram = useCallback(() => {
    if (state.isProcessing) return;
    commands.regenerateMermaidDiagram();
  }, [commands, state.isProcessing]);

  const handleRegenerateFromScratch = useCallback((item: CodemapHistoryItem) => {
    const query =
      item.codemap.query ||
      item.codemap.stage12Context?.query ||
      '';
    const mode =
      item.codemap.mode ||
      item.codemap.stage12Context?.mode ||
      state.mode;
    setState((prev) => ({ ...prev, query, mode }));
  }, [state.mode]);

  // Build location map for description links
  const allLocations = useMemo(() => {
    const map = new Map<string, CodemapLocation>();
    if (state.codemap) {
      for (const trace of state.codemap.traces) {
        for (const loc of trace.locations) {
          map.set(loc.id, loc);
        }
      }
    }
    return map;
  }, [state.codemap]);

  // Home page: query + suggestions + codemap list
  if (state.page === 'home') {
    return (
      <div className="app-container">
        <QueryBar
          query={state.query}
          mode={state.mode}
          isProcessing={state.isProcessing}
          onQueryChange={handleQueryChange}
          onModeChange={handleModeChange}
          onSubmit={handleSubmit}
        />

        <SuggestionSection
          suggestions={state.suggestions}
          onSuggestionClick={handleSuggestionClick}
          onRefresh={handleRefreshSuggestions}
        />

        <CodemapList
          currentCodemap={state.codemap}
          history={state.history}
          isProcessing={state.isProcessing}
          progress={state.progress}
          onLoadHistory={handleLoadHistory}
          onDeleteHistory={handleDeleteHistory}
          onRefresh={handleRefreshHistory}
          onRegenerateFromScratch={handleRegenerateFromScratch}
        />
      </div>
    );
  }

  // Detail page: tree/diagram views (back in VS Code view title bar)
  return (
    <div className="app-container">
      {/* Header with title, meta, tabs and description */}
      <div className="detail-header">
        {/* Title row */}
        <div className="detail-title">{state.codemap?.title || 'Codemap'}</div>
        
        {/* Meta row */}
        {state.codemap?.savedAt && (
          <div className="detail-meta">
            <Info size={12} />
            <span>Created {new Date(state.codemap.savedAt).toLocaleString()}</span>
          </div>
        )}
        
        {/* Description with clickable location refs */}
        {state.codemap && state.codemap.description && (
          <div className="detail-description">
            {renderInlineMarkdown(state.codemap.description, {
              onOpenFile: (filePath, lineNumber) => {
                handleLocationClick({
                  id: `file-${filePath}`,
                  path: filePath,
                  lineNumber: lineNumber || 1,
                  lineContent: '',
                  title: filePath.split(/[/\\]/).pop() || filePath,
                  description: '',
                });
              },
              onOpenLocationRef: (locationId) => {
                const loc = allLocations.get(locationId);
                if (loc) handleLocationClick(loc);
              },
            })}
          </div>
        )}
        
        {/* View tabs row */}
        <div className="view-tabs">
          <button
            className={`view-tab ${state.activeView === 'tree' ? 'active' : ''}`}
            onClick={() => handleViewChange('tree')}
          >
            <GitFork size={14} />
            Tree View
          </button>
          <button
            className="icon-btn"
            onClick={handleRetryAllTraces}
            title="Retry all traces"
            disabled={state.isProcessing || !state.codemap?.stage12Context}
          >
            <RefreshCw size={14} />
          </button>
          <button
            className={`view-tab ${state.activeView === 'diagram' ? 'active' : ''}`}
            onClick={() => handleViewChange('diagram')}
          >
            <LayoutDashboard size={14} />
            Diagram
          </button>
          <button
            className="icon-btn"
            onClick={handleRegenerateMermaidDiagram}
            title="Regenerate Mermaid diagram"
            disabled={state.isProcessing || !state.codemap}
          >
            <RefreshCw size={14} />
          </button>
          <button
            className="view-tab"
            onClick={handleOpenJson}
            title="Open JSON file"
          >
            <FileJson size={14} />
            JSON
          </button>
        </div>
      </div>

      <div className="scroll-container custom-scrollbar">
        {state.activeView === 'tree' ? (
          <CodemapTreeView
            codemap={state.codemap}
            onLocationClick={handleLocationClick}
            isProcessing={state.isProcessing}
            canRetryTraces={Boolean(state.codemap?.stage12Context)}
            onRetryTrace={handleRetryTrace}
          />
        ) : (
          <CodemapDiagramView codemap={state.codemap} onLocationClick={handleLocationClick} />
        )}
      </div>
    </div>
  );
};

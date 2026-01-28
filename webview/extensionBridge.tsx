import React, { createContext, useContext, useMemo } from 'react';
import type { VsCodeApi, WebviewToExtensionMessage } from './types';

/**
 * VS Code webview API can only be acquired once per webview.
 * We acquire it in one place (entry) and inject via React context.
 */

const VsCodeApiContext = createContext<VsCodeApi | null>(null);

function createFallbackApi(): VsCodeApi {
  return {
    postMessage: (msg: WebviewToExtensionMessage) => console.log('postMessage:', msg),
    getState: () => null,
    setState: () => { },
  };
}

export function createVsCodeApi(): VsCodeApi {
  const w = window as any;
  return typeof w.acquireVsCodeApi === 'function' ? w.acquireVsCodeApi() : createFallbackApi();
}

export function ExtensionBridgeProvider(props: { api: VsCodeApi; children: React.ReactNode }) {
  return <VsCodeApiContext.Provider value={props.api}>{props.children}</VsCodeApiContext.Provider>;
}

export function useVsCodeApi(): VsCodeApi {
  const api = useContext(VsCodeApiContext);
  if (!api) {
    throw new Error('useVsCodeApi must be used within <ExtensionBridgeProvider>');
  }
  return api;
}

/**
 * Typed command helpers. Components call functions, not `api.postMessage({ command: ... })`.
 * This keeps VS Code messaging details in one place.
 */
export function useExtensionCommands() {
  const api = useVsCodeApi();

  return useMemo(
    () => ({
      send: (message: WebviewToExtensionMessage) => api.postMessage(message),
      ready: () => api.postMessage({ command: 'ready' }),
      submit: (query: string, mode: 'fast' | 'smart') =>
        api.postMessage({ command: 'submit', query, mode }),
      openFile: (path: string, line: number) => api.postMessage({ command: 'openFile', path, line }),
      refreshHistory: () => api.postMessage({ command: 'refreshHistory' }),
      deleteHistory: (filename: string) => api.postMessage({ command: 'deleteHistory', filename }),
      loadHistory: (filename: string) => api.postMessage({ command: 'loadHistory', filename }),
      refreshSuggestions: () => api.postMessage({ command: 'refreshSuggestions' }),
      openJson: () => api.postMessage({ command: 'openJson' }),
      ensureMermaidDiagram: () => api.postMessage({ command: 'ensureMermaidDiagram' }),
      retryTrace: (traceId: string) => api.postMessage({ command: 'retryTrace', traceId }),
      retryAllTraces: () => api.postMessage({ command: 'retryAllTraces' }),
      regenerateMermaidDiagram: () => api.postMessage({ command: 'regenerateMermaidDiagram' }),
      selectModel: (modelId: string) => api.postMessage({ command: 'selectModel', modelId }),
      cancel: () => api.postMessage({ command: 'cancel' }),
    }),
    [api]
  );
}



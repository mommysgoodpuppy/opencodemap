import React, { useState, useMemo, useEffect } from 'react';
import { X, Trash2, RefreshCw, Circle } from 'lucide-react';
import type { Codemap, CodemapHistoryItem, ProgressState } from '../types';

interface CodemapListProps {
  currentCodemap: Codemap | null;
  history: CodemapHistoryItem[];
  isProcessing: boolean;
  progress?: ProgressState;
  onLoadHistory: (id: string) => void;
  onDeleteHistory: (id: string) => void;
  onRefresh: () => void;
  onRegenerateFromScratch: (item: CodemapHistoryItem) => void;
  onCancel: () => void;
}

/**
 * List of saved codemaps with search and actions.
 * Shows progress indicator during generation.
 */
export const CodemapList: React.FC<CodemapListProps> = ({
  currentCodemap,
  history,
  isProcessing,
  progress,
  onLoadHistory,
  onDeleteHistory,
  onRefresh,
  onRegenerateFromScratch,
  onCancel,
}) => {
  const [searchText, setSearchText] = useState('');
  const [activeAgentIndex, setActiveAgentIndex] = useState(0);

  // Rotate through active agents every 2 seconds
  useEffect(() => {
    if (!progress || progress.activeAgents.length <= 1) {
      setActiveAgentIndex(0);
      return;
    }

    const interval = setInterval(() => {
      setActiveAgentIndex((prev) => (prev + 1) % progress.activeAgents.length);
    }, 2000);

    return () => clearInterval(interval);
  }, [progress?.activeAgents.length]);

  const filteredHistory = useMemo(() => {
    if (!searchText.trim()) {
      return history;
    }
    const lower = searchText.toLowerCase();
    return history.filter(
      (item) =>
        item.codemap.title.toLowerCase().includes(lower) ||
        item.codemap.description.toLowerCase().includes(lower)
    );
  }, [history, searchText]);

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const formatDuration = (ms?: number) => {
    if (!ms || ms <= 0) return '';
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.round(seconds / 60);
    return `${mins}m`;
  };

  const buildMetaTitle = (item: CodemapHistoryItem) => {
    const meta = item.codemap.metadata;
    if (!meta) return undefined;
    const parts: string[] = [];
    if (meta.model) parts.push(`Model: ${meta.model}`);
    if (typeof meta.totalTokens === 'number') parts.push(`Tokens: ${meta.totalTokens.toLocaleString()}`);
    if (meta.timeTakenMs) parts.push(`Time: ${formatDuration(meta.timeTakenMs)}`);
    if (meta.linesRead) parts.push(`Lines: ${meta.linesRead.toLocaleString()}`);
    if (meta.filesRead?.length) parts.push(`Files: ${meta.filesRead.length}`);
    if (meta.repoId) parts.push(`Repo: ${meta.repoId}`);
    if (meta.git?.branch) parts.push(`Branch: ${meta.git.branch}`);
    if (meta.git?.commit) parts.push(`Commit: ${meta.git.commit}`);
    if (meta.git?.dirty !== undefined) parts.push(`Dirty: ${meta.git.dirty ? 'yes' : 'no'}`);
    return parts.length ? parts.join(' • ') : undefined;
  };

  const isCurrentCodemap = (item: CodemapHistoryItem) => {
    return currentCodemap && currentCodemap.title === item.codemap.title;
  };

  // Calculate progress percentage
  const progressPercent = progress
    ? Math.round((progress.completedStages / progress.totalStages) * 100)
    : 0;

  // Get current active agent label
  const currentAgentLabel = progress?.activeAgents[activeAgentIndex]?.label || progress?.currentPhase || 'Processing...';
  const lastFileName = progress?.lastFile ? progress.lastFile.split(/[\\/]/).pop() : '';
  const recentFiles = progress?.recentFiles || [];

  return (
    <div className="codemap-list-section">
      <div className="list-header">
        <span className="section-title">Your Codemaps</span>
        <input
          type="text"
          className="search-input"
          placeholder="Search"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <button className="icon-btn" onClick={onRefresh} title="Refresh list">
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Processing indicator with progress */}
      {isProcessing && (
        <div className={`codemap-item processing-item ${progress?.parallelToolsActive ? 'parallel-fire' : ''}`}>
          <div className="codemap-item-header">
            <span className="codemap-item-title">
              Generating...
              <span className="processing-badge">In Progress</span>
            </span>
            <button
              className="icon-btn"
              onClick={onCancel}
              title="Cancel Generation"
              style={{ color: 'var(--vscode-errorForeground)' }}
            >
              <X size={14} />
            </button>
          </div>

          {/* Progress bar */}
          <div className="progress-container">
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="progress-text">{progressPercent}%</span>
          </div>

          {/* Rotating status text */}
          <div className="progress-status">
            <div className="status-main">
              <span className="status-dot" />
              <span className="status-text">{currentAgentLabel}</span>
            </div>

            <div className="status-activity">
              {progress?.totalToolCalls !== undefined && progress.totalToolCalls > 0 && (
                <div className="tool-indicator" title="Tools used">
                  <RefreshCw size={10} className="spinning" />
                  <span>{progress.totalToolCalls}</span>
                </div>
              )}

              {progress?.totalTokens !== undefined && progress.totalTokens > 0 && (
                <div className="token-counter">
                  <div className="token-stream">
                    <div className={`token-particle ${progress.totalTokens % 3 === 0 ? 'active' : ''}`} />
                    <div className={`token-particle ${progress.totalTokens % 3 === 1 ? 'active' : ''}`} />
                    <div className={`token-particle ${progress.totalTokens % 3 === 2 ? 'active' : ''}`} />
                  </div>
                  <span>{progress.totalTokens.toLocaleString()} tokens</span>
                </div>
              )}
            </div>
          </div>

          <div className="progress-meta">
            {progress?.stageNumber !== undefined && (
              <div className="meta-chip" title="Current stage">
                <span className="meta-label">Stage</span>
                <span className="meta-value">{progress.stageNumber}</span>
              </div>
            )}
            {progress?.filesRead !== undefined && progress.filesRead > 0 && (
              <div className="meta-chip" title="Files read">
                <span className="meta-label">Files</span>
                <span className="meta-value">{progress.filesRead}</span>
              </div>
            )}
            {progress?.linesRead !== undefined && progress.linesRead > 0 && (
              <div className="meta-chip" title="Lines read">
                <span className="meta-label">Lines</span>
                <span className="meta-value">{progress.linesRead.toLocaleString()}</span>
              </div>
            )}
            {progress?.toolBreakdown && (progress.toolBreakdown.internal + progress.toolBreakdown.vscode) > 0 && (
              <div className="meta-chip" title="Tools used (internal / VS Code)">
                <span className="meta-label">Tools</span>
                <span className="meta-value">
                  {progress.toolBreakdown.internal}/{progress.toolBreakdown.vscode}
                </span>
              </div>
            )}
          </div>

          {progress?.lastFile && (
            <div className="progress-file" title={progress.lastFile}>
              Reading: <span className="mono">{lastFileName || progress.lastFile}</span>
            </div>
          )}

          {progress?.lastTool && (
            <div className="progress-tool" title={progress.lastTool}>
              Tool: <span className="mono">{progress.lastTool}</span>
            </div>
          )}

          {recentFiles.length > 0 && (
            <div className="progress-recent">
              {recentFiles.map((file) => {
                const name = file.split(/[\\/]/).pop() || file;
                return (
                  <span key={file} className="file-chip" title={file}>
                    {name}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* History items */}
      {filteredHistory.length === 0 && !isProcessing ? (
        <div className="empty-state" style={{ padding: '20px' }}>
          <div className="empty-state-text">
            {searchText
              ? 'No codemaps match your search'
              : 'No saved codemaps yet. Generate one above!'}
          </div>
        </div>
      ) : (
        filteredHistory.map((item) => (
          <div
            key={item.id}
            className={`codemap-item ${isCurrentCodemap(item) ? 'active' : ''}`}
            onClick={() => onLoadHistory(item.id)}
          >
            <div className="codemap-item-header">
              <span className="codemap-item-title">
                {item.isUnread && (
                  <Circle size={8} className="unread-indicator" fill="currentColor" />
                )}
                {item.codemap.title}
              </span>
              <div className="codemap-item-actions">
                <button
                  className="icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRegenerateFromScratch(item);
                  }}
                  title="Regenerate from scratch (fill query)"
                  disabled={isProcessing}
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  className="icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteHistory(item.id);
                  }}
                  title="Delete codemap"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <div className="codemap-item-desc">
              {item.codemap.description.length > 100
                ? `${item.codemap.description.slice(0, 100)}...`
                : item.codemap.description}
            </div>
            <div className="codemap-item-time">{formatTime(item.timestamp)}</div>
            {item.codemap.metadata?.totalTokens !== undefined && (
              <div className="codemap-item-meta" title={buildMetaTitle(item)}>
                {item.codemap.metadata.totalTokens.toLocaleString()} tokens
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
};

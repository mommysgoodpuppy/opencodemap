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

  const isCurrentCodemap = (item: CodemapHistoryItem) => {
    return currentCodemap && currentCodemap.title === item.codemap.title;
  };

  // Calculate progress percentage
  const progressPercent = progress
    ? Math.round((progress.completedStages / progress.totalStages) * 100)
    : 0;

  // Get current active agent label
  const currentAgentLabel = progress?.activeAgents[activeAgentIndex]?.label || progress?.currentPhase || 'Processing...';

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
        <div className="codemap-item processing-item">
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
            <span className="status-dot" />
            <span className="status-text">{currentAgentLabel}</span>
          </div>
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
          </div>
        ))
      )}
    </div>
  );
};

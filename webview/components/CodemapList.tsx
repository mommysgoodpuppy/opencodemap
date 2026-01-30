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
  const [tick, setTick] = useState(() => Date.now());
  const [completionHoldUntil, setCompletionHoldUntil] = useState(0);
  const [lastProgressSnapshot, setLastProgressSnapshot] = useState<ProgressState | undefined>(undefined);

  const ScrambleText: React.FC<{ text: string; active?: boolean; className?: string }> = ({
    text,
    active = false,
    className,
  }) => {
    const [display, setDisplay] = useState(text);

    useEffect(() => {
      if (!active) {
        setDisplay(text);
        return;
      }
      const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      const durationMs = 1400;
      const delayMs = 1200;
      const start = Date.now();
      const interval = setInterval(() => {
        const now = Date.now();
        if (now - start < delayMs) {
          setDisplay('');
          return;
        }
        const elapsed = now - start - delayMs;
        const progress = Math.min(1, elapsed / durationMs);
        const revealCount = Math.min(text.length, Math.max(1, Math.floor(text.length * progress)));
        let next = '';
        for (let i = 0; i < text.length; i++) {
          if (i < revealCount - 1) {
            next += text[i];
          } else if (i === revealCount - 1) {
            const rand = Math.floor(Math.random() * charset.length);
            next += charset[rand];
          }
        }
        setDisplay(next);
        if (progress >= 1) {
          clearInterval(interval);
          setDisplay(text);
        }
      }, 40);
      return () => clearInterval(interval);
    }, [text, active]);

    return <span className={className}>{display}</span>;
  };

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

  useEffect(() => {
    if (!isProcessing) {
      return;
    }
    const interval = setInterval(() => {
      setTick(Date.now());
    }, 500);
    return () => clearInterval(interval);
  }, [isProcessing]);

  const filteredHistory = useMemo(() => {
    if (!searchText.trim()) {
      return history;
    }
    const lower = searchText.toLowerCase();
    return history.filter(
      (item) =>
        (item.codemap.title || '').toLowerCase().includes(lower) ||
        (item.codemap.description || '').toLowerCase().includes(lower)
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
  const progressComplete = progressPercent >= 100;
  const showCompletion = !isProcessing && Date.now() < completionHoldUntil && lastProgressSnapshot;
  const displayProgress = showCompletion ? lastProgressSnapshot : progress;
  const displayPercent = displayProgress
    ? Math.round((displayProgress.completedStages / displayProgress.totalStages) * 100)
    : 0;
  const displayComplete = displayPercent >= 100;

  // Get current active agent label
  const currentAgentLabel = progress?.activeAgents[activeAgentIndex]?.label || progress?.currentPhase || 'Processing...';
  const lastFileName = progress?.lastFile ? progress.lastFile.split(/[\\/]/).pop() : '';
  const recentFiles = progress?.recentFiles || [];
  const tpsMax = 1000;
  const tpsFireThreshold = 100;
  const tpsBoostThreshold = 200;
  const tps = useMemo(() => {
    if (!progress?.tokenSamples || progress.tokenSamples.length === 0) return 0;
    const windowMs = 2000;
    const cutoff = tick - windowMs;
    const samples = progress.tokenSamples.filter((s) => s.time >= cutoff);
    if (samples.length === 0) return 0;
    const tokensInWindow = samples.reduce((sum, s) => sum + s.tokens, 0);
    const earliest = Math.min(...samples.map((s) => s.time));
    const windowSeconds = Math.max(0.5, (tick - earliest) / 1000);
    return tokensInWindow / windowSeconds;
  }, [progress?.tokenSamples, tick]);
  const tpsClamped = Math.min(tpsMax, Math.max(0, tps));
  const tpsAngle = -90 + (tpsClamped / tpsMax) * 180;
  const isStage1 = progress?.stageNumber === 1;
  const showTps = Boolean(!isStage1 && progress?.totalTokens !== undefined && progress.totalTokens > 0);
  const showFire = Boolean(!isStage1 && (progress?.parallelToolsActive || tps >= tpsFireThreshold) && isProcessing);
  const tpsBoost = Boolean(tps >= tpsBoostThreshold);
  const fireIntensity = Math.min(1, Math.max(0, tpsClamped / tpsMax));
  const fireRedness = Math.min(1, Math.pow(fireIntensity, 0.6));

  useEffect(() => {
    if (!isProcessing && progressComplete && progress) {
      const now = Date.now();
      setLastProgressSnapshot({ ...progress, completedStages: progress.totalStages });
      setCompletionHoldUntil(now + 1200);
    }
  }, [isProcessing, progressComplete, progress]);

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
      {(isProcessing || showCompletion) && (
        <div
          className={`codemap-item processing-item ${showFire ? 'parallel-fire' : ''} ${
            tpsBoost ? 'tps-boost' : ''
          }`}
          style={{
            ...(showFire ? {
              ['--fire-intensity' as any]: fireIntensity.toFixed(2),
              ['--fire-redness' as any]: fireRedness.toFixed(2),
            } : {}),
          }}
        >
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
                className={`progress-fill${displayComplete ? ' progress-complete' : ''}`}
                style={{ width: `${displayPercent}%` }}
              />
            </div>
            <span className="progress-text">{displayPercent}%</span>
          </div>

          {/* Rotating status text */}
          <div className="progress-status">
            <div className="status-main">
              <span className="status-dot" />
              <span className="status-text">{currentAgentLabel}</span>
            </div>

            <div className="status-activity">
              {displayProgress?.totalToolCalls !== undefined && displayProgress.totalToolCalls > 0 && (
                <div className="tool-indicator" title="Tools used">
                  <RefreshCw size={10} className="spinning" />
                  <span>{displayProgress.totalToolCalls}</span>
                </div>
              )}

              {showTps && (
                <div className="tps-indicator" title="Tokens per second">
                  <div className="tps-gauge">
                    <span className="tps-needle" style={{ transform: `translateX(-50%) rotate(${tpsAngle}deg)` }} />
                    <span className="tps-center" />
                  </div>
                  <span className="tps-value">{Math.round(tpsClamped)} tps</span>
                </div>
              )}

              {displayProgress?.totalTokens !== undefined && displayProgress.totalTokens > 0 && (
                <div className="token-counter">
                  <div className="token-stream">
                    <div className={`token-particle ${displayProgress.totalTokens % 3 === 0 ? 'active' : ''}`} />
                    <div className={`token-particle ${displayProgress.totalTokens % 3 === 1 ? 'active' : ''}`} />
                    <div className={`token-particle ${displayProgress.totalTokens % 3 === 2 ? 'active' : ''}`} />
                  </div>
                  <span>{displayProgress.totalTokens.toLocaleString()} tokens</span>
                </div>
              )}
            </div>
          </div>

          <div className="progress-meta">
            {displayProgress?.stageNumber !== undefined && (
              <div className="meta-chip" title="Current stage">
                <span className="meta-label">Stage</span>
                <span className="meta-value">{displayProgress.stageNumber}</span>
              </div>
            )}
            {displayProgress?.filesRead !== undefined && displayProgress.filesRead > 0 && (
              <div className="meta-chip" title="Files read">
                <span className="meta-label">Files</span>
                <span className="meta-value">{displayProgress.filesRead}</span>
              </div>
            )}
            {displayProgress?.linesRead !== undefined && displayProgress.linesRead > 0 && (
              <div className="meta-chip" title="Lines read">
                <span className="meta-label">Lines</span>
                <span className="meta-value">{displayProgress.linesRead.toLocaleString()}</span>
              </div>
            )}
            {displayProgress?.toolBreakdown && (displayProgress.toolBreakdown.internal + displayProgress.toolBreakdown.vscode) > 0 && (
              <div className="meta-chip" title="Tools used (internal / VS Code)">
                <span className="meta-label">Tools</span>
                <span className="meta-value">
                  {displayProgress.toolBreakdown.internal}/{displayProgress.toolBreakdown.vscode}
                </span>
              </div>
            )}
          </div>

          {displayProgress?.lastFile && (
            <div className="progress-file" title={displayProgress.lastFile}>
              Reading: <span className="mono">{lastFileName || displayProgress.lastFile}</span>
            </div>
          )}

          {displayProgress?.lastTool && (
            <div className="progress-tool" title={displayProgress.lastTool}>
              Tool: <span className="mono">{displayProgress.lastTool}</span>
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
            className={`codemap-item ${isCurrentCodemap(item) ? 'active' : ''} ${item.isUnread ? 'unread' : ''}`}
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
              <ScrambleText
                text={(item.codemap.description || '').length > 100
                  ? `${(item.codemap.description || '').slice(0, 100)}...`
                  : (item.codemap.description || '')}
                active={Boolean(item.isUnread)}
              />
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

/**
 * ContextSummaryRow — compact context panel below the Trajectory toolbar.
 * Shows context usage, token breakdown, and session stats.
 * @module @hydra/dsh-fleet-ui-overrides/client
 */

import { memo } from 'react'
import { formatTokens, formatDuration } from './FleetStatsLine.tsx'
import css from './ContextPanel.module.css'

/** Whole-log billed usage share. */
export interface TrajectoryUsageShare {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
}

/** Approximate context occupancy share. */
export interface TrajectoryPressureShare {
  projectedTokens?: number
  contextWindow?: number
}

/** Context breakdown (system/tools/messages). */
export interface TrajectoryBreakdownShare {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

/** Session stats (turns/steps/time). */
export interface TrajectoryStatsShare {
  turns: number
  steps: number
  llmMs: number
}

/** Props from the trajectory owner's summary share. */
export interface ContextSummaryRowProps {
  usage?: TrajectoryUsageShare
  pressure?: TrajectoryPressureShare
  breakdown?: TrajectoryBreakdownShare
  stats?: TrajectoryStatsShare
}

export const ContextSummaryRow = memo(function ContextSummaryRow(
  { usage, pressure, breakdown, stats }: ContextSummaryRowProps,
) {
  const used = pressure?.projectedTokens
  const windowSize = pressure?.contextWindow
  const billedInput = usage?.inputTokens ?? 0
  const cacheRead = usage?.cacheReadTokens ?? 0
  const output = usage?.outputTokens ?? 0

  if (used === undefined && windowSize === undefined && billedInput <= 0 && output <= 0) return null

  const percent = (used !== undefined && windowSize !== undefined)
    ? Math.min(100, Math.round(used / windowSize * 100))
    : null

  // Breakdown bar: each segment is proportional to its share of context used
  const breakdownTotal = breakdown === undefined
    ? 0
    : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
  const hasBreakdown = breakdown !== undefined && breakdownTotal > 0 && used !== undefined

  return (
    <div className={css.contextPanel} data-trajectory-context-summary>
      {/* Header: Context 11% — 22.4K / 200K */}
      <div className={css.contextHeader}>
        <span className={css.contextLabel}>Context</span>
        {percent !== null && <span className={css.contextPercent}>{percent}%</span>}
        {used !== undefined && windowSize !== undefined && (
          <span className={css.contextFigures}>{formatTokens(used)} / {formatTokens(windowSize)}</span>
        )}
      </div>

      {/* Breakdown bar */}
      {hasBreakdown && (
        <div className={css.contextBar}>
          <div
            className={`${css.contextSegment} ${css.colorSystem}`}
            style={{ width: `${used! > 0 ? breakdown!.systemTokens / used! * 100 : 0}%` }}
          />
          <div
            className={`${css.contextSegment} ${css.colorTools}`}
            style={{ width: `${used! > 0 ? breakdown!.toolsTokens / used! * 100 : 0}%` }}
          />
          <div
            className={`${css.contextSegment} ${css.colorMessages}`}
            style={{ width: `${used! > 0 ? breakdown!.messageTokens / used! * 100 : 0}%` }}
          />
        </div>
      )}

      {/* Token rows — compact inline layout */}
      <div className={css.contextRows}>
        {billedInput > 0 && (
          <div className={css.contextRow}>
            <span className={css.contextDot} />
            <span>Input</span>
            <span className={css.contextValue}>
              {formatTokens(billedInput)}
              {cacheRead > 0 && <span className={css.contextCache}> ({formatTokens(cacheRead)} cached)</span>}
            </span>
          </div>
        )}
        {output > 0 && (
          <div className={css.contextRow}>
            <span className={css.contextDot} />
            <span>Output</span>
            <span className={css.contextValue}>{formatTokens(output)}</span>
          </div>
        )}
        {hasBreakdown && (
          <>
            <div className={css.contextRow}>
              <span className={`${css.contextDot} ${css.colorSystem}`} />
              <span>System prompt</span>
              <span className={css.contextValue}>~{formatTokens(breakdown!.systemTokens)}</span>
            </div>
            <div className={css.contextRow}>
              <span className={`${css.contextDot} ${css.colorTools}`} />
              <span>Tools</span>
              <span className={css.contextValue}>~{formatTokens(breakdown!.toolsTokens)}</span>
            </div>
            <div className={css.contextRow}>
              <span className={`${css.contextDot} ${css.colorMessages}`} />
              <span>Messages</span>
              <span className={css.contextValue}>~{formatTokens(breakdown!.messageTokens)}</span>
            </div>
          </>
        )}
      </div>

      {/* Stats footer */}
      {stats !== undefined && (
        <div className={css.contextFooter}>
          <span>{stats.turns} {stats.turns === 1 ? 'turn' : 'turns'} · {stats.steps} {stats.steps === 1 ? 'step' : 'steps'}</span>
          {stats.llmMs > 0 && <span>LLM {formatDuration(stats.llmMs)}</span>}
        </div>
      )}
    </div>
  )
})

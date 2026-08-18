/**
 * Trajectory context summary slot declaration.
 * This file exists to keep the slot declaration isolated for easy upstream merge.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'

/** Owner-supplied props of the trajectory context summary hole: whole-log billed
 * usage and approximate context occupancy, supplied by the TrajectoryView at its
 * renderSlot call site. */
export interface TrajectoryContextSummaryOwnerProps {
  usage?: {
    inputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    outputTokens?: number
  }
  pressure?: {
    projectedTokens?: number
    contextWindow?: number
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Session-scope list hole at the top of the trajectory view: registered
     * entries render a contextual summary of the trajectory's token usage and
     * context occupancy. The owner (TrajectoryView) passes the usage and
     * pressure shares read from the session projection kit.
     */
    'trajectory.context.summary': {
      kind: 'list'
      scope: 'session'
      owner: TrajectoryContextSummaryOwnerProps
    }
  }
}

/**
 * Structural twins of the dsh-token-meter projections (the real declared types
 * live in that package; ui-trajectory deliberately does not depend on it, so
 * the reads below are typed against these local faces). Field presence mirrors
 * the originals: usage fields are all required once the projection exists,
 * pressure fields are individually optional.
 */
interface TokenUsageProjectionFace {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface ContextPressureProjectionFace {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

/**
 * Read the trajectory context summary the TrajectoryView renders: the durable
 * token-usage and context-pressure session projections through the standard
 * `useProjection` seat. Both keys exist at runtime whenever the token-meter
 * plugin is installed; each reads `undefined` otherwise, and the returned share
 * then omits the absent side. Accepts an absent seat (test harnesses without
 * the standard kit) and yields an empty share.
 */
export function readTrajectoryContextSummary(
  useProjection: UseProjection | undefined,
): TrajectoryContextSummaryOwnerProps {
  if (useProjection === undefined) return {}
  // The projection-key type table (dsh-token-meter) is deliberately not a
  // dependency; widening the seat to any key keeps the runtime reads typed
  // against the local faces without importing it.
  const read: (key: string) => unknown = useProjection
  const usage = read('tokenUsage') as TokenUsageProjectionFace | undefined
  const pressure = read('contextPressure') as ContextPressureProjectionFace | undefined
  return {
    ...(usage === undefined
      ? {}
      : {
        usage: {
          inputTokens: usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          outputTokens: usage.outputTokens,
        },
      }),
    ...(pressure === undefined
      ? {}
      : {
        pressure: {
          ...(pressure.projectedTokens === undefined && pressure.pressureTokens === undefined
            ? {}
            : { projectedTokens: pressure.projectedTokens ?? pressure.pressureTokens }),
          ...(pressure.contextWindow === undefined ? {} : { contextWindow: pressure.contextWindow }),
        },
      }),
  }
}

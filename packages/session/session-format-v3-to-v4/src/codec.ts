/** V4 framing with native tool-role admission and released physical rows. */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCodec, SessionFormatCurrentEncoder, SessionFormatHeader, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertV4SourceRowAdmission } from './message-sources.ts'
import { assertV4RetiredSyntax } from './retired-syntax.ts'
import { assertV4SystemMessageFields } from './system-message.ts'
import { assertV4DeveloperData } from './developer.ts'
import { assertV4ForkResult } from './fork-result.ts'
import { assertV4ToolResultMessage } from './tool-role.ts'
import { assertReleasedV4Header } from './validation.ts'

function physicalV2(value: unknown): SessionFormatHeader {
  if (!isSessionFormatJsonObject(value) || value['version'] !== 4) throw new SessionFormatError('expected format v4 physical header')
  return { ...value, version: 2 } as SessionFormatHeader
}

/**
 * Split the v4-only additive header field out of a physical (or logical)
 * value before it reaches the released v2 framing, whose key set is pinned
 * to its release and must tolerate no foreign field. The caller re-adds the
 * field on its own returned object.
 */
function stripExternalOwner<T extends object>(value: T): { stripped: T; externalOwner: unknown } {
  if (!('externalOwner' in value)) return { stripped: value, externalOwner: undefined }
  const { externalOwner, ...stripped } = value
  return { stripped: stripped as T, externalOwner }
}

/** Re-attach the optional v4-only header field after a released framing call. */
function withExternalOwner<Header extends object>(header: Header, externalOwner: unknown): Header {
  return externalOwner === undefined
    ? header
    : { ...header, externalOwner }
}

/**
 * V4 physical encoder and decoder retain the released row framing while
 * validating the native tool-role message directly.
 */
export const releasedV4SessionFormatCodec = Object.freeze({
  version: 4,
  decodeHeader(value: unknown) {
    const { stripped, externalOwner } = stripExternalOwner(physicalV2(value))
    return { ...withExternalOwner(releasedV2SessionFormatCodec.decodeHeader(stripped), externalOwner), version: 4 }
  },
  createDecoder(value, recovery) {
    const { stripped, externalOwner } = stripExternalOwner(physicalV2(value))
    const decoder = releasedV2SessionFormatCodec.createDecoder(stripped, recovery)
    const header = { ...withExternalOwner(decoder.header, externalOwner), version: 4 }
    return {
      ...decoder,
      header,
      decodeRow(row, context) {
        assertV4RowAdmission(row)
        decoder.decodeRow(row, {
          emitRun: context.emitRun.bind(context),
          emitEvent: context.emitEvent.bind(context),
        })
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV4Header(header)
    const { stripped, externalOwner } = stripExternalOwner({ ...header, version: 2 })
    const encoded = releasedV2SessionFormatCodec.encodeHeader(stripped as SessionFormatHeader, inheritedEventCount)
    return { ...withExternalOwner(encoded, externalOwner), version: 4 }
  },
  encodeEvent(event: SessionFormatEvent) {
    if (event.type === 'developer/message' && event['ignorable'] === true) {
      assertV4DeveloperData(event)
      assertV4RetiredSyntax(event)
    }
    assertV4RowAdmission(event)
    return releasedV2SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Apply native V4 admission before a scanner discards a recoverable suffix.
 * Ignorable developer payloads require reader vocabulary; physical decoding defers them.
 * @param row - parsed physical row before framing and source-event range decoding.
 * @param knownEventTypes - installed event types, supplied by native readers before tail recovery.
 */
export function assertV4RowAdmission(row: unknown, knownEventTypes?: ReadonlySet<string>): void {
  if (isSessionFormatJsonObject(row)) {
    if (row['type'] === 'developer/message' && row['ignorable'] === true
      && knownEventTypes?.has('developer/message') !== true) return
    assertV4DeveloperData(row as unknown as SessionFormatEvent)
  }
  assertV4SourceRowAdmission(row)
  assertV4RetiredSyntax(row)
  assertV4SystemMessageFields(row)
  if (!isSessionFormatJsonObject(row) || row['type'] !== 'tool/result') return
  const event = row as unknown as SessionFormatEvent
  assertV4ToolResultMessage(event)
  assertV4ForkResult(event)
}

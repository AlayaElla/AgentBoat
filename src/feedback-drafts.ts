import type { Attention, LiveAgent } from './model'
import type { DelegatedFeedback } from './links'

export type Draft = { reviewTotal?: number; taskId: string; kind: 'acceptance' | 'decision'; itemId: string; itemRevision?: number; fingerprint?: string; signature: string; title: string; result?: string; answer?: string; note?: string }
export type InboxRow = { id: string; title: string; projectId?: string; taskId?: string; kind: Attention['kind'] | 'agent'; count?: number; agent?: LiveAgent }
export type Attempt = { signature: string; input?: DelegatedFeedback; rows?: InboxRow[]; reason?: string; rejected?: boolean; checkingUntil?: number; autoChecked?: boolean }
export const feedbackFailure = (a?: Attempt) => a?.reason && JSON.stringify([a.input?.requestId ?? a.signature, !!a.rejected, a.rejected ? a.reason : ''])
type Sheet = { entries: Record<string, Draft>; attempt?: Attempt; dismissed?: string; versions: Record<string, number>; floor: number }
export type Sheets = Record<string, Sheet>
export type Delta = { projectId: string; exact?: boolean; items: { key: string; version: number; value?: Draft | null }[]; attempt?: { version: number; value: Attempt | null }; dismiss?: string }
export const emptySheet = (): Sheet => ({ entries: {}, versions: {}, floor: 0 })
export const versionOf = (sheet: Sheet, key: string) => sheet.versions[key] ?? sheet.floor
export function applyDelta(sheets: Sheets, change: Delta) {
  const { projectId, items, attempt } = change
  if (typeof projectId !== 'string' || !projectId || Object.hasOwn(Object.prototype, projectId) || !Array.isArray(items)) throw Error('草稿格式不正确')
  const sheet = sheets[projectId] ?? emptySheet()
  const check = (key: string, version: number) => {
    if (version !== versionOf(sheet, key)) throw Error('选择已在另一个面板更新，请刷新后核对')
  }
  if (new Set(items.map(item => item.key)).size !== items.length) throw Error('草稿编号重复')
  if (change.exact && (items.length !== Object.keys(sheet.entries).length || items.some(item => !Object.hasOwn(sheet.entries, item.key)))) throw Error('选择已在另一个面板更新，请刷新后核对')
  for (const item of items) {
    if (typeof item.key !== 'string' || !item.key.startsWith('[')) throw Error('草稿编号不正确')
    check(item.key, item.version)
  }
  if (!attempt && sheet.attempt?.input && !sheet.attempt.rejected && items.some(item => item.value !== undefined)) throw Error('上次提交还没确认，请先重试核对')
  if (attempt) check('attempt', attempt.version)
  sheets[projectId] = sheet
  for (const { key, value } of items) if (value !== undefined) {
    if (value === null) delete sheet.entries[key]
    else sheet.entries[key] = value
    sheet.versions[key] = versionOf(sheet, key) + 1
  }
  if (attempt) {
    if (attempt.value === null) delete sheet.attempt
    else sheet.attempt = attempt.value
    if (!sheet.attempt || sheet.dismissed !== feedbackFailure(sheet.attempt)) delete sheet.dismissed
    sheet.versions.attempt = attempt.version + 1
  }
  if (change.dismiss && change.dismiss === feedbackFailure(sheet.attempt)) sheet.dismissed = change.dismiss
  if (!sheet.attempt && !Object.keys(sheet.entries).length && (attempt || Object.keys(sheet.versions).length > 64)) {
    sheet.floor = Math.max(sheet.floor, ...Object.values(sheet.versions)) + 1
    sheet.versions = {}
  }
}

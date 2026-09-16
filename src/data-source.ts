import type { AppSettings, CalendarEntry, Tag } from './types'
import { createId, toDateKey, TAG_COLORS } from './types'
import {
  archiveNotionPage,
  pullNotionEntries,
  pushNotionEntries,
} from './notion'
import type { NotionEntryInput, NotionEntryRecord } from './notion'

export type MonthLoadResult = {
  entries: CalendarEntry[]
  newTags: Tag[]
}

export type TagDateSummary = {
  date: string
  title: string
}

/**
 * 日历数据源接口：读取按月/按标签查询，写入单条记录。
 * 本地实现走 localStorage；远程实现（如 Notion）负责分页、筛选与引用管理，
 * UI 层不感知数据源差异。
 */
export interface CalendarDataSource {
  readonly kind: 'local' | 'notion'
  /** 加载指定月份（含前后跨月占位）的记录 */
  loadMonth(year: number, month: number): Promise<MonthLoadResult>
  /** 查询带指定标签的记录摘要（跨月份），用于快捷入口 */
  queryTagDates(tagName: string): Promise<TagDateSummary[]>
  /** 保存（创建或更新）一条记录，返回带远端引用的结果 */
  saveEntry(entry: CalendarEntry, tags: Tag[]): Promise<CalendarEntry>
  /** 删除一条记录（远端模式归档远端页面） */
  deleteEntry(entry: CalendarEntry): Promise<void>
}

function monthRange(year: number, month: number): { start: string; end: string } {
  const start = new Date(year, month, 1)
  const end = new Date(year, month + 1, 1)
  return { start: toDateKey(start), end: toDateKey(end) }
}

export function toNotionEntryInput(entry: CalendarEntry, tags: Tag[], dataSourceId?: string) {
  const tagNames = new Map(tags.map((tag) => [tag.id, tag.name]))
  const remoteId = entry.remote?.provider === 'notion'
    && (!dataSourceId || entry.remote.dataSourceId === dataSourceId)
    ? entry.remote.id
    : undefined
  const input: NotionEntryInput = {
    localId: entry.id,
    remoteId,
    date: entry.date,
    title: entry.title,
    content: entry.content,
    tagNames: entry.tagIds
      .map((tagId) => tagNames.get(tagId))
      .filter((name): name is string => Boolean(name)),
    mood: entry.mood,
    attachments: entry.attachments,
  }
  return input
}

export function mergeNotionRecords(
  records: NotionEntryRecord[],
  currentEntries: CalendarEntry[],
  currentTags: Tag[],
): MonthLoadResult {
  const nextEntries = [...currentEntries]
  const nextTags = [...currentTags]
  const tagByName = new Map(nextTags.map((tag) => [tag.name.toLowerCase(), tag]))
  const syncedAt = new Date().toISOString()

  for (const record of records) {
    const tagIds = record.tagNames.map((name) => {
      const cleanName = name.trim()
      if (!cleanName) return undefined
      const key = cleanName.toLowerCase()
      const existing = tagByName.get(key)
      if (existing) return existing.id
      const tag: Tag = { id: createId('tag'), name: cleanName, color: TAG_COLORS[nextTags.length % TAG_COLORS.length] }
      nextTags.push(tag)
      tagByName.set(key, tag)
      return tag.id
    }).filter((tagId): tagId is string => Boolean(tagId))
    const attachments = record.attachments.map((attachment, index) => ({
      id: attachment.remoteId ?? `notion-${record.remoteId}-${index}`,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      dataUrl: '',
      sourceUrl: attachment.sourceUrl,
      remoteId: attachment.remoteId,
      remoteFile: attachment.remoteFile,
    }))
    const existingIndex = nextEntries.findIndex((entry) => entry.remote?.provider === 'notion' && entry.remote.id === record.remoteId)
    const previous = existingIndex >= 0 ? nextEntries[existingIndex] : undefined
    const merged: CalendarEntry = {
      id: previous?.id ?? createId('entry'),
      date: record.date,
      title: record.title,
      content: record.content,
      tagIds,
      mood: record.mood,
      attachments,
      updatedAt: record.updatedAt || syncedAt,
      remote: { provider: 'notion', id: record.remoteId, dataSourceId: record.dataSourceId, lastSyncedAt: syncedAt },
    }
    if (existingIndex >= 0) nextEntries[existingIndex] = merged
    else nextEntries.push(merged)
  }

  return { entries: nextEntries, newTags: nextTags }
}

/**
 * 本地数据源：数据全量驻留在 App 内存 state 中（由 localStorage effect 持久化），
 * 因此读取/写入是直通实现；接口形态与远程数据源保持一致。
 */
export function createLocalDataSource(): CalendarDataSource {
  return {
    kind: 'local',
    async loadMonth(year, month) {
      void year
      void month
      return { entries: [], newTags: [] }
    },
    async queryTagDates(tagName) {
      void tagName
      return []
    },
    async saveEntry(entry) {
      return entry
    },
    async deleteEntry(entry) {
      void entry
    },
  }
}

export function createNotionDataSource(
  readSettings: () => AppSettings,
): CalendarDataSource {
  async function target() {
    const settings = readSettings()
    const dataset = settings.notionDatasets.find(
      (item) => `${item.databaseId}:${item.dataSourceId}` === `${settings.notionDatabaseId}:${settings.notionDataSourceId}`,
    ) ?? settings.notionDatasets.find((item) => item.databaseId === settings.notionDatabaseId)
    ?? (settings.notionDatabaseId.trim() ? undefined : settings.notionDatasets[0])
    const databaseId = dataset?.databaseId ?? settings.notionDatabaseId.trim()
    const dataSourceId = dataset?.dataSourceId ?? settings.notionDataSourceId.trim()
    if (!settings.notionToken.trim() || !databaseId) {
      throw new Error('请先在设置中配置 Notion Token 并添加数据集')
    }
    return { token: settings.notionToken, databaseId, dataSourceId }
  }

  return {
    kind: 'notion',
    async loadMonth(year, month) {
      const { token, databaseId, dataSourceId } = await target()
      const { start, end } = monthRange(year, month)
      const result = await pullNotionEntries(token, databaseId, dataSourceId || undefined, {
        dateStart: start,
        dateEnd: end,
      })
      return mergeNotionRecords(result.entries, [], [])
    },
    async queryTagDates(tagName) {
      const { token, databaseId, dataSourceId } = await target()
      const result = await pullNotionEntries(token, databaseId, dataSourceId || undefined, { tag: tagName })
      return result.entries
        .map((entry) => ({ date: entry.date, title: entry.title || '未命名记录' }))
        .sort((a, b) => b.date.localeCompare(a.date))
    },
    async saveEntry(entry, tags) {
      const { token, databaseId, dataSourceId } = await target()
      const result = await pushNotionEntries(
        token,
        databaseId,
        dataSourceId || undefined,
        [toNotionEntryInput(entry, tags, dataSourceId || undefined)],
      )
      const pushed = result.entries.find((item) => item.localId === entry.id)
      if (!pushed) return entry
      const attachments = entry.attachments.map((attachment, index) => {
        const reference = pushed.attachments?.[index]
        if (!reference || reference.name !== attachment.name) return attachment
        return {
          ...attachment,
          sourceUrl: reference.sourceUrl ?? attachment.sourceUrl,
          remoteId: reference.remoteId ?? attachment.remoteId,
          remoteFile: reference.remoteFile ?? attachment.remoteFile,
        }
      })
      return {
        ...entry,
        attachments,
        updatedAt: pushed.updatedAt || entry.updatedAt,
        remote: {
          provider: 'notion' as const,
          id: pushed.remoteId,
          dataSourceId: pushed.dataSourceId,
          lastSyncedAt: new Date().toISOString(),
        },
      }
    },
    async deleteEntry(entry) {
      if (entry.remote?.provider !== 'notion') return
      const { token } = await target()
      await archiveNotionPage(token, entry.remote.id)
    },
  }
}

import type { AppSettings, CalendarEntry, Tag } from './types'
import { createId, toDateKey, TAG_COLORS } from './types'
import {
  archiveNotionPage,
  pullNotionEntries,
  pushNotionEntries,
} from './notion'
import type { NotionEntryInput, NotionEntryRecord } from './notion'
import {
  deleteQiniuObject,
  getQiniuAttachmentDataUrl,
  getQiniuObjects,
  listQiniuKeys,
  putQiniuObject,
  signQiniuDownloadUrls,
} from './qiniu'
import type { QiniuDayDocument, QiniuTagIndex } from './qiniu'

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
  readonly kind: 'local' | 'notion' | 'qiniu'
  /** 加载指定月份（含前后跨月占位）的记录 */
  loadMonth(year: number, month: number, knownTags: Tag[]): Promise<MonthLoadResult>
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
    async loadMonth(year, month, knownTags) {
      void year
      void month
      void knownTags
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
    async loadMonth(year, month, knownTags) {
      const { token, databaseId, dataSourceId } = await target()
      const { start, end } = monthRange(year, month)
      const result = await pullNotionEntries(token, databaseId, dataSourceId || undefined, {
        dateStart: start,
        dateEnd: end,
      })
      // 复用已知标签的 id：否则每次加载生成新 id，旧标签列表与新记录脱节导致标签“消失”
      return mergeNotionRecords(result.entries, [], knownTags)
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

type QiniuTarget = {
  token: string
  bucket: string
  region: string
  domain: string
  prefix: string
}

/**
 * 七牛 Kodo 数据源目录设计：
 * - `{prefix}/date/{YYYY-MM-DD}.json`：当天全部记录的文档，保存只写一个对象，无跨设备读改写竞态；
 * - `{prefix}/files/{file_id}`：附件原始内容，MIME/大小等元数据放在日期文档里；
 * - `{prefix}/tags/{encoded_tag}/{YYYY-MM-DD}.json`：标签 → 日期的倒排索引，快捷入口只列前缀即可跨月查询；
 * - `{prefix}/meta/tags.json`：标签定义（颜色/停用态），换设备不丢。
 */
export function qiniuDayKey(prefix: string, date: string): string {
  return `${prefix}/date/${date}.json`
}

export function qiniuFileKey(prefix: string, fileId: string, fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const extension = dot > 0 ? fileName.slice(dot).toLowerCase() : ''
  return `${prefix}/files/${fileId}${extension}`
}

export function qiniuTagIndexKey(prefix: string, tagName: string, date: string): string {
  return `${prefix}/tags/${encodeURIComponent(tagName)}/${date}.json`
}

export const QINIU_TAGS_META_KEY = 'meta/tags.json'

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const match = /^data:([^;,]*);base64,(.*)$/s.exec(dataUrl)
  if (!match) return { mimeType: 'application/octet-stream', base64: dataUrl }
  return { mimeType: match[1] || 'application/octet-stream', base64: match[2] }
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary)
}

function toQiniuDayDocument(date: string, dayEntries: CalendarEntry[], tags: Tag[], prefix: string): QiniuDayDocument {
  const nameById = new Map(tags.map((tag) => [tag.id, tag.name]))
  return {
    date,
    entries: dayEntries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      content: entry.content,
      tagNames: entry.tagIds
        .map((tagId) => nameById.get(tagId))
        .filter((name): name is string => Boolean(name)),
      mood: entry.mood,
      updatedAt: entry.updatedAt,
      attachments: entry.attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        key: attachment.remoteId ?? qiniuFileKey(prefix, attachment.id, attachment.name),
        mimeType: attachment.mimeType,
        size: attachment.size,
      })),
    })),
  }
}

export function mergeQiniuDayDocuments(
  documents: QiniuDayDocument[],
  currentTags: Tag[],
): MonthLoadResult {
  const nextTags = [...currentTags]
  const tagByName = new Map(nextTags.map((tag) => [tag.name.toLowerCase(), tag]))
  const ensureTag = (name: string): string => {
    const cleanName = name.trim()
    const key = cleanName.toLowerCase()
    const existing = tagByName.get(key)
    if (existing) return existing.id
    const tag: Tag = {
      id: createId('tag'),
      name: cleanName,
      color: TAG_COLORS[nextTags.length % TAG_COLORS.length],
    }
    nextTags.push(tag)
    tagByName.set(key, tag)
    return tag.id
  }

  const entries: CalendarEntry[] = []
  for (const document of documents) {
    for (const record of document.entries) {
      entries.push({
        id: record.id || createId('entry'),
        date: document.date,
        title: record.title,
        content: record.content,
        tagIds: record.tagNames.map(ensureTag).filter(Boolean),
        mood: record.mood,
        attachments: record.attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          dataUrl: '',
          remoteId: attachment.key,
        })),
        updatedAt: record.updatedAt || new Date().toISOString(),
      })
    }
  }
  return { entries, newTags: nextTags }
}

async function readQiniuObjects(target: QiniuTarget, keys: string[]): Promise<Array<string | null>> {
  if (keys.length === 0) return []
  return getQiniuObjects(target.token, target.bucket, target.region, target.domain, keys)
}

async function readQiniuDayDocument(target: QiniuTarget, date: string): Promise<QiniuDayDocument | null> {
  const [text] = await readQiniuObjects(target, [qiniuDayKey(target.prefix, date)])
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as QiniuDayDocument
    return parsed && parsed.date === date ? parsed : null
  } catch {
    return null
  }
}

async function writeQiniuJson(target: QiniuTarget, key: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2)
  await putQiniuObject(target.token, target.bucket, target.region, key, utf8ToBase64(text), 'application/json')
}

async function syncQiniuTagIndexes(
  target: QiniuTarget,
  date: string,
  previousTagNames: string[],
  dayEntryTags: Array<{ id: string; title: string; tagNames: string[] }>,
): Promise<void> {
  const grouped = new Map<string, string[]>()
  for (const entry of dayEntryTags) {
    for (const name of entry.tagNames) {
      const ids = grouped.get(name) ?? []
      ids.push(entry.id)
      grouped.set(name, ids)
    }
  }
  const allTagNames = Array.from(new Set([...previousTagNames, ...grouped.keys()]))
  for (const tagName of allTagNames) {
    const key = qiniuTagIndexKey(target.prefix, tagName, date)
    const entryIds = grouped.get(tagName) ?? []
    if (entryIds.length === 0) {
      await deleteQiniuObject(target.token, target.bucket, target.region, key)
      continue
    }
    const owningEntry = dayEntryTags.find((item) => item.tagNames.includes(tagName))
    const index: QiniuTagIndex = {
      date,
      title: owningEntry?.title || '未命名记录',
      entryIds,
    }
    await writeQiniuJson(target, key, index)
  }
}

export function createQiniuDataSource(
  readSettings: () => AppSettings,
  readEntries: () => CalendarEntry[],
): CalendarDataSource {
  function target(): QiniuTarget {
    const settings = readSettings()
    const prefix = settings.qiniuPrefix.trim().replace(/^\/+|\/+$/g, '') || 'calendarmark'
    if (!settings.qiniuToken.trim() || !settings.qiniuBucket.trim()) {
      throw new Error('请先在设置中配置七牛 AccessKey:SecretKey 并选择空间')
    }
    return {
      token: settings.qiniuToken,
      bucket: settings.qiniuBucket.trim(),
      region: settings.qiniuRegion.trim() || 'z0',
      domain: settings.qiniuDomain.trim(),
      prefix,
    }
  }

  async function hydrateAttachments(loaded: CalendarEntry[]): Promise<CalendarEntry[]> {
    const attachmentKeys = loaded.flatMap((entry) => entry.attachments.map((a) => a.remoteId).filter((key): key is string => Boolean(key)))
    if (attachmentKeys.length === 0) return loaded
    const sourceUrls = await signQiniuDownloadUrls(target().token, target().domain, attachmentKeys)
    const sourceUrlByKey = new Map(attachmentKeys.map((key, index) => [key, sourceUrls[index]]))
    const dataUrlCache = new Map<string, string>()
    const hydrated: CalendarEntry[] = []
    for (const entry of loaded) {
      const attachments = await Promise.all(entry.attachments.map(async (attachment) => {
        const key = attachment.remoteId
        if (!key) return attachment
        const sourceUrl = sourceUrlByKey.get(key)
        let dataUrl = attachment.dataUrl
        if (!dataUrl && attachment.mimeType.startsWith('image/')) {
          if (!dataUrlCache.has(key)) {
            try {
              const fetched = await getQiniuAttachmentDataUrl(
                target().token, target().bucket, target().region, target().domain, key, attachment.mimeType,
              )
              dataUrlCache.set(key, fetched ?? '')
            } catch {
              dataUrlCache.set(key, '')
            }
          }
          dataUrl = dataUrlCache.get(key) || attachment.dataUrl
        }
        return { ...attachment, dataUrl, sourceUrl }
      }))
      hydrated.push({
        ...entry,
        attachments,
        remote: {
          provider: 'qiniu' as const,
          id: entry.id,
          dataSourceId: target().bucket,
          lastSyncedAt: new Date().toISOString(),
        },
      })
    }
    return hydrated
  }

  return {
    kind: 'qiniu',
    async loadMonth(year, month, knownTags) {
      const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`
      const daysInMonth = new Date(year, month + 1, 0).getDate()
      const keys = Array.from({ length: daysInMonth }, (_, index) => (
        qiniuDayKey(target().prefix, `${monthKey}-${String(index + 1).padStart(2, '0')}`)
      ))
      const documents = await readQiniuObjects(target(), keys)
      const dayDocuments: QiniuDayDocument[] = []
      documents.forEach((text) => {
        if (!text) return
        try {
          const parsed = JSON.parse(text) as QiniuDayDocument
          if (parsed && Array.isArray(parsed.entries) && parsed.entries.length > 0) dayDocuments.push(parsed)
        } catch {
          // 跳过损坏的日期文档，不让单个坏文件阻塞整月加载
        }
      })

      // 合并远端标签定义，保留本地已选颜色
      const [metaText] = await readQiniuObjects(target(), [`${target().prefix}/${QINIU_TAGS_META_KEY}`])
      let mergedTags = [...knownTags]
      if (metaText) {
        try {
          const meta = JSON.parse(metaText) as { tags?: Tag[] }
          for (const remoteTag of meta.tags ?? []) {
            if (!remoteTag?.name) continue
            if (mergedTags.some((tag) => tag.name.toLowerCase() === remoteTag.name.toLowerCase())) continue
            mergedTags = [...mergedTags, remoteTag]
          }
        } catch {
          // 元数据损坏时忽略
        }
      }
      const merged = mergeQiniuDayDocuments(dayDocuments, mergedTags)
      const hydrated = await hydrateAttachments(merged.entries)
      return { entries: hydrated, newTags: merged.newTags }
    },

    async queryTagDates(tagName) {
      const prefix = `${target().prefix}/tags/${encodeURIComponent(tagName)}/`
      const keys = await listQiniuKeys(target().token, target().bucket, target().region, prefix)
      const indexKeys = keys.filter((key) => key.endsWith('.json')).sort((a, b) => b.localeCompare(a)).slice(0, 30)
      const texts = await readQiniuObjects(target(), indexKeys)
      const summaries: TagDateSummary[] = []
      texts.forEach((text) => {
        if (!text) return
        try {
          const index = JSON.parse(text) as QiniuTagIndex
          if (index?.date && (index.entryIds?.length ?? 0) > 0) {
            summaries.push({ date: index.date, title: index.title || '未命名记录' })
          }
        } catch {
          // 跳过损坏索引
        }
      })
      return summaries.sort((a, b) => b.date.localeCompare(a.date))
    },

    async saveEntry(entry, tags) {
      const currentTarget = target()
      const existing = await readQiniuDayDocument(currentTarget, entry.date)
      const previousTagNames = existing
        ? Array.from(new Set(existing.entries.flatMap((record) => record.tagNames)))
        : []

      // 上传尚未入库的附件（有 dataUrl 且还没有远端 key）
      const pendingUploads = entry.attachments.filter((attachment) => attachment.dataUrl && !attachment.remoteId)
      const uploadedKeys = new Map<string, string>()
      for (const attachment of pendingUploads) {
        const key = qiniuFileKey(currentTarget.prefix, attachment.id, attachment.name)
        const { mimeType, base64 } = parseDataUrl(attachment.dataUrl)
        await putQiniuObject(
          currentTarget.token,
          currentTarget.bucket,
          currentTarget.region,
          key,
          base64,
          attachment.mimeType || mimeType,
        )
        uploadedKeys.set(attachment.id, key)
      }
      const savedEntry: CalendarEntry = {
        ...entry,
        attachments: entry.attachments.map((attachment) => {
          if (attachment.remoteId) return attachment
          const key = uploadedKeys.get(attachment.id)
          return key ? { ...attachment, remoteId: key, dataUrl: '' } : attachment
        }),
      }

      // 组装当天完整文档：以内存中的当天记录为准，避免读到旧版本
      const dayEntries = readEntries()
        .filter((item) => item.date === entry.date && item.id !== entry.id)
        .concat(savedEntry)
      const document = toQiniuDayDocument(entry.date, dayEntries, tags, currentTarget.prefix)
      await writeQiniuJson(currentTarget, qiniuDayKey(currentTarget.prefix, entry.date), document)
      const nameById = new Map(tags.map((tag) => [tag.id, tag.name]))
      await syncQiniuTagIndexes(
        currentTarget,
        entry.date,
        previousTagNames,
        dayEntries.map((item) => ({
          id: item.id,
          title: item.title,
          tagNames: item.tagIds.map((tagId) => nameById.get(tagId)).filter((name): name is string => Boolean(name)),
        })),
      )
      await writeQiniuJson(currentTarget, `${currentTarget.prefix}/${QINIU_TAGS_META_KEY}`, {
        tags: tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color, retired: tag.retired ?? false })),
      })

      const sourceUrlByKey = new Map<string, string>()
      const keysForUrls = savedEntry.attachments.map((a) => a.remoteId).filter((key): key is string => Boolean(key))
      if (keysForUrls.length > 0) {
        const urls = await signQiniuDownloadUrls(currentTarget.token, currentTarget.domain, keysForUrls)
        keysForUrls.forEach((key, index) => sourceUrlByKey.set(key, urls[index]))
      }
      return {
        ...savedEntry,
        attachments: savedEntry.attachments.map((attachment) => ({
          ...attachment,
          sourceUrl: attachment.remoteId ? sourceUrlByKey.get(attachment.remoteId) ?? attachment.sourceUrl : attachment.sourceUrl,
        })),
        remote: {
          provider: 'qiniu' as const,
          id: savedEntry.id,
          dataSourceId: currentTarget.bucket,
          lastSyncedAt: new Date().toISOString(),
        },
      }
    },

    async deleteEntry(entry) {
      const currentTarget = target()
      const existing = await readQiniuDayDocument(currentTarget, entry.date)
      if (!existing) return
      const remaining = existing.entries.filter((record) => record.id !== entry.id)
      const previousTagNames = Array.from(new Set(existing.entries.flatMap((record) => record.tagNames)))

      // 删除该记录独享的附件对象
      const removed = existing.entries.find((record) => record.id === entry.id)
      const keptKeys = new Set(remaining.flatMap((record) => record.attachments.map((a) => a.key)))
      if (removed) {
        for (const attachment of removed.attachments) {
          if (!keptKeys.has(attachment.key)) {
            await deleteQiniuObject(currentTarget.token, currentTarget.bucket, currentTarget.region, attachment.key)
          }
        }
      }

      if (remaining.length === 0) {
        await deleteQiniuObject(currentTarget.token, currentTarget.bucket, currentTarget.region, qiniuDayKey(currentTarget.prefix, entry.date))
      } else {
        await writeQiniuJson(currentTarget, qiniuDayKey(currentTarget.prefix, entry.date), { date: entry.date, entries: remaining })
      }

      // 重建标签索引：没有引用的标签索引对象会被删除
      await syncQiniuTagIndexes(currentTarget, entry.date, previousTagNames, remaining.map((record) => ({
        id: record.id,
        title: record.title,
        tagNames: record.tagNames,
      })))
    },
  }
}

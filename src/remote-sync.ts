import type { AppSettings, CalendarEntry, EntryRemoteRef, NotionDataset, Tag } from './types'
import {
  mergeNotionRecords,
  mergeQiniuDayDocuments,
  parseDataUrl,
  QINIU_TAGS_META_KEY,
  qiniuDayKey,
  qiniuFileKey,
  qiniuTagIndexKey,
  readQiniuObjects,
  toNotionEntryInput,
  toQiniuDayDocument,
  utf8ToBase64,
  type QiniuTarget,
} from './data-source'
import { pullNotionEntries, pushNotionEntries } from './notion'
import type { NotionPushResult } from './notion'
import {
  getQiniuAttachmentDataUrl,
  listQiniuKeys,
  putQiniuObjects,
  signQiniuDownloadUrls,
  deleteQiniuObjects,
} from './qiniu'
import type { QiniuDayDocument, QiniuObjectInput, QiniuTagIndex } from './qiniu'

export type RemoteSyncDirection = 'pull' | 'push'

/**
 * 本地储存的手动同步抽象。
 * CalendarDataSource 负责“当前直连数据源”的读写；RemoteSyncTarget 负责把任意已绑定
 * 远程目标与本地记录互相同步。新增远程源时实现 pullToLocal/pushFromLocal 即可进入同一 UI。
 */

export type RemoteSyncPullResult = {
  entries: CalendarEntry[]
  tags: Tag[]
  pulledCount: number
  warnings: string[]
}

export type RemoteSyncPushResult = {
  entries: CalendarEntry[]
  pushedCount: number
  warnings: string[]
}

export type RemoteSyncTarget = {
  id: string
  provider: 'notion' | 'qiniu'
  label: string
  detail: string
  configured: boolean
  active: boolean
  requirement: string
  activate?: () => void
  configure?: () => void
  pullToLocal(currentEntries: CalendarEntry[], currentTags: Tag[]): Promise<RemoteSyncPullResult>
  pushFromLocal(entries: CalendarEntry[], tags: Tag[]): Promise<RemoteSyncPushResult>
}

function qiniuTarget(settings: AppSettings): QiniuTarget {
  return {
    accessKey: settings.qiniuAccessKey.trim(),
    secretKey: settings.qiniuSecretKey.trim(),
    bucket: settings.qiniuBucket.trim(),
    region: settings.qiniuRegion.trim() || 'z0',
    domain: settings.qiniuDomain.trim(),
    prefix: settings.qiniuPrefix.trim().replace(/^\/+|\/+$/g, '') || 'calendarmark',
  }
}

function notionDatasetKey(dataset: Pick<NotionDataset, 'databaseId' | 'dataSourceId'>): string {
  return `${dataset.databaseId}:${dataset.dataSourceId}`
}

function applyNotionPushResult(
  entries: CalendarEntry[],
  result: NotionPushResult,
): CalendarEntry[] {
  return entries.map((entry) => {
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
    const notionRef: EntryRemoteRef = {
      provider: 'notion',
      id: pushed.remoteId,
      dataSourceId: pushed.dataSourceId,
      lastSyncedAt: new Date().toISOString(),
    }
    return {
      ...entry,
      attachments,
      updatedAt: pushed.updatedAt || entry.updatedAt,
      remote: entry.remote ?? notionRef,
      remoteRefs: {
        ...entry.remoteRefs,
        notion: notionRef,
      },
    }
  })
}

function createNotionSyncTarget(
  settings: AppSettings,
  dataset: NotionDataset,
  activate?: () => void,
  configure?: () => void,
): RemoteSyncTarget {
  const id = `notion:${notionDatasetKey(dataset)}`
  const configured = Boolean(settings.notionToken.trim() && dataset.databaseId && dataset.dataSourceId)
  const activeKey = `${settings.notionDatabaseId}:${settings.notionDataSourceId}`
  const firstAvailable = !settings.notionDatabaseId.trim() && (settings.notionDatasets ?? [])[0] === dataset
  return {
    id,
    provider: 'notion',
    label: dataset.databaseTitle || 'Notion 数据集',
    detail: `${dataset.dataSourceName || 'Notion data source'} · 双向同步`,
    configured,
    active: notionDatasetKey(dataset) === activeKey || firstAvailable,
    requirement: '需要 Integration Token，并确认数据集已共享给 Integration',
    activate,
    configure,
    async pullToLocal(currentEntries, currentTags) {
      const result = await pullNotionEntries(settings.notionToken, dataset.databaseId, dataset.dataSourceId)
      const merged = mergeNotionRecords(result.entries, currentEntries, currentTags)
      return {
        entries: merged.entries,
        tags: merged.newTags,
        pulledCount: result.entries.length,
        warnings: result.warnings,
      }
    },
    async pushFromLocal(entries, tags) {
      const result = await pushNotionEntries(
        settings.notionToken,
        dataset.databaseId,
        dataset.dataSourceId,
        entries.map((entry) => toNotionEntryInput(entry, tags, dataset.dataSourceId)),
      )
      return {
        entries: applyNotionPushResult(entries, result),
        pushedCount: result.entries.length,
        warnings: result.warnings,
      }
    },
  }
}

function qiniuAttachmentKey(entry: CalendarEntry, attachment: CalendarEntry['attachments'][number]): string | undefined {
  return attachment.qiniuKey
    ?? (entry.remoteRefs?.qiniu || entry.remote?.provider === 'qiniu' ? attachment.remoteId : undefined)
}

function mergeQiniuEntriesWithLocal(remoteEntries: CalendarEntry[], currentEntries: CalendarEntry[]): CalendarEntry[] {
  const merged = [...currentEntries]
  for (const remoteEntry of remoteEntries) {
    const existingIndex = merged.findIndex((entry) => (
      entry.id === remoteEntry.id
      || entry.remoteRefs?.qiniu?.id === remoteEntry.remoteRefs?.qiniu?.id
      || (entry.remote?.provider === 'qiniu' && entry.remote.id === remoteEntry.remoteRefs?.qiniu?.id)
    ))
    const previous = existingIndex >= 0 ? merged[existingIndex] : undefined
    const attachments = remoteEntry.attachments.map((attachment, index) => {
      const previousAttachment = previous?.attachments.find((item) => item.id === attachment.id)
        ?? previous?.attachments.find((item) => item.name === attachment.name && item.mimeType === attachment.mimeType)
        ?? previous?.attachments[index]
      return {
        ...previousAttachment,
        ...attachment,
        dataUrl: previousAttachment?.dataUrl || attachment.dataUrl,
      }
    })
    const qiniuRef = remoteEntry.remoteRefs?.qiniu
    const next: CalendarEntry = {
      ...previous,
      ...remoteEntry,
      attachments,
      remote: previous?.remote ?? qiniuRef,
      remoteRefs: {
        ...previous?.remoteRefs,
        ...remoteEntry.remoteRefs,
      },
    }
    if (existingIndex >= 0) merged[existingIndex] = next
    else merged.push(next)
  }
  return merged
}

async function readQiniuObjectsChunked(target: QiniuTarget, keys: string[]): Promise<Array<string | null>> {
  const values: Array<string | null> = []
  for (let index = 0; index < keys.length; index += 32) {
    const chunk = keys.slice(index, index + 32)
    values.push(...await readQiniuObjects(target, chunk))
  }
  return values
}

async function listQiniuDayDocuments(target: QiniuTarget, warnings: string[]): Promise<QiniuDayDocument[]> {
  const prefix = `${target.prefix}/date/`
  const keys = await listQiniuKeys(target.accessKey, target.secretKey, target.bucket, target.region, prefix)
  const dateKeys = keys.filter((key) => /\/date\/\d{4}-\d{2}-\d{2}\.json$/.test(key)).sort()
  const texts = await readQiniuObjectsChunked(target, dateKeys)
  const documents: QiniuDayDocument[] = []
  texts.forEach((text, index) => {
    if (!text) return
    try {
      const parsed = JSON.parse(text) as QiniuDayDocument
      if (parsed && Array.isArray(parsed.entries)) documents.push(parsed)
    } catch {
      warnings.push(`七牛日期对象 ${dateKeys[index]} 已损坏，已跳过。`)
    }
  })
  return documents
}

function withQiniuRefs(entries: CalendarEntry[], target: QiniuTarget): CalendarEntry[] {
  const syncedAt = new Date().toISOString()
  return entries.map((entry) => {
    const ref: EntryRemoteRef = {
      provider: 'qiniu',
      id: entry.id,
      dataSourceId: target.bucket,
      lastSyncedAt: syncedAt,
    }
    return {
      ...entry,
      remote: entry.remote ?? ref,
      remoteRefs: {
        ...entry.remoteRefs,
        qiniu: ref,
      },
    }
  })
}

async function hydrateQiniuLocalEntries(
  entries: CalendarEntry[],
  target: QiniuTarget,
): Promise<CalendarEntry[]> {
  const keys = entries.flatMap((entry) => entry.attachments
    .map((attachment) => qiniuAttachmentKey(entry, attachment))
    .filter((key): key is string => Boolean(key)))
  if (!keys.length) return entries
  const sourceUrlByKey = new Map<string, string>()
  if (target.domain) {
    const urls = await signQiniuDownloadUrls(target.accessKey, target.secretKey, target.domain, keys)
    keys.forEach((key, index) => sourceUrlByKey.set(key, urls[index]))
  }

  const dataUrlCache = new Map<string, string>()
  return Promise.all(entries.map(async (entry) => ({
    ...entry,
    attachments: await Promise.all(entry.attachments.map(async (attachment) => {
      const key = qiniuAttachmentKey(entry, attachment)
      if (!key) return attachment
      let dataUrl = attachment.dataUrl
      if (!dataUrl && attachment.mimeType.startsWith('image/')) {
        if (!dataUrlCache.has(key)) {
          try {
            const fetched = await getQiniuAttachmentDataUrl(
              target.accessKey,
              target.secretKey,
              target.bucket,
              target.region,
              target.domain,
              key,
              attachment.mimeType,
            )
            dataUrlCache.set(key, fetched ?? '')
          } catch {
            dataUrlCache.set(key, '')
          }
        }
        dataUrl = dataUrlCache.get(key) || dataUrl
      }
      return {
        ...attachment,
        dataUrl,
        sourceUrl: sourceUrlByKey.get(key) ?? attachment.sourceUrl,
      }
    })),
  })))
}

type QiniuTagEntrySummary = {
  id: string
  title: string
  tagNames: string[]
}

function buildQiniuTagIndexes(
  date: string,
  dayEntryTags: QiniuTagEntrySummary[],
): Map<string, QiniuTagIndex> {
  const grouped = new Map<string, QiniuTagIndex>()
  for (const entry of dayEntryTags) {
    for (const tagName of entry.tagNames) {
      const current = grouped.get(tagName)
      grouped.set(tagName, {
        date,
        title: current?.title || entry.title || '未命名记录',
        entryIds: [...(current?.entryIds ?? []), entry.id],
      })
    }
  }
  return grouped
}

function qiniuJsonObject(key: string, value: unknown): QiniuObjectInput {
  return {
    key,
    dataBase64: utf8ToBase64(JSON.stringify(value, null, 2)),
    contentType: 'application/json',
  }
}

function shouldReplaceQiniuJson(text: string | null | undefined, value: unknown): boolean {
  if (!text) return true
  try {
    return JSON.stringify(JSON.parse(text)) !== JSON.stringify(value)
  } catch {
    return true
  }
}

function qiniuTagIndexDate(key: string): string | null {
    const match = /(\d{4}-\d{2}-\d{2})\.json$/.exec(key)
    return match?.[1] ?? null
}

async function putQiniuObjectsChunked(
  target: QiniuTarget,
  objects: QiniuObjectInput[],
): Promise<void> {
  for (let index = 0; index < objects.length; index += 24) {
    await putQiniuObjects(
      target.accessKey,
      target.secretKey,
      target.bucket,
      target.region,
      objects.slice(index, index + 24),
    )
  }
}

function createQiniuSyncTarget(settings: AppSettings, configure?: () => void): RemoteSyncTarget {
  const target = qiniuTarget(settings)
  const configured = Boolean(target.accessKey && target.secretKey && target.bucket)
  return {
    id: `qiniu:${target.bucket}:${target.region}:${target.prefix}`,
    provider: 'qiniu',
    label: target.bucket || '七牛 Kodo',
    detail: `七牛 Kodo · 区域 ${target.region} · 前缀 /${target.prefix}`,
    configured,
    active: false,
    requirement: '需要 AccessKey / SecretKey 和空间；附件下载需要空间绑定域名',
    configure,
    async pullToLocal(currentEntries, currentTags) {
      const warnings: string[] = []
      const documents = await listQiniuDayDocuments(target, warnings)
      const [metaText] = await readQiniuObjectsChunked(target, [`${target.prefix}/${QINIU_TAGS_META_KEY}`])
      let tags = [...currentTags]
      if (metaText) {
        try {
          const meta = JSON.parse(metaText) as { tags?: Tag[] }
          for (const remoteTag of meta.tags ?? []) {
            if (!remoteTag?.name) continue
            if (tags.some((tag) => tag.name.toLowerCase() === remoteTag.name.toLowerCase())) continue
            tags = [...tags, remoteTag]
          }
        } catch {
          warnings.push('七牛标签元数据已损坏，已保留本地标签。')
        }
      }
      const mergedRemote = mergeQiniuDayDocuments(documents, tags)
      const remoteEntries = withQiniuRefs(mergedRemote.entries, target)
      const entries = mergeQiniuEntriesWithLocal(remoteEntries, currentEntries)
      const hydrated = await hydrateQiniuLocalEntries(entries, target)
      return {
        entries: hydrated,
        tags: mergedRemote.newTags,
        pulledCount: remoteEntries.length,
        warnings,
      }
    },
    async pushFromLocal(entries, tags) {
      const warnings: string[] = []
      const nameById = new Map(tags.map((tag) => [tag.id, tag.name]))
      const updatedEntries = entries.map((entry) => ({ ...entry, attachments: [...entry.attachments] }))
      const dates = Array.from(new Set(entries.map((entry) => entry.date))).sort()
      const dateSet = new Set(dates)
      const dayKeys = dates.map((date) => qiniuDayKey(target.prefix, date))
      const allTagIndexKeys = (await listQiniuKeys(
        target.accessKey,
        target.secretKey,
        target.bucket,
        target.region,
        `${target.prefix}/tags/`,
      )).filter((key) => dateSet.has(qiniuTagIndexDate(key) ?? ''))
      const metaKey = `${target.prefix}/${QINIU_TAGS_META_KEY}`
      const keysToRead = [...dayKeys, ...allTagIndexKeys, metaKey]
      const existingTexts = await readQiniuObjectsChunked(target, keysToRead)
      const textByKey = new Map(keysToRead.map((key, index) => [key, existingTexts[index]]))
      const existingByDate = new Map(dates.map((date) => {
        const text = textByKey.get(qiniuDayKey(target.prefix, date))
        if (!text) return [date, null] as const
        try {
          const parsed = JSON.parse(text) as QiniuDayDocument
          return [date, parsed?.date === date ? parsed : null] as const
        } catch {
          warnings.push(`七牛日期对象 ${qiniuDayKey(target.prefix, date)} 已损坏，推送时会重建。`)
          return [date, null] as const
        }
      }))

      const attachmentUploads: QiniuObjectInput[] = []
      for (const entry of updatedEntries) {
        const existingRecord = existingByDate.get(entry.date)?.entries.find((record) => record.id === entry.id)
        entry.attachments = entry.attachments.map((attachment) => {
          const existingAttachment = existingRecord?.attachments.find((item) => item.id === attachment.id)
            ?? existingRecord?.attachments.find((item) => item.name === attachment.name && item.mimeType === attachment.mimeType)
          const currentKey = existingAttachment?.key ?? qiniuAttachmentKey(entry, attachment)
          if (currentKey) return { ...attachment, qiniuKey: currentKey }

          const key = qiniuFileKey(target.prefix, attachment.id, attachment.name)
          if (attachment.dataUrl) {
            const { mimeType, base64 } = parseDataUrl(attachment.dataUrl)
            attachmentUploads.push({
              key,
              dataBase64: base64,
              contentType: attachment.mimeType || mimeType,
            })
            return { ...attachment, qiniuKey: key }
          }
          warnings.push(`记录 ${entry.title || entry.date} 的附件 ${attachment.name} 缺少本地内容，仅同步了元数据。`)
          return { ...attachment, qiniuKey: key }
        })
      }
      await putQiniuObjectsChunked(target, attachmentUploads)

      const jsonWrites: QiniuObjectInput[] = []
      const expectedTagIndexKeys = new Set<string>()
      for (const date of dates) {
        const existing = existingByDate.get(date)
        const remoteOnly = mergeQiniuDayDocuments(existing ? [existing] : [], tags).entries
          .filter((item) => !updatedEntries.some((entry) => entry.id === item.id))
        const dayEntriesById = new Map(remoteOnly.map((entry) => [entry.id, entry]))
        for (const entry of updatedEntries.filter((item) => item.date === date)) {
          dayEntriesById.set(entry.id, entry)
        }
        const dayEntries = Array.from(dayEntriesById.values())
        if (dayEntries.length === 0) continue

        const dayKey = qiniuDayKey(target.prefix, date)
        const dayDocument = toQiniuDayDocument(date, dayEntries, tags, target.prefix)
        if (shouldReplaceQiniuJson(textByKey.get(dayKey), dayDocument)) {
          jsonWrites.push(qiniuJsonObject(dayKey, dayDocument))
        }

        const tagSummaries = dayEntries.map((entry) => ({
          id: entry.id,
          title: entry.title,
          tagNames: entry.tagIds.map((tagId) => nameById.get(tagId)).filter((name): name is string => Boolean(name)),
        })) satisfies QiniuTagEntrySummary[]
        for (const [tagName, index] of buildQiniuTagIndexes(date, tagSummaries)) {
          const key = qiniuTagIndexKey(target.prefix, tagName, date)
          expectedTagIndexKeys.add(key)
          if (shouldReplaceQiniuJson(textByKey.get(key), index)) {
            jsonWrites.push(qiniuJsonObject(key, index))
          }
        }
      }

      const staleTagIndexKeys = allTagIndexKeys.filter((key) => !expectedTagIndexKeys.has(key))
      if (staleTagIndexKeys.length > 0) {
        await deleteQiniuObjects(
          target.accessKey,
          target.secretKey,
          target.bucket,
          target.region,
          staleTagIndexKeys,
        )
      }

      const tagsMeta = {
        tags: tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color, retired: tag.retired ?? false })),
      }
      if (shouldReplaceQiniuJson(textByKey.get(metaKey), tagsMeta)) {
        jsonWrites.push(qiniuJsonObject(metaKey, tagsMeta))
      }
      await putQiniuObjectsChunked(target, jsonWrites)

      const entriesWithRefs = withQiniuRefs(updatedEntries, target)
      return {
        entries: entriesWithRefs.map((entry, index) => ({
          ...entry,
          remote: entries[index].remote ?? entry.remoteRefs?.qiniu,
        })),
        pushedCount: entries.length,
        warnings,
      }
    },
  }
}

export function createRemoteSyncTargets(
  settings: AppSettings,
  options?: {
    activateNotionDataset?: (dataset: NotionDataset) => void
    configureNotion?: () => void
    configureQiniu?: () => void
  },
): RemoteSyncTarget[] {
  const notionTargets = (settings.notionDatasets ?? []).map((dataset) => createNotionSyncTarget(
    settings,
    dataset,
    () => options?.activateNotionDataset?.(dataset),
    options?.configureNotion,
  ))
  const hasQiniuDraft = Boolean(
    settings.qiniuAccessKey.trim()
    || settings.qiniuSecretKey.trim()
    || settings.qiniuBucket.trim(),
  )
  return hasQiniuDraft
    ? [...notionTargets, createQiniuSyncTarget(settings, options?.configureQiniu)]
    : notionTargets
}

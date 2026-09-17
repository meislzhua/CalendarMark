export type TagColor = 'mint' | 'lavender' | 'peach' | 'sky' | 'lemon' | 'rose'

export type Tag = {
  id: string
  name: string
  color: TagColor
  /** 停用后不再出现在选择列表，但已有记录和远端内容保持不变 */
  retired?: boolean
}

export type Attachment = {
  id: string
  name: string
  mimeType: string
  size: number
  dataUrl: string
  sourceUrl?: string
  remoteId?: string
  remoteFile?: {
    kind: 'file' | 'external'
    value: Record<string, unknown>
  }
  /** 七牛对象键。与 Notion 的 remoteId 分开保存，支持同一条本地记录同步到多个远程源 */
  qiniuKey?: string
}

export type EntryRemoteRef = {
  provider: DataSourceId
  id: string
  dataSourceId?: string
  lastSyncedAt?: string
}

export type CalendarEntry = {
  id: string
  date: string
  title: string
  content: string
  tagIds: string[]
  attachments: Attachment[]
  /** 可选心情 emoji，随记录保存并显示在日历格上 */
  mood?: string
  updatedAt: string
  remote?: EntryRemoteRef
  /** 各远程源的稳定引用；remote 仍表示最近一次同步的源，兼容旧数据 */
  remoteRefs?: Partial<Record<'notion' | 'qiniu', EntryRemoteRef>>
}

/**
 * CalendarMark 的日历语义是“一天一条记录”。旧版本本地/七牛数据可能因为
 * 远端 ID 与本地 ID 不一致而产生同日多条记录；读取和写入时统一收敛为最新一条。
 */
export function oneEntryPerDate(entries: CalendarEntry[]): CalendarEntry[] {
  const byDate = new Map<string, CalendarEntry>()
  for (const entry of entries) {
    const current = byDate.get(entry.date)
    const currentTime = Date.parse(entry.updatedAt)
    const currentTimeValue = Number.isNaN(currentTime) ? 0 : currentTime
    if (!current) {
      byDate.set(entry.date, entry)
      continue
    }
    const currentTimeExisting = Date.parse(current.updatedAt)
    const existingValue = Number.isNaN(currentTimeExisting) ? 0 : currentTimeExisting
    if (currentTimeValue > existingValue || (currentTimeValue === existingValue && entry.updatedAt > current.updatedAt)) {
      byDate.set(entry.date, entry)
    }
  }
  return Array.from(byDate.values()).sort((left, right) => left.date.localeCompare(right.date))
}

export const MOOD_OPTIONS = ['😊', '😐', '😢', '😴', '😑', '😤', '🤩'] as const

export type ThemeMode = 'light' | 'dark' | 'auto'

/** 窗口模式：常规桌面窗口；抽屉模式：贴屏幕右侧的窄边栏（桌面端专属） */
export type UiMode = 'window' | 'drawer'

export type DataSourceId = 'notion' | 'local' | 'qiniu' | 'webdav' | 'obsidian'

export type DataSourceStatus = 'active' | 'preview' | 'planned'

export type DataSourceDefinition = {
  id: DataSourceId
  label: string
  description: string
  detail: string
  status: DataSourceStatus
}

export type NotionDataset = {
  databaseId: string
  databaseTitle: string
  dataSourceId: string
  dataSourceName: string
}

export type QiniuRegionOption = {
  id: string
  label: string
}

export const DATA_SOURCE_DEFINITIONS: DataSourceDefinition[] = [
  {
    id: 'notion',
    label: 'Notion',
    description: '云端数据库，适合跨设备同步',
    detail: '已接入 · API 同步',
    status: 'active',
  },
  {
    id: 'local',
    label: '本地存储',
    description: '离线优先，数据保存在此设备',
    detail: '当前可用 · 无需连接',
    status: 'active',
  },
  {
    id: 'qiniu',
    label: '七牛 Kodo',
    description: '私有对象存储空间，跨设备同步',
    detail: '已接入 · Token 直连',
    status: 'active',
  },
  {
    id: 'webdav',
    label: 'WebDAV',
    description: '连接自托管文件服务',
    detail: '计划支持',
    status: 'planned',
  },
  {
    id: 'obsidian',
    label: 'Obsidian Vault',
    description: '将记录保存为 Markdown 文件',
    detail: '计划支持',
    status: 'planned',
  },
]

export type AppSettings = {
  shortcut: string
  theme: ThemeMode
  uiMode: UiMode
  dataSource: DataSourceId
  notionToken: string
  notionDatabaseId: string
  notionDataSourceId: string
  notionDatasets: NotionDataset[]
  qiniuAccessKey: string
  qiniuSecretKey: string
  qiniuBucket: string
  qiniuRegion: string
  qiniuDomain: string
  qiniuPrefix: string
}

export const TAG_COLORS: TagColor[] = [
  'mint',
  'lavender',
  'peach',
  'sky',
  'lemon',
  'rose',
]

export const DEFAULT_TAGS: Tag[] = [
  { id: 'tag-focus', name: '专注', color: 'mint' },
  { id: 'tag-meeting', name: '会议', color: 'lavender' },
  { id: 'tag-idea', name: '灵感', color: 'peach' },
  { id: 'tag-personal', name: '生活', color: 'sky' },
]

export const DEFAULT_SETTINGS: AppSettings = {
  shortcut: 'CommandOrControl+Shift+Space',
  theme: 'light',
  uiMode: 'window',
  dataSource: 'local',
  notionToken: '',
  notionDatabaseId: '',
  notionDataSourceId: '',
  notionDatasets: [],
  qiniuAccessKey: '',
  qiniuSecretKey: '',
  qiniuBucket: '',
  qiniuRegion: 'z0',
  qiniuDomain: '',
  qiniuPrefix: 'calendarmark',
}

export function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function toDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function fromDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function formatDateKey(dateKey: string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('zh-CN', options ?? {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(fromDateKey(dateKey))
}

export function getSeedEntries(reference = new Date()): CalendarEntry[] {
  const year = reference.getFullYear()
  const month = reference.getMonth()
  const seed = (day: number, title: string, content: string, tagIds: string[]): CalendarEntry => ({
    id: `seed-${year}-${month + 1}-${day}`,
    date: toDateKey(new Date(year, month, day)),
    title,
    content,
    tagIds,
    attachments: [],
    updatedAt: new Date(year, month, day, 9, 30).toISOString(),
  })

  return [
    seed(2, '周一计划', '梳理本周最重要的三件事，让日历成为可执行的地图。', ['tag-focus']),
    seed(5, '产品灵感', '把碎片化的想法写下来，周末统一回看。', ['tag-idea']),
    seed(8, '设计评审', '准备新版本的时间轴与标签筛选。', ['tag-meeting']),
    seed(12, '晚间散步', '下班后留出一段没有屏幕的时间。', ['tag-personal']),
    seed(15, '深度工作', '上午完成 CalendarMark 的核心交互。', ['tag-focus', 'tag-idea']),
  ]
}

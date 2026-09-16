export type TagColor = 'mint' | 'lavender' | 'peach' | 'sky' | 'lemon' | 'rose'

export type Tag = {
  id: string
  name: string
  color: TagColor
}

export type Attachment = {
  id: string
  name: string
  mimeType: string
  size: number
  dataUrl: string
}

export type CalendarEntry = {
  id: string
  date: string
  title: string
  content: string
  tagIds: string[]
  attachments: Attachment[]
  updatedAt: string
}

export type ThemeMode = 'light' | 'dark' | 'auto'

export type AppSettings = {
  shortcut: string
  theme: ThemeMode
  notionToken: string
  notionDatabaseId: string
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
  notionToken: '',
  notionDatabaseId: '',
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

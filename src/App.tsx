import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, Dispatch, FormEvent, ReactNode, SetStateAction } from 'react'
import {
  ArrowLeft,
  AppWindow,
  BookOpen,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  Database,
  FileImage,
  FileText,
  ExternalLink,
  HardDrive,
  KeyRound,
  Keyboard,
  Monitor,
  Moon,
  PanelRightClose,
  Palette,
  PanelRight,
  Power,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Sparkles,
  Sun,
  Tag as TagIcon,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import './App.css'
import {
  DATA_SOURCE_DEFINITIONS,
  DEFAULT_SETTINGS,
  MOOD_OPTIONS,
  TAG_COLORS,
  createId,
  formatDateKey,
  fromDateKey,
  toDateKey,
} from './types'
import type {
  AppSettings,
  Attachment,
  CalendarEntry,
  DataSourceId,
  NotionDataset,
  Tag,
} from './types'
import {
  loadEntries,
  loadSettings,
  loadTags,
  saveEntries,
  saveSettings,
  saveTags,
} from './storage'
import {
  applyUiMode,
  openInExternalBrowser,
  readAutostartEnabled,
  setAutostartEnabled,
  hideMainWindow,
  isDesktopTauriRuntime,
  listenForSettingsOpen,
  onWindowFocusChanged,
  registerGlobalShortcut,
  toggleMainWindow,
} from './tauri'
import {
  checkNotionConnection,
  createNotionDatabase,
  discoverNotionDatasets,
  pullNotionEntries,
  pushNotionEntries,
  searchNotionPages,
} from './notion'
import {
  createLocalDataSource,
  createNotionDataSource,
  createQiniuDataSource,
} from './data-source'
import type { CalendarDataSource } from './data-source'
import type {
  NotionConnectionInfo,
  NotionDatasetOption,
  NotionEntryRecord,
  NotionPageOption,
  NotionPushResult,
} from './notion'
import {
  createQiniuBucket,
  getQiniuUsage,
  listQiniuBucketDomains,
  listQiniuBuckets,
  listQiniuRegions,
} from './qiniu'
import type { QiniuUsage } from './qiniu'
import type { QiniuRegionOption } from './types'

type View = 'calendar' | 'settings'
type SettingsSection = 'source' | 'system' | 'interface' | 'tags'

function findScrollContainer(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement
  while (node && node !== document.documentElement) {
    const overflowY = getComputedStyle(node).overflowY
    if (/(auto|scroll)/.test(overflowY)) return node
    node = node.parentElement
  }
  return null
}

type CalendarCell = {
  date: Date
  dateKey: string
  isCurrentMonth: boolean
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function getCalendarCells(month: Date): CalendarCell[] {
  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const firstDay = new Date(year, monthIndex, 1)
  const startOffset = (firstDay.getDay() + 6) % 7
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate()
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7

  return Array.from({ length: totalCells }, (_, index) => {
    const date = new Date(year, monthIndex, index - startOffset + 1)
    return {
      date,
      dateKey: toDateKey(date),
      isCurrentMonth: date.getMonth() === monthIndex,
    }
  })
}

function createDraft(dateKey: string): CalendarEntry {
  return {
    id: createId('entry'),
    date: dateKey,
    title: '',
    content: '',
    tagIds: [],
    attachments: [],
    updatedAt: new Date().toISOString(),
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function notionDatasetKey(dataset: Pick<NotionDataset, 'databaseId' | 'dataSourceId'>): string {
  return `${dataset.databaseId}:${dataset.dataSourceId}`
}

function getActiveNotionDataset(settings: AppSettings): NotionDataset | undefined {
  const datasets = settings.notionDatasets ?? []
  return datasets.find((dataset) => notionDatasetKey(dataset) === `${settings.notionDatabaseId}:${settings.notionDataSourceId}`)
    ?? datasets.find((dataset) => dataset.databaseId === settings.notionDatabaseId)
    ?? (settings.notionDatabaseId.trim() ? undefined : datasets[0])
}

function getNotionTarget(settings: AppSettings): { databaseId: string; dataSourceId: string } {
  const dataset = getActiveNotionDataset(settings)
  return {
    databaseId: dataset?.databaseId ?? settings.notionDatabaseId.trim(),
    dataSourceId: dataset?.dataSourceId ?? settings.notionDataSourceId.trim(),
  }
}

function isRemoteDataSource(source: AppSettings['dataSource']): boolean {
  return source !== 'local'
}

function getRemoteConfigError(settings: AppSettings): string | null {
  if (settings.dataSource === 'local') return null
  if (settings.dataSource === 'notion') {
    const target = getNotionTarget(settings)
    if (!settings.notionToken.trim() || !target.databaseId) return '请先在设置中配置 Notion Token 并添加数据集'
    return null
  }
  if (settings.dataSource === 'qiniu') {
    if (!settings.qiniuToken.trim() || !settings.qiniuBucket.trim()) return '请先在设置中配置七牛 AccessKey:SecretKey 并选择空间'
    return null
  }
  return '当前数据源不可用'
}

function remoteTargetKey(settings: AppSettings): string {
  if (settings.dataSource === 'qiniu') {
    const prefix = settings.qiniuPrefix.trim().replace(/^\/+|\/+$/g, '') || 'calendarmark'
    return `${settings.qiniuBucket.trim()}:${settings.qiniuRegion.trim() || 'z0'}:${prefix}`
  }
  const target = getNotionTarget(settings)
  return `${target.databaseId}:${target.dataSourceId}`
}

function formatQiniuBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

function withNotionDataset(settings: AppSettings, dataset: NotionDataset): AppSettings {
  const datasets = settings.notionDatasets ?? []
  const datasetKey = notionDatasetKey(dataset)
  const existingIndex = datasets.findIndex((item) => notionDatasetKey(item) === datasetKey)
  return {
    ...settings,
    // 原位更新，避免每次连接成功后数据集在列表中来回跳动。
    notionDatasets: existingIndex >= 0
      ? datasets.map((item, index) => (index === existingIndex ? dataset : item))
      : [...datasets, dataset],
    notionDatabaseId: dataset.databaseId,
    notionDataSourceId: dataset.dataSourceId,
  }
}

function toNotionEntryInput(entry: CalendarEntry, tags: Tag[], dataSourceId?: string) {
  const tagNames = new Map(tags.map((tag) => [tag.id, tag.name]))
  const remoteId = entry.remote?.provider === 'notion'
    && (!dataSourceId || entry.remote.dataSourceId === dataSourceId)
    ? entry.remote.id
    : undefined
  return {
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
}

type RemoteDataState = 'local' | 'loading' | 'ready' | 'needs-config' | 'saving' | 'deleting' | 'error'

function App() {
  const today = toDateKey(new Date())
  const [view, setView] = useState<View>('calendar')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('source')
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [selectedDate, setSelectedDate] = useState(today)
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [entries, setEntries] = useState<CalendarEntry[]>(() => isRemoteDataSource(settings.dataSource) ? [] : loadEntries())
  const [tags, setTags] = useState<Tag[]>(() => isRemoteDataSource(settings.dataSource) ? [] : loadTags())
  const [draft, setDraft] = useState<CalendarEntry>(() => createDraft(today))
  const [newTagName, setNewTagName] = useState('')
  const [tagManageMode, setTagManageMode] = useState(false)
  const [drawerSlideIn, setDrawerSlideIn] = useState(true)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [tagDatesFor, setTagDatesFor] = useState<Tag | null>(null)
  const [tagDates, setTagDates] = useState<Array<{ date: string; title: string }>>([])
  const [tagDatesLoading, setTagDatesLoading] = useState(false)
  const [settingsJumpTo, setSettingsJumpTo] = useState<SettingsSection | null>(null)
  const [monthPickerOpen, setMonthPickerOpen] = useState(false)
  const [shortcutState, setShortcutState] = useState<'ready' | 'browser' | 'error'>('browser')
  const [notice, setNotice] = useState('')
  const [remoteDataState, setRemoteDataState] = useState<RemoteDataState>(isRemoteDataSource(settings.dataSource) ? 'needs-config' : 'local')
  const [qiniuUsage, setQiniuUsage] = useState<QiniuUsage | null>(null)
  const [qiniuUsageState, setQiniuUsageState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const previousDataSourceRef = useRef<AppSettings['dataSource'] | null>(null)
  const previousNotionTargetRef = useRef<string | null>(null)
  const loadedMonthsRef = useRef<Set<string>>(new Set())
  const [remoteReloadToken, setRemoteReloadToken] = useState(0)
  const skipLocalSaveRef = useRef(false)
  const notionTarget = getNotionTarget(settings)
  const activeRemoteTargetKey = remoteTargetKey(settings)
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const tagsRef = useRef(tags)
  tagsRef.current = tags

  // 统一数据源接口：UI 不感知本地/远程差异，Notion 实现负责筛选、分页与远端引用
  const dataSource = useMemo<CalendarDataSource>(() => (
    settings.dataSource === 'notion'
      ? createNotionDataSource(() => settingsRef.current)
      : settings.dataSource === 'qiniu'
        ? createQiniuDataSource(() => settingsRef.current, () => entriesRef.current)
        : createLocalDataSource()
  ), [settings.dataSource, settings.notionToken, notionTarget.databaseId, notionTarget.dataSourceId, settings.qiniuToken, settings.qiniuBucket, settings.qiniuRegion, settings.qiniuPrefix])

  const calendarCells = useMemo(() => getCalendarCells(currentMonth), [currentMonth])
  const monthTitle = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
  }).format(currentMonth)
  const currentMonthEntries = entries
    .filter((entry) => fromDateKey(entry.date).getMonth() === currentMonth.getMonth()
      && fromDateKey(entry.date).getFullYear() === currentMonth.getFullYear())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  useEffect(() => {
    const sourceChanged = previousDataSourceRef.current !== settings.dataSource
    previousDataSourceRef.current = settings.dataSource

    if (!isRemoteDataSource(settings.dataSource)) {
      if (sourceChanged) {
        skipLocalSaveRef.current = true
        setEntries(loadEntries())
        setTags(loadTags())
      }
      setRemoteDataState('local')
      previousNotionTargetRef.current = null
      return undefined
    }

    // 切换到远程模式或切换数据集时，立即清空上一个目标的运行时数据；
    // 仅修改 Token 时不清空，交给下方防抖后的远端读取刷新，避免输入过程中日历反复闪空。
    const targetChanged = previousNotionTargetRef.current !== activeRemoteTargetKey
    previousNotionTargetRef.current = activeRemoteTargetKey
    if (sourceChanged || targetChanged) {
      setEntries([])
      setTags([])
      loadedMonthsRef.current.clear()
    }
  }, [settings.dataSource, activeRemoteTargetKey])

  // 远程模式按月按需加载：切换年月/刷新时只请求当前月的数据，
  // 远端超过单页 100 条时由数据源实现负责筛选与分页，避免每次全量拉取。
  useEffect(() => {
    if (!isRemoteDataSource(settings.dataSource)) return undefined
    if (getRemoteConfigError(settings)) {
      setRemoteDataState('needs-config')
      loadedMonthsRef.current.clear()
      return undefined
    }

    const monthKey = toDateKey(currentMonth).slice(0, 7)
    let cancelled = false
    if (loadedMonthsRef.current.has(monthKey)) {
      // 月份缓存命中：直接复用已加载数据，不重复请求远端
      setRemoteDataState('ready')
      return undefined
    }
    setRemoteDataState('loading')
    const timer = window.setTimeout(() => {
      if (cancelled) return
      void dataSource.loadMonth(currentMonth.getFullYear(), currentMonth.getMonth(), tagsRef.current)
        .then((result) => {
          if (cancelled) return
          loadedMonthsRef.current.add(monthKey)
          setTags((previous) => {
            const known = new Set(previous.map((tag) => tag.name.toLowerCase()))
            return [...previous, ...result.newTags.filter((tag) => !known.has(tag.name.toLowerCase()))]
          })
          setEntries((previous) => [
            ...previous.filter((entry) => entry.date.slice(0, 7) !== monthKey),
            ...result.entries,
          ])
          setRemoteDataState('ready')
        })
        .catch((error) => {
          if (cancelled) return
          setRemoteDataState('error')
          setNotice(error instanceof Error ? error.message : String(error))
        })
    }, 400)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [settings.dataSource, activeRemoteTargetKey, currentMonth, remoteReloadToken, dataSource])

  useEffect(() => {
    if (settings.dataSource !== 'local') return
    if (skipLocalSaveRef.current) {
      skipLocalSaveRef.current = false
      return
    }
    saveEntries(entries)
    saveTags(tags)
  }, [entries, tags, settings.dataSource])

  useEffect(() => saveSettings(settings), [settings])

  useEffect(() => {
    const isDark = settings.theme === 'dark'
      || (settings.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
  }, [settings.theme])

  // 应用界面模式：抽屉模式切换为贴屏幕右侧的无边框窄窗口，窗口模式恢复常规窗口。
  useEffect(() => {
    document.documentElement.dataset.uiMode = settings.uiMode
    void applyUiMode(settings.uiMode)
  }, [settings.uiMode])

  // 抽屉模式：窗口重新显示/聚焦时重放滑入动效。
  useEffect(() => {
    if (settings.uiMode !== 'drawer') return undefined
    let cancelled = false
    let dispose: (() => void) | undefined
    void onWindowFocusChanged((focused) => {
      if (!focused) return
      setDrawerSlideIn(false)
      window.requestAnimationFrame(() => setDrawerSlideIn(true))
    }).then((fn) => {
      if (cancelled) fn()
      else dispose = fn
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [settings.uiMode])

  useEffect(() => {
    let cancelled = false
    void registerGlobalShortcut(settings.shortcut, () => {
      setView('calendar')
      // 已聚焦时收起窗口；未聚焦或隐藏时显示并聚焦
      void toggleMainWindow()
    }).then((result) => {
      if (cancelled) return
      setShortcutState(!isDesktopTauriRuntime() ? 'browser' : result.ok ? 'ready' : 'error')
    })
    return () => {
      cancelled = true
    }
  }, [settings.shortcut])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void listenForSettingsOpen(() => {
      setView('settings')
    }).then((dispose) => {
      unlisten = dispose
    })
    return () => unlisten?.()
  }, [])

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(''), 2800)
    return () => window.clearTimeout(timer)
  }, [notice])

  // 七牛额度用量：配置好七牛数据源后，在左下角数据源入口上方常驻显示。
  useEffect(() => {
    if (!settings.qiniuToken.trim() || !settings.qiniuBucket.trim()) {
      setQiniuUsage(null)
      setQiniuUsageState('idle')
      return undefined
    }
    let cancelled = false
    setQiniuUsageState('loading')
    getQiniuUsage(settings.qiniuToken, settings.qiniuBucket, settings.qiniuRegion)
      .then((usage) => {
        if (cancelled) return
        setQiniuUsage(usage)
        setQiniuUsageState('ready')
      })
      .catch(() => {
        if (cancelled) return
        setQiniuUsage(null)
        setQiniuUsageState('error')
      })
    return () => {
      cancelled = true
    }
  }, [settings.qiniuToken, settings.qiniuBucket, settings.qiniuRegion, settings.dataSource])

  // 年月选择器：点击外部关闭
  useEffect(() => {
    if (!monthPickerOpen) return undefined
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (!target.closest('.month-title-wrap')) setMonthPickerOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [monthPickerOpen])

  // 快捷入口标签：通过数据源接口跨月查询（本地模式回退到内存过滤）
  useEffect(() => {
    if (!tagDatesFor) {
      setTagDates([])
      return undefined
    }
    let cancelled = false
    setTagDatesLoading(true)
    void dataSource.queryTagDates(tagDatesFor.name)
      .then((remoteDates) => {
        if (cancelled) return
        if (dataSource.kind !== 'local') {
          setTagDates(remoteDates)
        } else {
          const dates = Array.from(new Set(entries
            .filter((entry) => entry.tagIds.includes(tagDatesFor.id))
            .map((entry) => entry.date)))
            .sort()
            .reverse()
            .map((date) => ({
              date,
              title: entries.find((item) => item.date === date && item.tagIds.includes(tagDatesFor.id))?.title || '未命名记录',
            }))
          setTagDates(dates)
        }
      })
      .catch(() => {
        if (!cancelled) setTagDates([])
      })
      .finally(() => {
        if (!cancelled) setTagDatesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tagDatesFor, dataSource, entries])

  const tagById = (tagId: string) => tags.find((tag) => tag.id === tagId)

  function openDate(dateKey: string) {
    const existing = entries.find((entry) => entry.date === dateKey)
    setDraft(existing ? { ...existing, tagIds: [...existing.tagIds], attachments: [...existing.attachments] } : createDraft(dateKey))
    setSelectedDate(dateKey)
    // 快捷入口可能跨月：同步把日历切到对应月份
    const [year, month] = dateKey.split('-').map(Number)
    setCurrentMonth(new Date(year, month - 1, 1))
    setView('calendar')
    setConfirmingDelete(false)
    setTagDatesFor(null)
  }

  function moveMonth(offset: number) {
    setCurrentMonth((month) => new Date(month.getFullYear(), month.getMonth() + offset, 1))
  }

  async function handleSaveEntry(event?: FormEvent) {
    event?.preventDefault()
    const cleaned = {
      ...draft,
      title: draft.title.trim(),
      content: draft.content.trim(),
      updatedAt: new Date().toISOString(),
    }
    const hasContent = cleaned.title || cleaned.content || cleaned.tagIds.length || cleaned.attachments.length
    if (!hasContent) {
      setNotice('还没有可保存的内容')
      return
    }

    if (isRemoteDataSource(settings.dataSource)) {
      if (remoteDataState === 'loading') {
        setNotice('正在读取远程数据，请稍候再保存')
        return
      }
      const configError = getRemoteConfigError(settings)
      if (configError) {
        setNotice(configError)
        return
      }
      setRemoteDataState('saving')
      try {
        const savedEntry = await dataSource.saveEntry(cleaned, tags)
        const monthKey = savedEntry.date.slice(0, 7)
        loadedMonthsRef.current.add(monthKey)
        setEntries((previous) => {
          const index = previous.findIndex((entry) => entry.id === savedEntry.id)
          if (index === -1) return [...previous, savedEntry]
          const next = [...previous]
          next[index] = savedEntry
          return next
        })
        setRemoteDataState('ready')
        setNotice(settings.dataSource === 'qiniu' ? '已直接保存到七牛 Kodo' : '已直接保存到 Notion')
      } catch (error) {
        setRemoteDataState('error')
        setNotice(error instanceof Error ? error.message : String(error))
      }
      return
    }

    const savedEntry = await dataSource.saveEntry(cleaned, tags)
    setEntries((previous) => {
      const index = previous.findIndex((entry) => entry.id === cleaned.id)
      if (index === -1) return [...previous, savedEntry]
      const next = [...previous]
      next[index] = savedEntry
      return next
    })
    setNotice('日期内容已保存')
  }

  async function handleDeleteEntry() {
    const existing = entries.find((entry) => entry.id === draft.id)
    if (!existing) return
    if (isRemoteDataSource(settings.dataSource)) {
      const configError = getRemoteConfigError(settings)
      if (configError) {
        setNotice(configError)
        return
      }
      setRemoteDataState('deleting')
      try {
        setNotice(settings.dataSource === 'qiniu' ? '正在从七牛删除记录…' : '正在从 Notion 归档记录…')
        await dataSource.deleteEntry(existing)
      } catch (error) {
        setRemoteDataState('error')
        setNotice(error instanceof Error ? error.message : String(error))
        return
      }
      setRemoteDataState('ready')
    }
    setEntries((previous) => previous.filter((entry) => entry.id !== draft.id))
    setConfirmingDelete(false)
    setNotice('日期内容已删除')
  }

  function toggleDraftTag(tagId: string) {
    setDraft((previous) => ({
      ...previous,
      tagIds: previous.tagIds.includes(tagId)
        ? previous.tagIds.filter((id) => id !== tagId)
        : [...previous.tagIds, tagId],
    }))
  }

  function addTag(name: string, onAdded?: (tag: Tag) => void) {
    const cleanName = name.trim()
    if (!cleanName) return
    const existing = tags.find((tag) => tag.name.toLowerCase() === cleanName.toLowerCase())
    if (existing) {
      if (existing.retired) {
        setTags((previous) => previous.map((item) => (item.id === existing.id ? { ...item, retired: false } : item)))
      }
      onAdded?.(existing)
      return
    }
    const tag: Tag = {
      id: createId('tag'),
      name: cleanName,
      color: TAG_COLORS[tags.length % TAG_COLORS.length],
    }
    setTags((previous) => [...previous, tag])
    onAdded?.(tag)
  }

  function handleAddTagFromDrawer() {
    addTag(newTagName, (tag) => {
      setDraft((previous) => ({
        ...previous,
        tagIds: previous.tagIds.includes(tag.id) ? previous.tagIds : [...previous.tagIds, tag.id],
      }))
      setNewTagName('')
    })
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    files.forEach((file) => {
      if (file.size > 5 * 1024 * 1024) {
        setNotice(`${file.name} 超过 5 MB，暂未添加`)
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const attachment: Attachment = {
          id: createId('attachment'),
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          dataUrl: String(reader.result),
        }
        setDraft((previous) => ({ ...previous, attachments: [...previous.attachments, attachment] }))
      }
      reader.readAsDataURL(file)
    })
    event.target.value = ''
  }

  // 停用标签：只是不再提供选择；已有记录、抽屉草稿和远端内容都保持原样。
  function retireTag(tagId: string) {
    const tag = tags.find((item) => item.id === tagId)
    if (!tag || tag.retired) return
    setTags((previous) => previous.map((item) => (item.id === tagId ? { ...item, retired: true } : item)))
    setNotice(`已停用标签「${tag.name}」，已有记录保持不变`)
  }

  function restoreTag(tagId: string) {
    setTags((previous) => previous.map((item) => (item.id === tagId ? { ...item, retired: false } : item)))
    setNotice('标签已恢复，可再次选择')
  }

  const remoteStatusText = remoteDataState === 'loading'
    ? '正在读取'
    : remoteDataState === 'needs-config'
      ? '待配置'
      : remoteDataState === 'error'
        ? '读取失败'
        : remoteDataState === 'saving'
          ? '正在写入'
          : remoteDataState === 'deleting'
            ? '正在删除'
            : '直接写入'

  return (
    <div className={`app-shell ${settings.uiMode === 'drawer' && drawerSlideIn ? 'app-shell--slide-in' : ''}`}>
      {settings.uiMode === 'drawer' && (
        <div className="drawer-drag-region" data-tauri-drag-region>
          <span data-tauri-drag-region>CalendarMark</span>
          <button type="button" className="plain-icon-button" aria-label="收起抽屉" title="收起到托盘" onClick={() => { void hideMainWindow() }}><PanelRightClose size={16} /></button>
        </div>
      )}
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><span>CM</span></div>
          <div>
            <strong>CalendarMark</strong>
            <span>你的时间地图</span>
          </div>
        </div>

        <div className="sidebar-section-label">工作台</div>
        <nav className="primary-nav" aria-label="主导航">
          <button className={view === 'calendar' ? 'nav-item active' : 'nav-item'} onClick={() => setView('calendar')}>
            <CalendarDays size={17} />
            <span>日历总览</span>
            <span className="nav-count">{currentMonthEntries.length}</span>
          </button>
          <button className={view === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setView('settings')}>
            <Settings2 size={17} />
            <span>设置</span>
          </button>
        </nav>

        <div className="sidebar-section-label sidebar-section-label--spaced">快捷入口</div>
        <div className="quick-links">
          {tags.filter((tag) => !tag.retired).slice(0, 4).map((tag) => (
            <button key={tag.id} className="quick-link" onClick={() => setTagDatesFor(tagDatesFor?.id === tag.id ? null : tag)} aria-expanded={tagDatesFor?.id === tag.id}>
              <span className={`tag-dot tag-dot--${tag.color}`} />
              <span>{tag.name}</span>
              {settings.dataSource === 'local' && <span className="quick-link-count">{entries.filter((entry) => entry.tagIds.includes(tag.id)).length}</span>}
            </button>
          ))}
          <button className="quick-link quick-link--muted" onClick={() => { setSettingsJumpTo('tags'); setView('settings') }}>
            <Plus size={15} />
            <span>管理标签</span>
          </button>
          {tagDatesFor && (
            <div className="tag-dates-popover">
              <div className="tag-dates-heading"><span className={`tag-dot tag-dot--${tagDatesFor.color}`} /><strong>{tagDatesFor.name}</strong><button type="button" className="plain-icon-button" aria-label="关闭" onClick={() => setTagDatesFor(null)}><X size={13} /></button></div>
              {tagDatesLoading
                ? <div className="tag-dates-empty">正在查询带此标签的日期…</div>
                : tagDates.length === 0
                  ? <div className="tag-dates-empty">还没有带这个标签的记录</div>
                  : <div className="tag-dates-list">{tagDates.slice(0, 8).map((item) => (
                    <button key={item.date} type="button" className="tag-date-item" onClick={() => openDate(item.date)}>
                      <span className="tag-date-day">{formatDateKey(item.date, { month: 'short', day: 'numeric' })}</span>
                      <span className="tag-date-title">{item.title}</span>
                    </button>
                  ))}{tagDates.length > 8 && <div className="tag-dates-empty">还有 {tagDates.length - 8} 天，可在日历中查看</div>}</div>}
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          {settings.qiniuToken.trim() && settings.qiniuBucket.trim() && (
            <div className="qiniu-usage-card" role="status">
              <div className="qiniu-usage-heading">
                <Cloud size={14} />
                <span>七牛额度用量</span>
                <span className={`status-dot ${qiniuUsageState === 'ready' ? 'status-dot--ready' : qiniuUsageState === 'error' ? 'status-dot--error' : ''}`} />
              </div>
              {qiniuUsageState === 'loading' && <p className="qiniu-usage-value">正在读取…</p>}
              {qiniuUsageState === 'error' && <p className="qiniu-usage-value qiniu-usage-value--error">读取失败，点击刷新重试</p>}
              {qiniuUsageState === 'ready' && qiniuUsage && (
                <>
                  <p className="qiniu-usage-value">
                    已用 {formatQiniuBytes(qiniuUsage.storageBytes)} / 免费 10 GB
                  </p>
                  <div className="qiniu-usage-bar" aria-hidden="true">
                    <span style={{ width: `${Math.min(100, Math.round((qiniuUsage.storageBytes / (10 * 1024 * 1024 * 1024)) * 100))}%` }} />
                  </div>
                </>
              )}
              <button
                type="button"
                className="qiniu-usage-refresh"
                onClick={() => {
                  if (qiniuUsageState === 'loading') return
                  setQiniuUsageState('loading')
                  getQiniuUsage(settings.qiniuToken, settings.qiniuBucket, settings.qiniuRegion)
                    .then((usage) => {
                      setQiniuUsage(usage)
                      setQiniuUsageState('ready')
                    })
                    .catch(() => {
                      setQiniuUsage(null)
                      setQiniuUsageState('error')
                    })
                }}
              >
                <RefreshCw size={12} className={qiniuUsageState === 'loading' ? 'spin' : ''} />
                刷新
              </button>
            </div>
          )}
          <button
            type="button"
            className="data-source-mini data-source-mini--action"
            title="切换数据源"
            onClick={() => { setSettingsJumpTo('source'); setView('settings') }}
          >
            <span className={'status-dot ' + (isRemoteDataSource(settings.dataSource) ? 'status-dot--ready' : '')} />
            <span>{settings.dataSource === 'notion' ? 'Notion 远程数据' : settings.dataSource === 'qiniu' ? '七牛 Kodo 远程数据' : '本地数据'}</span>
            <span className="data-source-divider">·</span>
            <span>{settings.dataSource === 'notion' ? remoteStatusText : settings.dataSource === 'qiniu' ? remoteStatusText : '可按需同步 Notion'}</span>
            <Settings2 size={13} />
          </button>
        </div>
      </aside>

      <main className="main-area">
        {view === 'calendar' ? (
          <>
            <header className="topbar">
              <div className="topbar-intro">
                <span className="eyebrow">{formatDateKey(today, { weekday: 'long' })}</span>
                <h1>把每一天，标记成自己的故事。</h1>
              </div>
              <div className="topbar-actions">
                <button className="icon-button" aria-label="搜索" title="搜索"><Search size={17} /></button>
                <button className="icon-button" aria-label="帮助" title="帮助"><CircleHelp size={17} /></button>
                <div className="avatar">M</div>
              </div>
            </header>

            <section className="calendar-toolbar">
              <div className="month-switcher">
                <button className="plain-icon-button" aria-label="上个月" onClick={() => moveMonth(-1)}><ChevronLeft size={18} /></button>
                <div className="month-title-wrap">
                  <button type="button" className="month-title-button" aria-expanded={monthPickerOpen} aria-haspopup="dialog" onClick={() => setMonthPickerOpen((open) => !open)}>
                    <h2>{monthTitle}</h2>
                    <ChevronDown size={14} />
                  </button>
                  {monthPickerOpen && (
                    <div className="month-picker" role="dialog" aria-label="选择年月">
                      <div className="month-picker-year">
                        <button type="button" className="plain-icon-button" aria-label="上一年" onClick={() => setCurrentMonth((month) => new Date(month.getFullYear() - 1, month.getMonth(), 1))}><ChevronLeft size={15} /></button>
                        <strong>{currentMonth.getFullYear()} 年</strong>
                        <button type="button" className="plain-icon-button" aria-label="下一年" onClick={() => setCurrentMonth((month) => new Date(month.getFullYear() + 1, month.getMonth(), 1))}><ChevronRight size={15} /></button>
                      </div>
                      <div className="month-picker-grid">
                        {Array.from({ length: 12 }, (_, index) => {
                          const active = currentMonth.getMonth() === index
                          return <button type="button" key={index} className={active ? 'month-picker-item active' : 'month-picker-item'} onClick={() => { setCurrentMonth(new Date(currentMonth.getFullYear(), index, 1)); setMonthPickerOpen(false) }}>{index + 1} 月</button>
                        })}
                      </div>
                    </div>
                  )}
                </div>
                <button className="plain-icon-button" aria-label="下个月" onClick={() => moveMonth(1)}><ChevronRight size={18} /></button>
              </div>
              <div className="calendar-toolbar-actions">
                {isRemoteDataSource(settings.dataSource) && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="刷新远程数据"
                    title={settings.dataSource === 'qiniu' ? '重新读取七牛数据' : '重新读取 Notion 数据'}
                    disabled={remoteDataState === 'loading'}
                    onClick={() => { loadedMonthsRef.current.clear(); setRemoteReloadToken((token) => token + 1) }}
                  >
                    <RefreshCw size={17} className={remoteDataState === 'loading' ? 'spin' : ''} />
                  </button>
                )}
                <button className="text-button" onClick={() => setCurrentMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}><ArrowLeft size={15} />回到今天</button>
                <button className="primary-button" onClick={() => openDate(today)}><Plus size={16} />记录今天</button>
              </div>
            </section>

            <section className="overview-grid">
              <div className="calendar-column">
                <div className="calendar-card card-surface">
                  <div className="calendar-card-header">
                    <div><span className="card-kicker">时间轴</span><p className="card-subtitle">在日历里看见正在发生的事</p></div>
                    <div className="calendar-legend"><span><i className="legend-line legend-line--solid" />有记录</span><span><i className="legend-line legend-line--dotted" />今天</span></div>
                  </div>
                  <div className="calendar-grid calendar-grid--head">
                    {WEEKDAYS.map((day, index) => <div key={day} className={index > 4 ? 'weekday weekend' : 'weekday'}>{day}</div>)}
                  </div>
                  <div className="calendar-grid calendar-grid--body">
                    {calendarCells.map((cell) => {
                      const dayEntries = entries.filter((entry) => entry.date === cell.dateKey)
                      const dayTags = Array.from(new Set(dayEntries.flatMap((entry) => entry.tagIds))).map(tagById).filter((tag): tag is Tag => Boolean(tag))
                      const dayMood = dayEntries.find((entry) => entry.mood)?.mood
                      const isToday = cell.dateKey === today
                      const isSelected = cell.dateKey === selectedDate
                      return (
                        <button type="button" key={cell.dateKey} className={`calendar-day ${cell.isCurrentMonth ? '' : 'calendar-day--outside'} ${isToday ? 'calendar-day--today' : ''} ${isSelected ? 'calendar-day--selected' : ''} ${dayEntries.length > 0 ? 'calendar-day--has-entry' : ''}`} onClick={() => openDate(cell.dateKey)}>
                          <div className="day-number-row"><span className="day-number">{cell.date.getDate()}</span>{dayMood && <span className="day-mood" title="当日心情">{dayMood}</span>}{dayEntries.length > 0 && <span className="entry-count">{dayEntries.length}</span>}</div>
                          <div className="day-tags">{dayTags.map((tag) => <span key={tag.id} className={`calendar-tag calendar-tag--${tag.color}`}>{tag.name}</span>)}</div>
                          {dayEntries.some((entry) => entry.attachments.length > 0) && <span className="attachment-indicator"><FileImage size={12} /></span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
              <aside className="entry-panel">
                <form className="editor-form" onSubmit={handleSaveEntry}>
                  <div className="drawer-header"><div><span className="eyebrow">日期记录</span><h2>{formatDateKey(selectedDate)}</h2></div></div>
                  <div className="drawer-scroll">
                    <label className="field-label" htmlFor="entry-title">标题</label>
                    <input id="entry-title" className="title-input" placeholder="今天发生了什么？" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
                    <label className="field-label" htmlFor="entry-content">内容</label>
                    <textarea id="entry-content" className="content-textarea" placeholder="写下细节、想法或下一步行动……" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} rows={3} />
                    <div className="field-label field-label--row"><span>今日心情</span>{draft.mood && <button type="button" className="text-button" onClick={() => setDraft({ ...draft, mood: undefined })}>清除</button>}</div>
                    <div className="mood-picker">
                      {MOOD_OPTIONS.map((mood) => (
                        <button type="button" key={mood} className={`mood-choice ${draft.mood === mood ? 'mood-choice--active' : ''}`} aria-label={`心情 ${mood}`} aria-pressed={draft.mood === mood} onClick={() => setDraft({ ...draft, mood: draft.mood === mood ? undefined : mood })}>{mood}</button>
                      ))}
                    </div>
                    <div className="field-label field-label--row"><span>快捷标签</span>{tagManageMode
                      ? <button type="button" className="text-button" onClick={() => setTagManageMode(false)}>完成</button>
                      : <button type="button" className="text-button" onClick={() => setTagManageMode(true)}>管理</button>}</div>
                    <div className="tag-picker">{tags.filter((tag) => !tag.retired || draft.tagIds.includes(tag.id)).map((tag) => tagManageMode
                      ? <span key={tag.id} className={`tag-choice tag-choice--${tag.color} tag-choice--managed`}><span className="tag-dot" />{tag.name}<button type="button" className="tag-retire-button" aria-label={`停用 ${tag.name}`} title="停用后不再提供选择，已有记录保持不变" onClick={() => retireTag(tag.id)}><X size={12} /></button></span>
                      : <button type="button" key={tag.id} className={`tag-choice tag-choice--${tag.color} ${draft.tagIds.includes(tag.id) ? 'tag-choice--active' : ''} ${tag.retired ? 'tag-choice--retired' : ''}`} onClick={() => toggleDraftTag(tag.id)}><span className="tag-dot" />{tag.name}{draft.tagIds.includes(tag.id) && <Check size={13} />}</button>)}</div>
                    {tagManageMode && <div className="field-hint tag-manage-hint">停用只影响后续选择，不会修改已有记录或远端内容。</div>}
                    <div className="inline-add-tag"><input aria-label="新标签名称" placeholder="添加新标签" value={newTagName} onChange={(event) => setNewTagName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); handleAddTagFromDrawer() } }} /><button type="button" aria-label="添加标签" onClick={handleAddTagFromDrawer}><Plus size={15} /></button></div>
                    <div className="field-label field-label--row"><span>附件</span><span className="field-hint">图片或文档，单个 ≤ 5 MB</span></div>
                    <label className="upload-zone"><Upload size={18} /><span><strong>拖拽或选择文件</strong><small>支持图片、TXT、Markdown、PDF</small></span><input type="file" multiple accept="image/*,.txt,.md,.pdf" onChange={handleFiles} /></label>
                    {draft.attachments.length > 0 && <div className="attachment-list">{draft.attachments.map((attachment) => <AttachmentItem key={attachment.id} attachment={attachment} onRemove={() => setDraft((previous) => ({ ...previous, attachments: previous.attachments.filter((item) => item.id !== attachment.id) }))} />)}</div>}
                  </div>
                  <div className="drawer-footer">{entries.some((entry) => entry.id === draft.id) && (confirmingDelete
                    ? <div className="delete-confirm">
                      <span>删除这条记录？</span>
                      <button type="button" className="danger-button" disabled={remoteDataState === 'deleting'} onClick={() => { void handleDeleteEntry() }}>确认删除</button>
                      <button type="button" className="text-button" onClick={() => setConfirmingDelete(false)}>取消</button>
                    </div>
                    : <button type="button" className="danger-button" onClick={() => setConfirmingDelete(true)}><Trash2 size={15} />删除</button>)}<div className="drawer-footer-actions"><button type="submit" className="primary-button" disabled={remoteDataState === 'saving'}><Save size={15} />{settings.dataSource === 'notion' ? '保存到 Notion' : settings.dataSource === 'qiniu' ? '保存到七牛' : '保存记录'}</button></div></div>
                </form>
              </aside>
            </section>
          </>
        ) : (
          <SettingsView settings={settings} settingsSection={settingsSection} setSettingsSection={setSettingsSection} onChangeSettings={setSettings} entries={entries} onChangeEntries={setEntries} tags={tags} onChangeTags={setTags} onAddTag={(name) => addTag(name)} onDeleteTag={retireTag} onRestoreTag={restoreTag} shortcutState={shortcutState} onNotice={setNotice} onReloadRemote={() => { loadedMonthsRef.current.clear(); setRemoteReloadToken((token) => token + 1) }} jumpTo={settingsJumpTo} onJumpHandled={() => setSettingsJumpTo(null)} />
        )}
      </main>

      {notice && <div className="toast" role="status"><Check size={15} />{notice}</div>}
    </div>
  )
}

function AttachmentItem({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const isImage = attachment.mimeType.startsWith('image/')
  const previewUrl = attachment.dataUrl || attachment.sourceUrl
  return <div className="attachment-item">{isImage && previewUrl ? <img src={previewUrl} alt={attachment.name} /> : <div className="attachment-file-icon"><FileText size={17} /></div>}<div className="attachment-copy"><strong title={attachment.name}>{attachment.name}</strong><small>{attachment.size > 0 ? formatBytes(attachment.size) : '远程附件'}</small></div><button type="button" className="plain-icon-button" aria-label={`移除 ${attachment.name}`} onClick={onRemove}><X size={14} /></button></div>
}

type SettingsViewProps = {
  settings: AppSettings
  settingsSection: SettingsSection
  setSettingsSection: (section: SettingsSection) => void
  onChangeSettings: Dispatch<SetStateAction<AppSettings>>
  entries: CalendarEntry[]
  onChangeEntries: (entries: CalendarEntry[]) => void
  tags: Tag[]
  onChangeTags: (tags: Tag[]) => void
  onAddTag: (name: string) => void
  onDeleteTag: (tagId: string) => void
  onRestoreTag: (tagId: string) => void
  shortcutState: 'ready' | 'browser' | 'error'
  onNotice: (message: string) => void
  onReloadRemote: () => void
  jumpTo: SettingsSection | null
  onJumpHandled: () => void
}

function SettingsView({ settings, settingsSection, setSettingsSection, onChangeSettings, entries, onChangeEntries, tags, onChangeTags, onAddTag, onDeleteTag, onRestoreTag, shortcutState, onNotice, onReloadRemote, jumpTo, onJumpHandled }: SettingsViewProps) {
  const [newTag, setNewTag] = useState('')
  const settingsScrollRef = useRef<HTMLElement | null>(null)
  const suppressSpyRef = useRef(false)
  const sections: { id: SettingsSection; label: string; description: string; icon: typeof Database }[] = [
    { id: 'source', label: '数据源', description: '选择数据来源', icon: Database },
    { id: 'system', label: '系统', description: '启动与快捷键', icon: Power },
    { id: 'interface', label: '界面', description: '调整显示方式', icon: Palette },
    { id: 'tags', label: '标签管理', description: '整理你的分类', icon: TagIcon },
  ]
  const update = (partial: Partial<AppSettings>) => onChangeSettings((previous) => ({ ...previous, ...partial }))

  // 侧栏等外部入口指定跳转到某个设置分区
  useEffect(() => {
    if (!jumpTo) return
    scrollToSection(jumpTo)
    onJumpHandled()
  }, [jumpTo])

  // 所有设置共享同一个滚动容器：导航点击平滑滚动到对应分区，
  // 滚动时反向高亮当前分区，避免内容长短不同导致滚动条出现/消失引起布局偏移。
  function scrollToSection(id: SettingsSection, smooth = true) {
    setSettingsSection(id)
    const target = document.getElementById(`settings-section-${id}`)
    if (!target) return
    // 只滚动设置内容所在的实际滚动容器（窗口模式是 settings-content，
    // 抽屉模式是 main-area）；scrollIntoView 会连带滚动 window，导致整页幽灵滚动条。
    const scroller = findScrollContainer(target)
    if (!scroller) return
    const targetTop = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    scroller.scrollTo({
      top: Math.max(0, targetTop - 10),
      behavior: smooth ? 'smooth' : 'auto',
    })
    if (smooth) {
      // 平滑滚动途中 observer 会路过中间分区，冻结高亮避免覆盖点击目标
      suppressSpyRef.current = true
      window.setTimeout(() => {
        suppressSpyRef.current = false
      }, 700)
    }
  }

  useEffect(() => {
    const container = settingsScrollRef.current
    if (!container) return undefined

  // 恢复上次浏览的分区（首次挂载不需要动效）
    requestAnimationFrame(() => {
      // 外部跳转（管理标签等）优先于上次浏览位置，避免异步恢复覆盖跳转目标
      const initial = container.querySelector<HTMLElement>(`#settings-section-${jumpTo ?? settingsSection}`)
      if (!initial) return
      const scroller = findScrollContainer(initial)
      if (scroller) {
        scroller.scrollTop = Math.max(0, initial.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 10)
      }
    })

    const observer = new IntersectionObserver((observed) => {
      if (suppressSpyRef.current) return
      const visible = observed
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      const target = visible?.target as HTMLElement | undefined
      if (!target) return
      // 滚动到底时最后一个分区往往进不了高亮带，强制激活最后一段
      const scroller = findScrollContainer(target)
      if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8) {
        const sections = scroller.querySelectorAll<HTMLElement>('.settings-section')
        const last = sections[sections.length - 1]?.dataset.section as SettingsSection | undefined
        if (last) setSettingsSection(last)
        return
      }
      const id = target.dataset.section as SettingsSection | undefined
      if (id) setSettingsSection(id)
    }, { rootMargin: '-12% 0px -55% 0px', threshold: [0.05, 0.25, 0.5, 0.75] })
    container.querySelectorAll<HTMLElement>('.settings-section').forEach((node) => observer.observe(node))
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function submitTag(event: FormEvent) {
    event.preventDefault()
    if (!newTag.trim()) return
    onAddTag(newTag)
    setNewTag('')
    onNotice('标签已添加')
  }

  return <div className="settings-page">
    <header className="settings-header"><div><span className="eyebrow">偏好设置</span><h1>让 CalendarMark 更像你的工作台。</h1><p>连接数据、调整快捷方式和整理标签，一切都在这里完成。</p></div><div className="settings-header-mark"><Settings2 size={25} /></div></header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        {sections.map(({ id, label, description, icon: Icon }) => <button key={id} className={settingsSection === id ? 'settings-nav-item active' : 'settings-nav-item'} onClick={() => scrollToSection(id)}><span className="settings-nav-icon"><Icon size={17} /></span><span><strong>{label}</strong><small>{description}</small></span><ChevronRight size={15} /></button>)}
        <div className="settings-nav-note"><CircleHelp size={15} /><span>数据源可以替换；外部连接凭据只保存在本机，不会上传到 CalendarMark 服务。</span></div>
      </nav>
      <section className="settings-content" ref={settingsScrollRef}>
        <div className="settings-section" id="settings-section-source" data-section="source">
          <DataSourceSettings settings={settings} onChangeSettings={onChangeSettings} entries={entries} onChangeEntries={onChangeEntries} tags={tags} onChangeTags={onChangeTags} onNotice={onNotice} onReloadRemote={onReloadRemote} />
        </div>
        <div className="settings-section" id="settings-section-system" data-section="system">
          <SystemSettings settings={settings} onChangeSettings={onChangeSettings} shortcutState={shortcutState} onNotice={onNotice} />
        </div>
        <div className="settings-section" id="settings-section-interface" data-section="interface">
          <SettingsTitle icon={<Palette size={18} />} eyebrow="界面" title="选择让你感觉舒服的明暗" description="主题设置会立即应用到 CalendarMark 的所有界面。" />
          <div className="ui-mode-options">
            <button type="button" className={`ui-mode-option ${settings.uiMode === 'window' ? 'ui-mode-option--active' : ''}`} onClick={() => update({ uiMode: 'window' })}>
              <AppWindow size={18} />
              <span><strong>窗口模式</strong><small>常规桌面窗口，完整双栏布局</small></span>
              {settings.uiMode === 'window' && <Check size={15} />}
            </button>
            <button type="button" className={`ui-mode-option ${settings.uiMode === 'drawer' ? 'ui-mode-option--active' : ''}`} onClick={() => update({ uiMode: 'drawer' })}>
              <PanelRight size={18} />
              <span><strong>抽屉模式</strong><small>贴屏幕右侧的窄边栏，桌面端专属</small></span>
              {settings.uiMode === 'drawer' && <Check size={15} />}
            </button>
          </div>
          <div className="theme-options"><ThemeOption icon={<Sun size={18} />} title="浅色" description="干净明亮的纸张感" active={settings.theme === 'light'} onClick={() => update({ theme: 'light' })} /><ThemeOption icon={<Moon size={18} />} title="深色" description="夜间记录更舒适" active={settings.theme === 'dark'} onClick={() => update({ theme: 'dark' })} /><ThemeOption icon={<Monitor size={18} />} title="跟随系统" description="随系统自动切换" active={settings.theme === 'auto'} onClick={() => update({ theme: 'auto' })} /></div>
          <div className="preference-card"><div className="preference-row"><div className="preference-copy"><strong>启动时显示上次浏览的月份</strong><span>下次打开时保留你的浏览上下文</span></div><span className="toggle-switch toggle-switch--on"><span /></span></div><div className="preference-row"><div className="preference-copy"><strong>关闭窗口时保留在托盘</strong><span>点击右上角关闭只隐藏窗口，不退出应用</span></div><span className="toggle-switch toggle-switch--on"><span /></span></div></div>
        </div>
        <div className="settings-section" id="settings-section-tags" data-section="tags">
          <SettingsTitle icon={<TagIcon size={18} />} eyebrow="标签管理" title="让标签替你整理生活的纹理" description="快捷标签会显示在日历格子和记录抽屉里；停用只是不再提供选择，已有记录保持不变。" />
          <div className="tag-manager-card"><div className="tag-manager-header"><div><strong>我的标签</strong><span>{tags.filter((tag) => !tag.retired).length} 个可选标签</span></div><form className="tag-add-form" onSubmit={submitTag}><input aria-label="标签名称" placeholder="输入新标签" value={newTag} onChange={(event) => setNewTag(event.target.value)} /><button type="submit" aria-label="添加标签"><Plus size={16} /></button></form></div><div className="managed-tags">{tags.filter((tag) => !tag.retired).map((tag) => <div className="managed-tag" key={tag.id}><span className={`tag-dot tag-dot--${tag.color}`} /><span>{tag.name}</span><span className="managed-tag-count">{entries.filter((entry) => entry.tagIds.includes(tag.id)).length} 条记录</span><button className="plain-icon-button" aria-label={`停用 ${tag.name}`} title="停用后不再提供选择，已有记录保持不变" onClick={() => onDeleteTag(tag.id)}><Trash2 size={14} /></button></div>)}</div></div>
          {tags.some((tag) => tag.retired) && <div className="tag-manager-card tag-manager-card--retired"><div className="tag-manager-header"><div><strong>已停用标签</strong><span>仍保留在历史记录中，可随时恢复选择</span></div></div><div className="managed-tags managed-tags--retired">{tags.filter((tag) => tag.retired).map((tag) => <div className="managed-tag" key={tag.id}><span className={`tag-dot tag-dot--${tag.color}`} /><span>{tag.name}</span><span className="managed-tag-count">{entries.filter((entry) => entry.tagIds.includes(tag.id)).length} 条记录</span><button className="text-button" onClick={() => onRestoreTag(tag.id)}>恢复</button></div>)}</div></div>}
        </div>
      </section>
    </div>
  </div>
}

type SystemSettingsProps = {
  settings: AppSettings
  onChangeSettings: Dispatch<SetStateAction<AppSettings>>
  shortcutState: 'ready' | 'browser' | 'error'
  onNotice: (message: string) => void
}

type AutostartState = 'checking' | 'on' | 'off' | 'unsupported' | 'error'

function normalizeShortcutKey(event: KeyboardEvent): string | null {
  const { code, key } = event
  if (code.startsWith('Key') && code.length === 4) return code.slice(3)
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5)
  const codeMap: Record<string, string> = {
    Space: 'Space',
    Comma: 'Comma',
    Period: 'Period',
    Slash: 'Slash',
    Backquote: 'Backquote',
    Tab: 'Tab',
    Enter: 'Enter',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    BracketLeft: 'BracketLeft',
    BracketRight: 'BracketRight',
    Semicolon: 'Semicolon',
    Quote: 'Quote',
    Backslash: 'Backslash',
    Minus: 'Minus',
    Equal: 'Equal',
  }
  if (codeMap[code]) return codeMap[code]
  if (/^F([1-9]|1[0-2])$/.test(key)) return key
  return null
}

function formatShortcutFromEvent(event: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null
  const key = normalizeShortcutKey(event)
  if (!key) return null
  // 全局快捷键至少需要一个主修饰键，避免抢占普通按键输入。
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return null
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

function displayShortcut(shortcut: string): string {
  return shortcut.replace('CommandOrControl', 'Ctrl')
}

function SystemSettings({ settings, onChangeSettings, shortcutState, onNotice }: SystemSettingsProps) {
  const [autostartState, setAutostartState] = useState<AutostartState>('checking')
  const [autostartBusy, setAutostartBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [captured, setCaptured] = useState('')
  const update = (partial: Partial<AppSettings>) => onChangeSettings((previous) => ({ ...previous, ...partial }))

  useEffect(() => {
    let cancelled = false
    void readAutostartEnabled().then((enabled) => {
      if (cancelled) return
      setAutostartState(enabled === null ? 'unsupported' : enabled ? 'on' : 'off')
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!recording) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        setCaptured('')
        return
      }
      const combo = formatShortcutFromEvent(event)
      if (combo) {
        setCaptured(combo)
        setRecording(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording])

  async function toggleAutostart() {
    if (autostartBusy || autostartState === 'checking' || autostartState === 'unsupported') return
    const next = autostartState !== 'on'
    setAutostartBusy(true)
    const ok = await setAutostartEnabled(next)
    setAutostartBusy(false)
    if (ok) {
      setAutostartState(next ? 'on' : 'off')
      onNotice(next ? '已开启开机启动' : '已关闭开机启动')
    } else {
      setAutostartState('error')
      onNotice('设置开机启动失败，请检查系统权限后重试')
    }
  }

  function applyCapturedShortcut() {
    if (!captured) return
    update({ shortcut: captured })
    onNotice(`快捷键已更新：${displayShortcut(captured)}`)
    setCaptured('')
  }

  const autostartLabel = autostartState === 'checking'
    ? '正在读取系统设置…'
    : autostartState === 'on'
      ? '已开启'
      : autostartState === 'unsupported'
        ? '浏览器 / 移动端不支持'
        : autostartState === 'error'
          ? '设置失败'
          : '已关闭'

  return <>
    <SettingsTitle icon={<Power size={18} />} eyebrow="系统" title="控制 CalendarMark 的启动方式" description="开机启动和全局快捷键只在桌面版生效；浏览器预览不会抢占系统设置。" />
    <div className="preference-card">
      <div className="preference-row">
        <div className="preference-copy"><strong>开机启动</strong><span>登录系统后自动运行 CalendarMark 并驻留托盘</span></div>
        <button
          type="button"
          role="switch"
          aria-checked={autostartState === 'on'}
          aria-label="开机启动"
          className={`toggle-switch ${autostartState === 'on' ? 'toggle-switch--on' : ''}`}
          disabled={autostartState === 'checking' || autostartState === 'unsupported' || autostartBusy}
          onClick={() => { void toggleAutostart() }}
        ><span /></button>
      </div>
      <div className="preference-row preference-row--subtle">
        <span className="connection-badge connection-badge--plain"><span className={`status-dot ${autostartState === 'error' ? 'status-dot--error' : ''}`} />{autostartLabel}</span>
        <span className="field-hint">通过系统注册表 / Launch Agent 管理，卸载应用后自动清理</span>
      </div>
    </div>
    <div className="preference-card">
      <div className="preference-row">
        <div className="preference-copy"><strong>打开 CalendarMark</strong><span>点击“读取组合键”后直接按下想要的按键组合</span></div>
        <div className="shortcut-recorder">
          {recording
            ? <span className="shortcut-recording-hint"><Keyboard size={15} />按下组合键，Esc 取消</span>
            : <button type="button" className="secondary-button" onClick={() => { setCaptured(''); setRecording(true) }}><Keyboard size={15} />读取组合键</button>}
        </div>
      </div>
      <div className="preference-row preference-row--subtle">
        <span className="connection-badge connection-badge--plain"><span className={`status-dot ${shortcutState === 'error' ? 'status-dot--error' : ''}`} />{shortcutState === 'ready' ? '桌面快捷键已注册' : shortcutState === 'error' ? '快捷键注册失败，请更换组合' : '浏览器预览模式'}</span>
        <div className="shortcut-capture-actions">
          <kbd className="shortcut-current">{displayShortcut(captured || settings.shortcut)}</kbd>
          {captured && captured !== settings.shortcut && <><button type="button" className="primary-button" onClick={applyCapturedShortcut}>应用</button><button type="button" className="text-button" onClick={() => setCaptured('')}>放弃</button></>}
          {!captured && settings.shortcut !== DEFAULT_SETTINGS.shortcut && <button className="text-button" onClick={() => update({ shortcut: DEFAULT_SETTINGS.shortcut })}>恢复默认</button>}
        </div>
      </div>
    </div>
  </>
}


function DataSourceSettings({ settings, onChangeSettings, entries, onChangeEntries, tags, onChangeTags, onNotice, onReloadRemote }: { settings: AppSettings; onChangeSettings: Dispatch<SetStateAction<AppSettings>>; entries: CalendarEntry[]; onChangeEntries: (entries: CalendarEntry[]) => void; tags: Tag[]; onChangeTags: (tags: Tag[]) => void; onNotice: (message: string) => void; onReloadRemote: () => void }) {
  const selectedSource = DATA_SOURCE_DEFINITIONS.find((source) => source.id === settings.dataSource) ?? DATA_SOURCE_DEFINITIONS[0]
  const update = (partial: Partial<AppSettings>) => onChangeSettings((previous) => ({ ...previous, ...partial }))

  function statusLabel(status: typeof selectedSource.status): string {
    if (status === 'active') return '可用'
    if (status === 'preview') return '配置预览'
    return '规划中'
  }

  return <>
    <SettingsTitle icon={<Database size={18} />} eyebrow="数据源" title="选择可以替换的数据来源" description="远程数据源会直接读写远端；本地数据源可以按需拉取或推送 Notion。" />
    <div className="source-selector-grid" aria-label="数据源选择">
      {DATA_SOURCE_DEFINITIONS.map((source) => {
        const isActive = selectedSource.id === source.id
        const isDisabled = source.status === 'planned'
        return <button key={source.id} type="button" className={`source-selector ${isActive ? 'source-selector--active' : ''} ${isDisabled ? 'source-selector--disabled' : ''}`} disabled={isDisabled} onClick={() => {
          if (isDisabled) {
            onNotice(`${source.label} 数据源将在后续版本开放`)
            return
          }
          update({ dataSource: source.id })
        }}>
          <span className={`source-selector-icon source-selector-icon--${source.id}`}><DataSourceIcon id={source.id} /></span>
          <span className="source-selector-copy"><strong>{source.label}</strong><small>{source.description} · {source.detail}</small></span>
          <span className={`source-selector-state source-selector-state--${source.status}`}>{isActive ? '当前' : statusLabel(source.status)}</span>
        </button>
      })}
    </div>
    {selectedSource.id === 'notion' && <NotionSourceSettings settings={settings} onChangeSettings={onChangeSettings} onNotice={onNotice} onReloadRemote={onReloadRemote} />}
    {selectedSource.id === 'local' && <LocalSourceSettings settings={settings} onChangeSettings={onChangeSettings} entries={entries} onChangeEntries={onChangeEntries} tags={tags} onChangeTags={onChangeTags} onNotice={onNotice} onSelectNotion={() => update({ dataSource: 'notion' })} />}
    {selectedSource.id === 'qiniu' && <QiniuSourceSettings settings={settings} onChangeSettings={onChangeSettings} onNotice={onNotice} onReloadRemote={onReloadRemote} />}
    {selectedSource.status === 'planned' && <PlannedSourceSettings sourceId={selectedSource.id} />}
  </>
}

function DataSourceIcon({ id }: { id: DataSourceId }) {
  if (id === 'local') return <HardDrive size={17} />
  if (id === 'qiniu') return <Cloud size={17} />
  if (id === 'webdav') return <Cloud size={17} />
  if (id === 'obsidian') return <BookOpen size={17} />
  return <Database size={17} />
}

type NotionBusyState = 'idle' | 'discovering' | 'checking' | 'searching-pages' | 'creating'

type NotionSourceSettingsProps = {
  settings: AppSettings
  onChangeSettings: Dispatch<SetStateAction<AppSettings>>
  onNotice: (message: string) => void
  onReloadRemote?: () => void
}

function NotionSourceSettings({ settings, onChangeSettings, onNotice, onReloadRemote }: NotionSourceSettingsProps) {
  const [connection, setConnection] = useState<NotionConnectionInfo | null>(null)
  const [discoveredDatasets, setDiscoveredDatasets] = useState<NotionDatasetOption[]>([])
  const [busy, setBusy] = useState<NotionBusyState>('idle')
  const [createOpen, setCreateOpen] = useState(false)
  const [parentPages, setParentPages] = useState<NotionPageOption[]>([])
  const [parentPageId, setParentPageId] = useState('')
  const [newDatabaseTitle, setNewDatabaseTitle] = useState('')
  const savedDatasets = settings.notionDatasets ?? []
  const selectedDataset = getActiveNotionDataset(settings)
  const activeDatabaseId = selectedDataset?.databaseId ?? settings.notionDatabaseId.trim()
  const activeDataSourceId = selectedDataset?.dataSourceId ?? settings.notionDataSourceId.trim()
  const activeDatasetKey = activeDatabaseId ? notionDatasetKey({ databaseId: activeDatabaseId, dataSourceId: activeDataSourceId }) : ''
  const isConfigured = Boolean(settings.notionToken.trim() && activeDatabaseId)
  const update = (partial: Partial<AppSettings>) => onChangeSettings((previous) => ({ ...previous, ...partial }))

  function rememberDataset(dataset: NotionDataset) {
    onChangeSettings((previous) => withNotionDataset(previous, dataset))
  }

  function rememberConnection(info: NotionConnectionInfo) {
    rememberDataset({
      databaseId: info.databaseId,
      databaseTitle: info.databaseTitle,
      dataSourceId: info.dataSourceId,
      dataSourceName: info.dataSourceName,
    })
  }

  async function handleDiscoverDatasets() {
    if (!settings.notionToken.trim()) {
      onNotice('请先填写 Integration Token，再发现可访问的数据集')
      return
    }
    setBusy('discovering')
    try {
      const result = await discoverNotionDatasets(settings.notionToken)
      setDiscoveredDatasets(result.datasets)
      onNotice(formatSyncNotice(`发现 ${result.datasets.length} 个可访问的数据集`, result.warnings))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('idle')
    }
  }

  function handleAddDataset(dataset: NotionDatasetOption) {
    rememberDataset(dataset)
    setConnection(null)
    onNotice(`已添加数据集：${dataset.databaseTitle} / ${dataset.dataSourceName}`)
  }

  function handleSelectDataset(dataset: NotionDataset) {
    update({
      notionDatabaseId: dataset.databaseId,
      notionDataSourceId: dataset.dataSourceId,
    })
    setConnection(null)
    onNotice(`已切换数据集：${dataset.databaseTitle} / ${dataset.dataSourceName}`)
  }

  function handleRemoveDataset(dataset: NotionDataset) {
    const nextDatasets = savedDatasets.filter((item) => notionDatasetKey(item) !== notionDatasetKey(dataset))
    const removingActive = notionDatasetKey(dataset) === activeDatasetKey
    const nextDataset = removingActive ? nextDatasets[0] : undefined
    update({
      notionDatasets: nextDatasets,
      ...(removingActive
        ? {
            notionDatabaseId: nextDataset?.databaseId ?? '',
            notionDataSourceId: nextDataset?.dataSourceId ?? '',
          }
        : {}),
    })
    setConnection(null)
    onNotice(`已从 CalendarMark 移除数据集「${dataset.dataSourceName}」（不会删除 Notion 内容）`)
  }

  async function handleCheckConnection() {
    if (!isConfigured) {
      onNotice('请先填写 Token，点击“发现数据集”并添加一个数据集')
      return
    }
    setBusy('checking')
    try {
      const result = await checkNotionConnection(settings.notionToken, activeDatabaseId, activeDataSourceId)
      setConnection(result)
      rememberConnection(result)
      onNotice(`Notion 已连接：${result.dataSourceName}`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('idle')
    }
  }

  async function handleSearchParentPages() {
    if (!settings.notionToken.trim()) {
      onNotice('请先填写 Integration Token，再选择父页面')
      return
    }
    setBusy('searching-pages')
    try {
      const result = await searchNotionPages(settings.notionToken)
      setParentPages(result.pages)
      if (!parentPageId && result.pages.length > 0) {
        setParentPageId(result.pages[0].pageId)
      }
      onNotice(formatSyncNotice(`找到 ${result.pages.length} 个可作为父级的页面`, result.warnings))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('idle')
    }
  }

  async function handleCreateDatabase() {
    if (!settings.notionToken.trim()) {
      onNotice('请先填写 Integration Token')
      return
    }
    if (!parentPageId) {
      onNotice('请先选择一个父页面；Notion API 要求新数据库必须挂在页面下')
      return
    }
    if (!newDatabaseTitle.trim()) {
      onNotice('请填写新数据库的名称')
      return
    }
    setBusy('creating')
    try {
      const result = await createNotionDatabase(settings.notionToken, parentPageId, newDatabaseTitle.trim())
      setConnection(result)
      rememberConnection(result)
      setCreateOpen(false)
      setNewDatabaseTitle('')
      onNotice(`已创建数据库「${result.databaseTitle}」，并自动添加到数据集`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('idle')
    }
  }

  const busyLabel = busy === 'discovering'
    ? '正在发现可访问的数据集…'
    : busy === 'checking'
      ? '正在检查连接…'
      : busy === 'searching-pages'
        ? '正在读取可访问的页面…'
        : busy === 'creating'
          ? '正在创建数据库…'
          : '远程直连：编辑后自动保存'
  const mapping = connection?.mapping

  return <>
    <div className="source-card source-card--notion">
      <div className="source-card-top"><div className="notion-logo">N</div><div><strong>Notion</strong><span>远程数据源 · 读取和写入均直接访问 Notion</span></div><span className="connection-badge"><span className={`status-dot ${connection ? 'status-dot--ready' : 'status-dot--muted'}`} />{connection ? '已连接' : isConfigured ? '自动同步' : '待配置'}</span></div>
      <div className="source-divider" />
      <div className="source-fields">
        <label className="field-label" htmlFor="notion-token"><span>Integration Token</span><span className="field-hint"><KeyRound size={12} />仅保存在本机</span></label>
        <input id="notion-token" className="settings-input" type="password" placeholder="secret_… 或 ntn_…" value={settings.notionToken} onChange={(event) => { update({ notionToken: event.target.value }); setConnection(null); setDiscoveredDatasets([]) }} />
        <button
          type="button"
          className="text-button notion-token-help"
          onClick={() => {
            void openInExternalBrowser('https://www.notion.so/profile/integrations').then((ok) => {
              if (!ok) window.open('https://www.notion.so/profile/integrations', '_blank', 'noopener')
            })
          }}
        ><ExternalLink size={13} />获取 Token</button>
      </div>
      <div className="notion-dataset-manager">
        <div className="notion-dataset-header">
          <div><strong>同步数据集</strong><span>从 Token 可访问的 Notion data source 中选择</span></div>
          <div className="notion-dataset-actions">
            <button type="button" className="secondary-button" disabled={busy !== 'idle'} onClick={() => { void handleDiscoverDatasets() }}><Search size={14} />{busy === 'discovering' ? '正在发现…' : '发现数据集'}</button>
            <button type="button" className="secondary-button" disabled={busy !== 'idle'} onClick={() => { setCreateOpen((open) => !open); if (!createOpen && parentPages.length === 0) void handleSearchParentPages() }}><Plus size={14} />新建数据库</button>
          </div>
        </div>
        {createOpen && <div className="notion-create-panel">
          <div className="notion-create-fields">
            <label className="field-label" htmlFor="notion-parent-page"><span>父页面</span><span className="field-hint">Notion API 要求新数据库必须创建在某个页面下</span></label>
            <div className="notion-parent-row">
              <select id="notion-parent-page" className="settings-input" value={parentPageId} disabled={parentPages.length === 0} onChange={(event) => setParentPageId(event.target.value)}>
                {parentPages.length === 0 && <option value="">暂无可用页面</option>}
                {parentPages.map((page) => <option key={page.pageId} value={page.pageId}>{page.title}</option>)}
              </select>
              <button type="button" className="secondary-button" disabled={busy !== 'idle'} onClick={() => { void handleSearchParentPages() }}><RefreshCw size={14} className={busy === 'searching-pages' ? 'spin' : ''} />刷新页面</button>
            </div>
            <label className="field-label" htmlFor="notion-new-database-title"><span>数据库名称</span><span className="field-hint">会自动创建 名称 / 日期 / 内容 / 标签 / 附件 属性</span></label>
            <input id="notion-new-database-title" className="settings-input" placeholder="例如：CalendarMark 日历" value={newDatabaseTitle} onChange={(event) => setNewDatabaseTitle(event.target.value)} />
          </div>
          <div className="notion-create-footer">
            <span className="field-hint">创建后会自动添加为当前数据集</span>
            <div className="notion-actions">
              <button type="button" className="text-button" onClick={() => setCreateOpen(false)}>取消</button>
              <button type="button" className="primary-button" disabled={busy !== 'idle' || !parentPageId || !newDatabaseTitle.trim()} onClick={() => { void handleCreateDatabase() }}>{busy === 'creating' ? '正在创建…' : '创建数据库'}</button>
            </div>
          </div>
        </div>}
        {savedDatasets.length > 0
          ? <div className="notion-dataset-list">{savedDatasets.map((dataset) => {
            const active = notionDatasetKey(dataset) === activeDatasetKey
            return <div className={'notion-dataset-option' + (active ? ' notion-dataset-option--active' : '')} key={notionDatasetKey(dataset)}>
              <button type="button" className="notion-dataset-select" onClick={() => handleSelectDataset(dataset)}>
                <span className="notion-dataset-copy"><strong>{dataset.databaseTitle}</strong><small>{dataset.dataSourceName}</small><code>{dataset.dataSourceId}</code></span>
                {active && <span className="notion-dataset-current">当前</span>}
              </button>
              <button type="button" className="plain-icon-button" aria-label={'移除 ' + dataset.dataSourceName} title="从本机移除" onClick={() => handleRemoveDataset(dataset)}><Trash2 size={14} /></button>
            </div>
          })}</div>
          : <div className="notion-dataset-empty">还没有添加数据集。点击“发现数据集”读取当前 Token 已授权的 Notion 数据源。</div>}
        {discoveredDatasets.length > 0 && <div className="notion-discovered-panel">
          <div className="notion-discovered-heading"><strong>发现结果</strong><span>添加后会保存在本机，移除不会删除 Notion 内容</span></div>
          <div className="notion-discovered-list">{discoveredDatasets.map((dataset) => {
            const saved = savedDatasets.some((item) => notionDatasetKey(item) === notionDatasetKey(dataset))
            return <div className="notion-discovered-item" key={notionDatasetKey(dataset)}>
              <div className="notion-discovered-copy"><strong>{dataset.databaseTitle}</strong><small>{dataset.dataSourceName}</small></div>
              <button type="button" className={saved ? 'secondary-button' : 'primary-button'} disabled={saved || busy !== 'idle'} onClick={() => handleAddDataset(dataset)}>{saved ? '已添加' : '添加数据集'}</button>
            </div>
          })}</div>
        </div>}
      </div>
      {connection && connection.dataSources.length > 1 && <div className="notion-data-source-picker"><label className="field-label" htmlFor="notion-data-source"><span>当前 Database 的 data source</span><span className="field-hint">也可以从连接结果切换</span></label><select id="notion-data-source" className="settings-input" value={activeDataSourceId} onChange={(event) => { const source = connection.dataSources.find((item) => item.id === event.target.value); if (!source) return; rememberDataset({ databaseId: connection.databaseId, databaseTitle: connection.databaseTitle, dataSourceId: source.id, dataSourceName: source.name }); setConnection(null) }}>{connection.dataSources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></div>}
      {connection && <div className="notion-connection-panel"><div className="notion-connection-heading"><span><Check size={14} />已连接到 {connection.databaseTitle}</span><small>{connection.dataSourceName}</small></div><div className="notion-mapping-grid"><span>标题：{mapping?.titleProperty ?? '未识别'}</span><span>日期：{mapping?.dateProperty ?? '未识别'}</span><span>正文：{mapping?.contentProperty ?? '未配置'}</span><span>标签：{mapping?.tagsProperty ?? '未配置'}</span><span>附件：{mapping?.filesProperty ?? '未配置'}</span></div>{mapping && !mapping.ready && <div className="notion-mapping-error">{mapping.message}</div>}<div className="notion-schema-list">{connection.properties.map((property) => <span key={`${property.id}-${property.name}`}><b>{property.name}</b><small>{property.propertyType}</small></span>)}</div></div>}
      <div className="source-card-footer source-card-footer--notion"><span><RefreshCw size={15} className={busy !== 'idle' ? 'spin' : ''} />{busyLabel}</span><div className="notion-actions"><button type="button" className="secondary-button" disabled={busy !== 'idle'} onClick={() => { void handleCheckConnection() }}><RefreshCw size={15} />检查连接</button><button type="button" className="secondary-button" disabled={busy !== 'idle' || !isConfigured} onClick={() => onReloadRemote?.()}><RefreshCw size={15} />重新读取</button></div></div>
    </div>
    <div className="info-banner"><Sparkles size={16} /><span><strong>远程直连规则：</strong>CalendarMark 启动或切换到 Notion 时自动读取远端数据；保存和删除记录会直接写入 Notion，不会把记录持久化到本机数据文件。Notion 侧有外部改动时，可点击“重新读取”刷新当前数据集。</span></div>
  </>
}

function mergeNotionEntries(records: NotionEntryRecord[], currentEntries: CalendarEntry[], currentTags: Tag[]): { entries: CalendarEntry[]; tags: Tag[] } {
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

  return { entries: nextEntries, tags: nextTags }
}

function applyPushResult(result: NotionPushResult, onChangeEntries: (entries: CalendarEntry[]) => void, currentEntries: CalendarEntry[]) {
  onChangeEntries(currentEntries.map((entry) => applyPushResultToEntry(entry, result)))
}

function applyPushResultToEntry(entry: CalendarEntry, result: NotionPushResult): CalendarEntry {
  const pushed = result.entries.find((item) => item.localId === entry.id)
  if (!pushed) return entry
  // 合并 Notion 返回的附件稳定引用（file upload ID / external 链接），
  // 后续再次编辑保存时复用引用，而不是把同一文件重新上传一遍。
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
      provider: 'notion',
      id: pushed.remoteId,
      dataSourceId: pushed.dataSourceId,
      lastSyncedAt: new Date().toISOString(),
    },
  }
}

function formatSyncNotice(message: string, warnings: string[]): string {
  if (!warnings.length) return message
  return `${message}；${warnings.slice(0, 2).join('；')}${warnings.length > 2 ? `（另有 ${warnings.length - 2} 条警告）` : ''}`
}

type LocalSourceSettingsProps = {
  settings: AppSettings
  onChangeSettings: Dispatch<SetStateAction<AppSettings>>
  entries: CalendarEntry[]
  onChangeEntries: (entries: CalendarEntry[]) => void
  tags: Tag[]
  onChangeTags: (tags: Tag[]) => void
  onNotice: (message: string) => void
  onSelectNotion: () => void
}

function LocalSourceSettings({ settings, onChangeSettings, entries, onChangeEntries, tags, onChangeTags, onNotice, onSelectNotion }: LocalSourceSettingsProps) {
  const [busy, setBusy] = useState<'idle' | 'pulling' | 'pushing'>('idle')
  const savedDatasets = settings.notionDatasets ?? []
  const selectedDataset = getActiveNotionDataset(settings)
  const isConfigured = Boolean(settings.notionToken.trim() && selectedDataset?.databaseId)

  async function handlePull() {
    const dataset = getActiveNotionDataset(settings)
    if (!settings.notionToken.trim() || !dataset?.databaseId) {
      onNotice('请先在 Notion 数据源中完成连接并添加数据集')
      return
    }
    setBusy('pulling')
    try {
      const result = await pullNotionEntries(settings.notionToken, dataset.databaseId, dataset.dataSourceId)
      const merged = mergeNotionEntries(result.entries, entries, tags)
      onChangeTags(merged.tags)
      onChangeEntries(merged.entries)
      onNotice(formatSyncNotice(`已从 Notion 拉取 ${result.entries.length} 条记录到本地`, result.warnings))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('idle')
    }
  }

  async function handlePush() {
    const dataset = getActiveNotionDataset(settings)
    if (!settings.notionToken.trim() || !dataset?.databaseId) {
      onNotice('请先在 Notion 数据源中完成连接并添加数据集')
      return
    }
    setBusy('pushing')
    try {
      const result = await pushNotionEntries(
        settings.notionToken,
        dataset.databaseId,
        dataset.dataSourceId,
        entries.map((entry) => toNotionEntryInput(entry, tags, dataset.dataSourceId)),
      )
      applyPushResult(result, onChangeEntries, entries)
      onNotice(formatSyncNotice(`已推送 ${result.entries.length} 条本地记录到 Notion`, result.warnings))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('idle')
    }
  }

  return <>
    <div className="source-stack">
      <div className="source-card source-card--local">
        <div className="source-card-top"><div className="source-placeholder-icon"><HardDrive size={18} /></div><div><strong>本地存储</strong><span>本地记录为主，数据保存在此设备</span></div><span className="connection-badge"><span className="status-dot status-dot--ready" />可用</span></div>
        <div className="source-divider" />
        <div className="local-source-body"><p>当前日历使用本机数据，保存会立即写入本地。已绑定的远程数据集可以按需拉取到本地，或将本地记录推送到远程。</p><div className="local-source-points"><span><Check size={14} />离线可用</span><span><Check size={14} />本地优先</span><span><Check size={14} />按需同步</span></div></div>
      </div>
      <div className="source-card source-card--remote-sync">
        <div className="source-card-top"><div className="notion-logo">N</div><div><strong>已绑定的 Notion 数据集</strong><span>只列出本机已添加的远程数据集</span></div><span className="connection-badge"><span className={`status-dot ${isConfigured ? 'status-dot--ready' : 'status-dot--muted'}`} />{isConfigured ? '待同步' : '未绑定'}</span></div>
        <div className="source-divider" />
        {savedDatasets.length > 0
          ? <>
            <div className="notion-dataset-list notion-dataset-list--compact">
              {savedDatasets.map((dataset) => {
                const active = selectedDataset && notionDatasetKey(dataset) === notionDatasetKey(selectedDataset)
                return <div className={'notion-dataset-option' + (active ? ' notion-dataset-option--active' : '')} key={notionDatasetKey(dataset)}>
                  <button type="button" className="notion-dataset-select" onClick={() => onChangeSettings((previous) => ({
                    ...previous,
                    notionDatabaseId: dataset.databaseId,
                    notionDataSourceId: dataset.dataSourceId,
                  }))}>
                    <span className="notion-dataset-copy"><strong>{dataset.databaseTitle}</strong><small>{dataset.dataSourceName}</small></span>
                    {active && <span className="notion-dataset-current">同步目标</span>}
                  </button>
                </div>
              })}
            </div>
            {settings.notionToken.trim()
              ? <div className="source-card-footer source-card-footer--notion"><span><RefreshCw size={15} className={busy !== 'idle' ? 'spin' : ''} />{busy === 'pulling' ? '正在从 Notion 拉取…' : busy === 'pushing' ? '正在推送本地记录…' : '本地 ↔ 已选数据集'}</span><div className="notion-actions"><button type="button" className="secondary-button" disabled={busy !== 'idle'} onClick={() => { void handlePull() }}><ArrowLeft size={15} />拉取到本地</button><button type="button" className="primary-button" disabled={busy !== 'idle'} onClick={() => { void handlePush() }}><Cloud size={15} />推送到 Notion</button></div></div>
              : <div className="local-sync-empty"><span>数据集需要配合 Integration Token 使用。</span><button type="button" className="secondary-button" onClick={onSelectNotion}>去 Notion 数据源配置 Token</button></div>}
          </>
          : <div className="local-sync-empty"><div><strong>还没有绑定远程数据集</strong><span>在 Notion 数据源中完成连接并添加数据集后，这里会显示可同步的目标。</span></div><button type="button" className="secondary-button" onClick={onSelectNotion}><Database size={15} />去 Notion 数据源配置</button></div>}
      </div>
    </div>
    <div className="info-banner"><Sparkles size={16} /><span><strong>本地同步规则：</strong>CalendarMark 当前以本地记录为主；点击“拉取到本地”合并 Notion 数据，点击“推送到 Notion”将本地记录创建或更新到远端。想让每次编辑直接写远程？切换到 Notion 数据源即可。</span></div>
  </>
}

type QiniuBusyState = 'idle' | 'connecting' | 'creating'

type QiniuSourceSettingsProps = {
  settings: AppSettings
  onChangeSettings: Dispatch<SetStateAction<AppSettings>>
  onNotice: (message: string) => void
  onReloadRemote?: () => void
}

function QiniuSourceSettings({ settings, onChangeSettings, onNotice, onReloadRemote }: QiniuSourceSettingsProps) {
  const [busy, setBusy] = useState<QiniuBusyState>('idle')
  const [buckets, setBuckets] = useState<string[]>([])
  const [regions, setRegions] = useState<QiniuRegionOption[]>([])
  const [newBucketName, setNewBucketName] = useState('calendarmark')
  const [usage, setUsage] = useState<QiniuUsage | null>(null)
  const [usageError, setUsageError] = useState('')
  const update = (partial: Partial<AppSettings>) => onChangeSettings((previous) => ({ ...previous, ...partial }))
  const isConfigured = Boolean(settings.qiniuToken.trim() && settings.qiniuBucket.trim())

  useEffect(() => {
    void listQiniuRegions().then(setRegions).catch(() => setRegions([]))
  }, [])

  async function refreshUsage(token: string, bucket: string, region: string) {
    setUsageError('')
    try {
      setUsage(await getQiniuUsage(token, bucket, region))
    } catch (error) {
      setUsage(null)
      setUsageError(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    if (!isConfigured) {
      setUsage(null)
      return undefined
    }
    void refreshUsage(settings.qiniuToken, settings.qiniuBucket, settings.qiniuRegion)
    return undefined
  }, [settings.qiniuToken, settings.qiniuBucket, settings.qiniuRegion, isConfigured])

  async function connectBuckets() {
    if (!settings.qiniuToken.trim()) {
      onNotice('请先填写七牛 AccessKey:SecretKey，格式：AK:SK')
      return
    }
    setBusy('connecting')
    try {
      const list = await listQiniuBuckets(settings.qiniuToken)
      setBuckets(list)
      const keepBucket = list.includes(settings.qiniuBucket.trim()) ? settings.qiniuBucket.trim() : ''
      let nextDomain = settings.qiniuDomain
      if (keepBucket) {
        const domains = await listQiniuBucketDomains(settings.qiniuToken, keepBucket)
        nextDomain = domains[0] ?? nextDomain
      }
      update({ qiniuBucket: keepBucket, qiniuDomain: nextDomain })
      onNotice(`已连接七牛账号，发现 ${list.length} 个空间`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('idle')
    }
  }

  async function selectBucket(bucket: string) {
    update({ qiniuBucket: bucket, qiniuDomain: '' })
    if (!settings.qiniuToken.trim()) return
    try {
      const domains = await listQiniuBucketDomains(settings.qiniuToken, bucket)
      update({ qiniuBucket: bucket, qiniuDomain: domains[0] ?? '' })
      if (!domains.length) onNotice('空间没有可用域名；附件下载需要空间绑定域名（新空间可能需要几分钟）')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    }
  }

  async function handleCreateBucket() {
    if (!settings.qiniuToken.trim()) {
      onNotice('请先填写七牛 AccessKey:SecretKey，再创建空间')
      return
    }
    const bucket = newBucketName.trim().toLowerCase()
    if (!bucket) {
      onNotice('请填写要创建的空间名称')
      return
    }
    setBusy('creating')
    try {
      await createQiniuBucket(settings.qiniuToken, bucket, settings.qiniuRegion)
      const list = await listQiniuBuckets(settings.qiniuToken)
      setBuckets(list)
      const domains = await listQiniuBucketDomains(settings.qiniuToken, bucket).catch(() => [])
      update({ qiniuBucket: bucket, qiniuDomain: domains[0] ?? '' })
      onNotice(`已创建私有空间「${bucket}」并设为同步目标`)
      onReloadRemote?.()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('idle')
    }
  }

  return <div className="source-card source-card--qiniu">
    <div className="source-card-top">
      <div className="qiniu-logo">Q</div>
      <div>
        <strong>七牛云 Kodo 连接</strong>
        <span>在七牛「个人中心 → 密钥管理」复制 AccessKey / SecretKey，粘贴为 AK:SK</span>
      </div>
      <span className="connection-badge"><span className={`status-dot ${isConfigured ? 'status-dot--ready' : ''}`} />{isConfigured ? '已连接' : '待配置'}</span>
    </div>

    <div className="source-fields">
      <label className="field-label">
        <span>密钥 Token（AK:SK）</span>
        <span className="field-hint">七牛控制台 → 个人中心 → 密钥管理</span>
      </label>
      <input
        className="settings-input"
        type="password"
        placeholder="AccessKey:SecretKey"
        value={settings.qiniuToken}
        onChange={(event) => update({ qiniuToken: event.target.value })}
      />
      <label className="field-label">
        <span>存储区域</span>
        <span className="field-hint">新建空间后所在区域不可修改</span>
      </label>
      <select className="settings-input" value={settings.qiniuRegion} onChange={(event) => update({ qiniuRegion: event.target.value })}>
        {(regions.length ? regions : [{ id: 'z0', label: '华东-浙江' }]).map((region) => (
          <option key={region.id} value={region.id}>{region.label}（{region.id}）</option>
        ))}
      </select>
      <label className="field-label">
        <span>存储目录前缀</span>
        <span className="field-hint">所有数据都写在这个前缀下，可与其他应用共用空间</span>
      </label>
      <input
        className="settings-input"
        placeholder="calendarmark"
        value={settings.qiniuPrefix}
        onChange={(event) => update({ qiniuPrefix: event.target.value })}
      />
      <div className="field-label field-label--row">
        <span>空间（Bucket）</span>
        <button type="button" className="secondary-button" disabled={busy !== 'idle'} onClick={() => { void connectBuckets() }}>
          <RefreshCw size={14} className={busy === 'connecting' ? 'spin' : ''} />
          {buckets.length ? '刷新空间列表' : '连接并获取空间'}
        </button>
      </div>
    </div>

    {buckets.length > 0 && (
      <div className="notion-dataset-list notion-dataset-list--compact">
        {buckets.map((bucket) => {
          const active = settings.qiniuBucket === bucket
          return (
            <div className={'notion-dataset-option' + (active ? ' notion-dataset-option--active' : '')} key={bucket}>
              <button type="button" className="notion-dataset-select" onClick={() => { void selectBucket(bucket) }}>
                <span className="notion-dataset-copy"><strong>{bucket}</strong><small>{active ? settings.qiniuRegion || 'z0' : '点击选择此空间'}</small></span>
                {active && <span className="notion-dataset-current">同步目标</span>}
              </button>
            </div>
          )
        })}
      </div>
    )}

    <div className="qiniu-create-card">
      <div>
        <strong>还没有专用空间？</strong>
        <span>一键创建私有空间，CalendarMark 数据只对本应用可见，其他设备用同一密钥即可同步。</span>
      </div>
      <div className="qiniu-create-form">
        <input
          className="settings-input"
          aria-label="新空间名称"
          placeholder="calendarmark"
          value={newBucketName}
          onChange={(event) => setNewBucketName(event.target.value)}
        />
        <button type="button" className="primary-button" disabled={busy !== 'idle'} onClick={() => { void handleCreateBucket() }}>
          <Upload size={15} className={busy === 'creating' ? 'spin' : ''} />
          {busy === 'creating' ? '正在创建…' : '创建私有空间'}
        </button>
      </div>
    </div>

    {isConfigured && (
      <div className="qiniu-usage-panel">
        <div className="qiniu-usage-heading">
          <Cloud size={15} />
          <strong>额度用量</strong>
          <button type="button" className="text-button" onClick={() => { void refreshUsage(settings.qiniuToken, settings.qiniuBucket, settings.qiniuRegion) }}>刷新</button>
        </div>
        {usage && (
          <>
            <p className="qiniu-usage-value">标准存储已用 {formatQiniuBytes(usage.storageBytes)}（免费额度 10 GB / 月，超量按量计费）</p>
            <div className="qiniu-usage-bar" aria-hidden="true">
              <span style={{ width: `${Math.min(100, Math.round((usage.storageBytes / (10 * 1024 * 1024 * 1024)) * 100))}%` }} />
            </div>
          </>
        )}
        {!usage && usageError && <p className="qiniu-usage-value qiniu-usage-value--error">{usageError}</p>}
      </div>
    )}

    <div className="source-card-footer source-card-footer--qiniu">
      <span>
        <KeyRound size={15} />
        密钥只保存在本机设置中，由 Rust 侧直接请求七牛 API；建议在七牛创建专用子账号授权，降低泄露影响。
      </span>
    </div>
  </div>
}

function PlannedSourceSettings({ sourceId }: { sourceId: DataSourceId }) {
  const source = DATA_SOURCE_DEFINITIONS.find((item) => item.id === sourceId)
  if (!source) return null
  return <div className="source-card source-card--planned"><div className="source-card-top"><div className="source-placeholder-icon"><DataSourceIcon id={source.id} /></div><div><strong>{source.label}</strong><span>{source.description}</span></div><span className="connection-badge">规划中</span></div><div className="source-divider" /><div className="planned-source-body"><Sparkles size={17} /><p>{source.label} 会沿用统一的数据源接口，连接设置和同步策略将在后续版本开放。</p></div></div>
}

function SettingsTitle({ icon, eyebrow, title, description }: { icon: ReactNode; eyebrow: string; title: string; description: string }) {
  return <div className="settings-title"><div className="settings-title-icon">{icon}</div><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div></div>
}

function ThemeOption({ icon, title, description, active, onClick }: { icon: ReactNode; title: string; description: string; active: boolean; onClick: () => void }) {
  return <button className={`theme-option ${active ? 'theme-option--active' : ''}`} onClick={onClick}><span className="theme-option-icon">{icon}</span><span><strong>{title}</strong><small>{description}</small></span>{active && <Check size={16} />}</button>
}

export default App

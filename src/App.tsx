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
  oneEntryPerDate,
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
  checkStorageAvailable,
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
  isAndroidTauriRuntime,
  isDesktopTauriRuntime,
  listenForSettingsOpen,
  onWindowFocusChanged,
  registerGlobalShortcut,
  toggleMainWindow,
} from './tauri'
import {
  checkNotionConnection,
  checkNotionSettingsConnection,
  createNotionDatabase,
  createNotionSettingsDatabase,
  discoverNotionDatasets,
  searchNotionPages,
  testNotionDataset,
  testNotionToken,
} from './notion'
import {
  createLocalDataSource,
  createNotionDataSource,
} from './data-source'
import type { CalendarDataSource } from './data-source'
import type {
  NotionConnectionInfo,
  NotionDatasetOption,
  NotionPageOption,
  NotionSettingsConnectionInfo,
} from './notion'
import {
  createRemoteSyncTargets,
} from './remote-sync'
import type { RemoteSyncDirection, RemoteSyncTarget } from './remote-sync'

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

function getNotionSettingsTarget(settings: AppSettings): { databaseId: string; dataSourceId: string } {
  const datasets = settings.notionDatasets ?? []
  const key = `${settings.notionSettingsDatabaseId}:${settings.notionSettingsDataSourceId}`
  const dataset = datasets.find((item) => notionDatasetKey(item) === key)
    ?? datasets.find((item) => item.databaseId === settings.notionSettingsDatabaseId)
  return {
    databaseId: dataset?.databaseId ?? settings.notionSettingsDatabaseId.trim(),
    dataSourceId: dataset?.dataSourceId ?? settings.notionSettingsDataSourceId.trim(),
  }
}

/**
 * 判断两个目标是否指向同一份 Notion 数据（同一个 data source）。
 * 注意：一个 Database 可能有多个 data source（发现列表里是两行），
 * 只有 databaseId 相同且无法区分 data source 时才应保守地视为同一份。
 */
function sameNotionStore(
  left: { databaseId: string; dataSourceId?: string },
  right: { databaseId: string; dataSourceId?: string },
): boolean {
  if (left.databaseId !== right.databaseId) return false
  const leftSource = left.dataSourceId?.trim()
  const rightSource = right.dataSourceId?.trim()
  if (leftSource && rightSource) return leftSource === rightSource
  return true
}

function isRemoteDataSource(source: AppSettings['dataSource']): boolean {
  return source === 'notion'
}

function getRemoteConfigError(settings: AppSettings): string | null {
  if (settings.dataSource === 'local') return null
  if (settings.dataSource === 'notion') {
    const target = getNotionTarget(settings)
    if (!settings.notionToken.trim()) return '请先在设置中配置 Notion Token'
    if (!target.databaseId) return '请先在设置中选择 Notion 日期数据库'
    return null
  }
  return '当前数据源不可用'
}

/** 设置数据库可用 = 已选择且不与日期数据库相同；不满足时只跳过标签设置同步，绝不阻塞日历读写 */
function notionSettingsSyncEnabled(settings: AppSettings): boolean {
  const dateTarget = getNotionTarget(settings)
  const settingsTarget = getNotionSettingsTarget(settings)
  return Boolean(
    settings.notionToken.trim()
      && settingsTarget.databaseId
      && !sameNotionStore(settingsTarget, dateTarget),
  )
}

/** 未启用设置同步的具体原因，用于界面提示；返回 null 表示标签设置同步正常 */
function notionSettingsDisabledReason(settings: AppSettings): string | null {
  if (notionSettingsSyncEnabled(settings)) return null
  const dateTarget = getNotionTarget(settings)
  const settingsTarget = getNotionSettingsTarget(settings)
  if (!settings.notionToken.trim()) return null
  if (settingsTarget.databaseId && sameNotionStore(settingsTarget, dateTarget)) {
    return '设置数据库与日期数据库指向同一份数据，标签设置不会写入 Notion；请选择另一个数据源或数据库作为设置库'
  }
  if (!settingsTarget.databaseId) {
    return '还未选择 Notion 设置数据库，标签只保存在本机；选择后自动同步'
  }
  return null
}

/**
 * 设置数据库是“标签等设置”的保存位置，但不是远程直连的硬性门槛：
 * 老配置 / 跨版本打开时只选过日期数据库，日历仍可直接读写，
 * 未选设置数据库时只提示，不把整个数据源判为待配置。
 */
function notionSettingsMissing(settings: AppSettings): boolean {
  if (!isRemoteDataSource(settings.dataSource)) return false
  return !notionSettingsSyncEnabled(settings)
}

function remoteTargetKey(settings: AppSettings): string {
  const target = getNotionTarget(settings)
  const settingsTarget = getNotionSettingsTarget(settings)
  return `${target.databaseId}:${target.dataSourceId}|${settingsTarget.databaseId}:${settingsTarget.dataSourceId}`
}

function withNotionDataset(
  settings: AppSettings,
  dataset: NotionDataset,
  role: 'date' | 'settings' = 'date',
): AppSettings {
  const datasets = settings.notionDatasets ?? []
  const datasetKey = notionDatasetKey(dataset)
  const existingIndex = datasets.findIndex((item) => notionDatasetKey(item) === datasetKey)
  return {
    ...settings,
    // 原位更新，避免每次连接成功后数据集在列表中来回跳动。
    notionDatasets: existingIndex >= 0
      ? datasets.map((item, index) => (index === existingIndex ? dataset : item))
      : [...datasets, dataset],
    ...(role === 'date'
      ? {
          notionDatabaseId: dataset.databaseId,
          notionDataSourceId: dataset.dataSourceId,
        }
      : {
          notionSettingsDatabaseId: dataset.databaseId,
          notionSettingsDataSourceId: dataset.dataSourceId,
        }),
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
      : createLocalDataSource()
  ), [settings.dataSource, settings.notionToken, notionTarget.databaseId, notionTarget.dataSourceId])

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
            // 按名称合并：设置数据库中的颜色/停用状态要覆盖本地，
            // 同时复用本地 id，避免记录上的 tagIds 断链。
            const byName = new Map(previous.map((tag) => [tag.name.toLowerCase(), tag]))
            for (const tag of result.newTags) {
              const key = tag.name.toLowerCase()
              const existing = byName.get(key)
              byName.set(key, existing ? { ...tag, id: existing.id } : tag)
            }
            return Array.from(byName.values())
          })
          setEntries((previous) => oneEntryPerDate([
            ...previous.filter((entry) => entry.date.slice(0, 7) !== monthKey),
            ...result.entries,
          ]))
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

  // 启动自检：localStorage 不可写时设置会静默丢失（重开后“又变回待配置”），
  // 必须第一时间显式告知，而不是让用户以为是配置问题。
  useEffect(() => {
    if (checkStorageAvailable()) return
    setNotice('本机存储不可用：设置无法保存，重启后会恢复默认。请检查应用数据目录/磁盘空间')
  }, [])

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(''), 2800)
    return () => window.clearTimeout(timer)
  }, [notice])

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
        setEntries((previous) => oneEntryPerDate([
          ...previous.filter((entry) => entry.date !== savedEntry.date),
          savedEntry,
        ]))
        setRemoteDataState('ready')
        setNotice('已直接保存到 Notion')
      } catch (error) {
        setRemoteDataState('error')
        setNotice(error instanceof Error ? error.message : String(error))
      }
      return
    }

    const savedEntry = await dataSource.saveEntry(cleaned, tags)
    setEntries((previous) => oneEntryPerDate([
      ...previous.filter((entry) => entry.date !== savedEntry.date),
      savedEntry,
    ]))
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
        setNotice('正在从 Notion 归档记录…')
        await dataSource.deleteEntry(existing)
      } catch (error) {
        setRemoteDataState('error')
        setNotice(error instanceof Error ? error.message : String(error))
        return
      }
      setRemoteDataState('ready')
    }
    setEntries((previous) => previous.filter((entry) => entry.date !== draft.date))
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

  // 远程直连模式：标签定义属于设置数据库，增改后立即写回远端。
  function persistTagsRemotely(nextTags: Tag[]) {
    if (!isRemoteDataSource(settings.dataSource) || getRemoteConfigError(settings)) return
    void dataSource.syncTags?.(nextTags).catch((error) => {
      setNotice(error instanceof Error ? error.message : String(error))
    })
  }

  function addTag(name: string, onAdded?: (tag: Tag) => void) {
    const cleanName = name.trim()
    if (!cleanName) return
    const existing = tags.find((tag) => tag.name.toLowerCase() === cleanName.toLowerCase())
    if (existing) {
      if (existing.retired) {
        const nextTags = tags.map((item) => (item.id === existing.id ? { ...item, retired: false } : item))
        setTags(nextTags)
        persistTagsRemotely(nextTags)
      }
      onAdded?.(existing)
      return
    }
    const tag: Tag = {
      id: createId('tag'),
      name: cleanName,
      color: TAG_COLORS[tags.length % TAG_COLORS.length],
    }
    const nextTags = [...tags, tag]
    setTags(nextTags)
    persistTagsRemotely(nextTags)
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
    const nextTags = tags.map((item) => (item.id === tagId ? { ...item, retired: true } : item))
    setTags(nextTags)
    persistTagsRemotely(nextTags)
    setNotice(`已停用标签「${tag.name}」，已有记录保持不变`)
  }

  function restoreTag(tagId: string) {
    const nextTags = tags.map((item) => (item.id === tagId ? { ...item, retired: false } : item))
    setTags(nextTags)
    persistTagsRemotely(nextTags)
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
            : notionSettingsMissing(settings)
              ? getNotionSettingsTarget(settings).databaseId ? '设置库=日期库' : '未选设置库'
              : '直接写入'
  const remoteConfigError = isRemoteDataSource(settings.dataSource) ? getRemoteConfigError(settings) : null
  const remoteSettingsHint = isRemoteDataSource(settings.dataSource) && !remoteConfigError
    ? notionSettingsDisabledReason(settings)
    : null

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
          <button
            type="button"
            className="data-source-mini data-source-mini--action"
            title={notionSettingsMissing(settings) ? `Notion 可正常读写日历；${notionSettingsDisabledReason(settings) ?? '标签设置暂未同步'}，点击去处理` : '切换数据源'}
            onClick={() => { setSettingsJumpTo('source'); setView('settings') }}
          >
            <span className={'status-dot ' + (isRemoteDataSource(settings.dataSource) ? 'status-dot--ready' : '')} />
            <span>{settings.dataSource === 'notion' ? 'Notion 远程数据' : '本地数据'}</span>
            <span className="data-source-divider">·</span>
            <span>{settings.dataSource === 'notion' ? remoteStatusText : '可按需同步 Notion'}</span>
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
                {isAndroidTauriRuntime() && (
                  <button className="icon-button" aria-label="设置" title="设置" onClick={() => setView('settings')}>
                    <Settings2 size={17} />
                  </button>
                )}
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
                    title="重新读取 Notion 数据"
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

            {(remoteConfigError || remoteSettingsHint) && (
              <div className={'remote-config-banner' + (remoteConfigError ? ' remote-config-banner--error' : '')}>
                <CircleHelp size={15} />
                <span>{remoteConfigError ?? remoteSettingsHint}</span>
                <button type="button" className="text-button" onClick={() => { setSettingsJumpTo('source'); setView('settings') }}>去配置</button>
              </div>
            )}

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
                    : <button type="button" className="danger-button" onClick={() => setConfirmingDelete(true)}><Trash2 size={15} />删除</button>)}<div className="drawer-footer-actions"><button type="submit" className="primary-button" disabled={remoteDataState === 'saving'}><Save size={15} />{settings.dataSource === 'notion' ? '保存到 Notion' : '保存记录'}</button></div></div>
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
  const isAndroid = isAndroidTauriRuntime()
  const allSections: { id: SettingsSection; label: string; description: string; icon: typeof Database }[] = [
    { id: 'source', label: '数据源', description: '选择数据来源', icon: Database },
    { id: 'system', label: '系统', description: '启动与快捷键', icon: Power },
    { id: 'interface', label: '界面', description: isAndroid ? '选择主题' : '调整显示方式', icon: Palette },
    { id: 'tags', label: '标签管理', description: '整理你的分类', icon: TagIcon },
  ]
  const sections = allSections.filter((section) => !isAndroid || section.id !== 'system')
  const update = (partial: Partial<AppSettings>) => onChangeSettings((previous) => ({ ...previous, ...partial }))

  useEffect(() => {
    if (isAndroid && settingsSection === 'system') setSettingsSection('source')
  }, [isAndroid, settingsSection])

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
        {!isAndroid && <div className="settings-section" id="settings-section-system" data-section="system">
          <SystemSettings settings={settings} onChangeSettings={onChangeSettings} shortcutState={shortcutState} onNotice={onNotice} />
        </div>}
        <div className="settings-section" id="settings-section-interface" data-section="interface">
          <SettingsTitle icon={<Palette size={18} />} eyebrow="界面" title="选择让你感觉舒服的明暗" description="主题设置会立即应用到 CalendarMark 的所有界面。" />
          {!isAndroid && <div className="ui-mode-options">
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
          </div>}
          <div className="theme-options"><ThemeOption icon={<Sun size={18} />} title="浅色" description="干净明亮的纸张感" active={settings.theme === 'light'} onClick={() => update({ theme: 'light' })} /><ThemeOption icon={<Moon size={18} />} title="深色" description="夜间记录更舒适" active={settings.theme === 'dark'} onClick={() => update({ theme: 'dark' })} /><ThemeOption icon={<Monitor size={18} />} title="跟随系统" description="随系统自动切换" active={settings.theme === 'auto'} onClick={() => update({ theme: 'auto' })} /></div>
          {!isAndroid && <div className="preference-card"><div className="preference-row"><div className="preference-copy"><strong>启动时显示上次浏览的月份</strong><span>下次打开时保留你的浏览上下文</span></div><span className="toggle-switch toggle-switch--on"><span /></span></div><div className="preference-row"><div className="preference-copy"><strong>关闭窗口时保留在托盘</strong><span>点击右上角关闭只隐藏窗口，不退出应用</span></div><span className="toggle-switch toggle-switch--on"><span /></span></div></div>}
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

type NotionTestModalState = {
  status: 'loading' | 'success' | 'error'
  title: string
  message: string
  details?: string[]
}

type NotionSourceSettingsProps = {
  settings: AppSettings
  onChangeSettings: Dispatch<SetStateAction<AppSettings>>
  onNotice: (message: string) => void
  onReloadRemote?: () => void
}

function NotionSourceSettings({ settings, onChangeSettings, onNotice, onReloadRemote }: NotionSourceSettingsProps) {
  const [connection, setConnection] = useState<NotionConnectionInfo | null>(null)
  const [settingsConnection, setSettingsConnection] = useState<NotionSettingsConnectionInfo | null>(null)
  const [discoveredDatasets, setDiscoveredDatasets] = useState<NotionDatasetOption[]>([])
  const [discoveryAttempted, setDiscoveryAttempted] = useState(false)
  const [busy, setBusy] = useState<NotionBusyState>('idle')
  const [createOpen, setCreateOpen] = useState(false)
  const [createKind, setCreateKind] = useState<'date' | 'settings'>('date')
  const [parentPages, setParentPages] = useState<NotionPageOption[]>([])
  const [parentPageId, setParentPageId] = useState('')
  const [newDatabaseTitle, setNewDatabaseTitle] = useState('')
  const [testModal, setTestModal] = useState<NotionTestModalState | null>(null)
  const savedDatasets = settings.notionDatasets ?? []
  const dateTarget = getNotionTarget(settings)
  const settingsTarget = getNotionSettingsTarget(settings)
  const activeDatabaseId = dateTarget.databaseId
  const activeDataSourceId = dateTarget.dataSourceId
  const activeSettingsDatabaseId = settingsTarget.databaseId
  const activeSettingsDataSourceId = settingsTarget.dataSourceId
  const activeDatasetKey = activeDatabaseId ? notionDatasetKey({ databaseId: activeDatabaseId, dataSourceId: activeDataSourceId }) : ''
  const activeSettingsDatasetKey = activeSettingsDatabaseId ? notionDatasetKey({ databaseId: activeSettingsDatabaseId, dataSourceId: activeSettingsDataSourceId }) : ''
  const isConfigured = Boolean(settings.notionToken.trim() && activeDatabaseId)
  const isSettingsConfigured = Boolean(settings.notionToken.trim() && activeSettingsDatabaseId)
  const update = (partial: Partial<AppSettings>) => onChangeSettings((previous) => ({ ...previous, ...partial }))

  function rememberDataset(dataset: NotionDataset, role: 'date' | 'settings' = 'date') {
    onChangeSettings((previous) => withNotionDataset(previous, dataset, role))
  }

  function rememberConnection(info: NotionConnectionInfo) {
    rememberDataset({
      databaseId: info.databaseId,
      databaseTitle: info.databaseTitle,
      dataSourceId: info.dataSourceId,
      dataSourceName: info.dataSourceName,
    })
  }

  function rememberSettingsConnection(info: NotionSettingsConnectionInfo) {
    rememberDataset({
      databaseId: info.databaseId,
      databaseTitle: info.databaseTitle,
      dataSourceId: info.dataSourceId,
      dataSourceName: info.dataSourceName,
    }, 'settings')
  }

  async function handleDiscoverDatasets() {
    if (!settings.notionToken.trim()) {
      onNotice('请先填写 Integration Token，再发现可访问的数据集')
      return
    }
    setBusy('discovering')
    setDiscoveryAttempted(false)
    try {
      const result = await discoverNotionDatasets(settings.notionToken)
      setDiscoveredDatasets(result.datasets)
      setDiscoveryAttempted(true)
      onNotice(formatSyncNotice(`发现 ${result.datasets.length} 个可访问的数据集`, result.warnings))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('idle')
    }
  }

  function handleAddDataset(dataset: NotionDatasetOption, role: 'date' | 'settings') {
    const datasetKey = notionDatasetKey(dataset)
    if (role === 'date' && datasetKey === activeSettingsDatasetKey) {
      onNotice('这个数据库已是设置数据库；请为日期记录选择另一个数据库')
      return
    }
    if (role === 'settings' && datasetKey === activeDatasetKey) {
      onNotice('这个数据库已是日期数据库；请为标签设置选择另一个数据库')
      return
    }
    rememberDataset(dataset, role)
    setConnection(null)
    setSettingsConnection(null)
    onNotice(`已添加并设为${role === 'date' ? '日期' : '设置'}数据库：${dataset.databaseTitle} / ${dataset.dataSourceName}`)
  }

  function handleSelectDataset(dataset: NotionDataset) {
    if (notionDatasetKey(dataset) === activeSettingsDatasetKey) {
      onNotice('这个数据库已是设置数据库；请为日期记录选择另一个数据库')
      return
    }
    update({
      notionDatabaseId: dataset.databaseId,
      notionDataSourceId: dataset.dataSourceId,
    })
    setConnection(null)
    onNotice(`已切换日期数据库：${dataset.databaseTitle} / ${dataset.dataSourceName}`)
  }

  function handleSelectSettingsDataset(dataset: NotionDataset) {
    if (notionDatasetKey(dataset) === activeDatasetKey) {
      onNotice('这个数据库已是日期数据库；请为标签设置选择另一个数据库')
      return
    }
    update({
      notionSettingsDatabaseId: dataset.databaseId,
      notionSettingsDataSourceId: dataset.dataSourceId,
    })
    setSettingsConnection(null)
    onNotice(`已切换设置数据库：${dataset.databaseTitle} / ${dataset.dataSourceName}`)
  }

  function handleRemoveDataset(dataset: NotionDataset) {
    const nextDatasets = savedDatasets.filter((item) => notionDatasetKey(item) !== notionDatasetKey(dataset))
    const removingActive = notionDatasetKey(dataset) === activeDatasetKey
    const removingSettings = notionDatasetKey(dataset) === activeSettingsDatasetKey
    const nextDateDataset = removingActive
      ? nextDatasets.find((item) => notionDatasetKey(item) !== activeSettingsDatasetKey)
      : undefined
    update({
      notionDatasets: nextDatasets,
      ...(removingActive
        ? {
            notionDatabaseId: nextDateDataset?.databaseId ?? '',
            notionDataSourceId: nextDateDataset?.dataSourceId ?? '',
          }
        : {}),
      ...(removingSettings
        ? {
            notionSettingsDatabaseId: '',
            notionSettingsDataSourceId: '',
          }
        : {}),
    })
    setConnection(null)
    onNotice(`已从 CalendarMark 移除数据集「${dataset.dataSourceName}」（不会删除 Notion 内容）`)
  }

  async function handleCheckConnection() {
    if (!isConfigured) {
      onNotice('请先填写 Token，并选择日期数据库')
      return
    }
    setBusy('checking')
    try {
      const result = await checkNotionConnection(settings.notionToken, activeDatabaseId, activeDataSourceId)
      setConnection(result)
      rememberConnection(result)
      if (!isSettingsConfigured) {
        setSettingsConnection(null)
        onNotice(`Notion 日期数据库已连接：${result.dataSourceName}；还未选择设置数据库，标签暂不会保存到 Notion`)
        return
      }
      const settingsResult = await checkNotionSettingsConnection(
        settings.notionToken,
        activeSettingsDatabaseId,
        activeSettingsDataSourceId,
      )
      setSettingsConnection(settingsResult)
      rememberSettingsConnection(settingsResult)
      onNotice(`Notion 已连接：日期数据库 ${result.dataSourceName} · 设置数据库 ${settingsResult.dataSourceName}`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('idle')
    }
  }
  async function handleTestToken() {
    if (!settings.notionToken.trim()) {
      setTestModal({
        status: 'error',
        title: 'Token 测试失败',
        message: '请先填写 Integration Token，再测试。',
      })
      return
    }
    setTestModal({
      status: 'loading',
      title: '正在测试 Token',
      message: '正在使用当前 Token 访问 Notion API（/users/me）…',
    })
    try {
      const result = await testNotionToken(settings.notionToken)
      const details = [
        result.botName ? `连接名称：${result.botName}` : null,
        result.workspaceName ? `工作区：${result.workspaceName}` : null,
      ].filter((item): item is string => Boolean(item))
      setTestModal({
        status: 'success',
        title: 'Token 正常',
        message: 'Notion API 访问成功，Token 可以正常使用。',
        details,
      })
    } catch (error) {
      setTestModal({
        status: 'error',
        title: 'Token 测试失败',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function handleTestDataset() {
    if (!settings.notionToken.trim()) {
      setTestModal({
        status: 'error',
        title: '数据集测试失败',
        message: '请先填写 Integration Token，再测试数据集。',
      })
      return
    }
    if (!activeDatabaseId) {
      setTestModal({
        status: 'error',
        title: '数据集测试失败',
        message: '请先添加并选择一个日期数据库，再测试数据集。',
      })
      return
    }
    setTestModal({
      status: 'loading',
      title: '正在测试数据集',
      message: `正在访问 ${activeDatabaseId} 并读取 schema…`,
    })
    try {
      const result = await testNotionDataset(settings.notionToken, activeDatabaseId, activeDataSourceId)
      const mapping = result.mapping
      const details = [
        `数据库：${result.databaseTitle}`,
        `Data source：${result.dataSourceName}`,
        `标题字段：${mapping.titleProperty ?? '未识别'}`,
        `日期字段：${mapping.dateProperty ?? '未识别'}`,
        `正文字段：${mapping.contentProperty ?? '未配置'}`,
        `标签字段：${mapping.tagsProperty ?? '未配置'}`,
      ]
      if (mapping.ready) {
        setTestModal({
          status: 'success',
          title: '数据集访问正常',
          message: '已成功读取数据库和字段结构，可以用于日历同步。',
          details,
        })
      } else {
        setTestModal({
          status: 'error',
          title: '数据集可访问，但字段映射不完整',
          message: mapping.message ?? '数据库缺少 CalendarMark 需要的字段。',
          details,
        })
      }
    } catch (error) {
      setTestModal({
        status: 'error',
        title: '数据集测试失败',
        message: error instanceof Error ? error.message : String(error),
      })
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
      if (createKind === 'settings') {
        const result = await createNotionSettingsDatabase(settings.notionToken, parentPageId, newDatabaseTitle.trim())
        setSettingsConnection(result)
        rememberSettingsConnection(result)
      } else {
        const result = await createNotionDatabase(settings.notionToken, parentPageId, newDatabaseTitle.trim())
        setConnection(result)
        rememberConnection(result)
      }
      setCreateOpen(false)
      setNewDatabaseTitle('')
      onNotice(`已创建${createKind === 'settings' ? '设置' : '日期'}数据库「${newDatabaseTitle.trim()}」`)
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
        <input id="notion-token" className="settings-input" type="password" placeholder="secret_… 或 ntn_…" value={settings.notionToken} onChange={(event) => { update({ notionToken: event.target.value }); setConnection(null); setDiscoveredDatasets([]); setDiscoveryAttempted(false) }} />
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
          <div><strong>选择两个数据库</strong><span>日期数据库保存每天一条记录；设置数据库保存标签等设置</span></div>
          <div className="notion-dataset-actions">
            <button type="button" className="secondary-button" disabled={busy !== 'idle'} onClick={() => { void handleDiscoverDatasets() }}><Search size={14} />{busy === 'discovering' ? '正在发现…' : '发现数据集'}</button>
            <button type="button" className="secondary-button" disabled={busy !== 'idle'} onClick={() => { setCreateOpen((open) => !open); if (!createOpen && parentPages.length === 0) void handleSearchParentPages() }}><Plus size={14} />新建数据库</button>
          </div>
        </div>
        <div className="notion-config-summary">
          <span><b>Token</b>{settings.notionToken.trim() ? '已保存' : '未填写'}</span>
          <span>
            <b>日期数据库</b>
            {activeDatabaseId
              ? savedDatasets.find((item) => notionDatasetKey(item) === activeDatasetKey)?.databaseTitle ?? activeDatabaseId
              : '未选择'}
          </span>
          <span>
            <b>设置数据库</b>
            {activeSettingsDatabaseId
              ? savedDatasets.find((item) => notionDatasetKey(item) === activeSettingsDatasetKey)?.databaseTitle ?? activeSettingsDatabaseId
              : '未选择（标签不同步）'}
          </span>
        </div>
        {createOpen && <div className="notion-create-panel">
          <div className="notion-create-fields">
            <label className="field-label" htmlFor="notion-create-kind"><span>数据库用途</span><span className="field-hint">两种用途会创建不同的属性结构</span></label>
            <select id="notion-create-kind" className="settings-input" value={createKind} onChange={(event) => setCreateKind(event.target.value === 'settings' ? 'settings' : 'date')}>
              <option value="date">日期数据库 · 每天一条记录</option>
              <option value="settings">设置数据库 · 保存标签等设置</option>
            </select>
            <label className="field-label" htmlFor="notion-parent-page"><span>父页面</span><span className="field-hint">Notion API 要求新数据库必须创建在某个页面下</span></label>
            <div className="notion-parent-row">
              <select id="notion-parent-page" className="settings-input" value={parentPageId} disabled={parentPages.length === 0} onChange={(event) => setParentPageId(event.target.value)}>
                {parentPages.length === 0 && <option value="">暂无可用页面</option>}
                {parentPages.map((page) => <option key={page.pageId} value={page.pageId}>{page.title}</option>)}
              </select>
              <button type="button" className="secondary-button" disabled={busy !== 'idle'} onClick={() => { void handleSearchParentPages() }}><RefreshCw size={14} className={busy === 'searching-pages' ? 'spin' : ''} />刷新页面</button>
            </div>
            <label className="field-label" htmlFor="notion-new-database-title"><span>数据库名称</span><span className="field-hint">{createKind === 'date' ? '会自动创建 名称 / 日期 / 内容 / 标签 / 附件 属性' : '会自动创建 名称 / 标签 属性，标签以一条记录保存'}</span></label>
            <input id="notion-new-database-title" className="settings-input" placeholder={createKind === 'date' ? '例如：CalendarMark 日历' : '例如：CalendarMark 设置'} value={newDatabaseTitle} onChange={(event) => setNewDatabaseTitle(event.target.value)} />
          </div>
          <div className="notion-create-footer">
            <span className="field-hint">创建后会自动设为对应用途的数据库</span>
            <div className="notion-actions">
              <button type="button" className="text-button" onClick={() => setCreateOpen(false)}>取消</button>
              <button type="button" className="primary-button" disabled={busy !== 'idle' || !parentPageId || !newDatabaseTitle.trim()} onClick={() => { void handleCreateDatabase() }}>{busy === 'creating' ? '正在创建…' : '创建数据库'}</button>
            </div>
          </div>
        </div>}
        {savedDatasets.length > 0
          ? <div className="notion-dataset-list">{savedDatasets.map((dataset) => {
            const datasetKey = notionDatasetKey(dataset)
            const isDate = datasetKey === activeDatasetKey
            const isSettings = datasetKey === activeSettingsDatasetKey
            return <div className={'notion-dataset-option' + (isDate || isSettings ? ' notion-dataset-option--active' : '')} key={datasetKey}>
              <button type="button" className="notion-dataset-select" onClick={() => handleSelectDataset(dataset)}>
                <span className="notion-dataset-copy">
                  <strong>{dataset.databaseTitle}</strong>
                  <small>{dataset.dataSourceName}</small>
                  <code>{dataset.dataSourceId}</code>
                  <span className="notion-role-badges">
                    {isDate && <span className="notion-role-badge notion-role-badge--date">日期库</span>}
                    {isSettings && <span className="notion-role-badge notion-role-badge--settings">设置库</span>}
                  </span>
                </span>
              </button>
              <div className="notion-role-actions">
                <button type="button" className={isDate ? 'primary-button' : 'secondary-button'} disabled={busy !== 'idle' || isSettings} title={isSettings ? '不能与设置数据库相同' : undefined} onClick={() => handleSelectDataset(dataset)}>{isDate ? '日期库' : '设为日期库'}</button>
                <button type="button" className={isSettings ? 'primary-button' : 'secondary-button'} disabled={busy !== 'idle' || isDate} title={isDate ? '不能与日期数据库相同' : undefined} onClick={() => handleSelectSettingsDataset(dataset)}>{isSettings ? '设置库' : '设为设置库'}</button>
              </div>
              <button type="button" className="plain-icon-button" aria-label={'移除 ' + dataset.dataSourceName} title="从本机移除" onClick={() => handleRemoveDataset(dataset)}><Trash2 size={14} /></button>
            </div>
          })}</div>
          : <div className="notion-dataset-empty">还没有添加数据库。点击“发现数据集”读取当前 Token 已授权的 Notion 数据源。</div>}
        {settings.notionToken.trim() && activeDatabaseId && activeSettingsDatabaseId && sameNotionStore(settingsTarget, dateTarget) && <div className="notion-dataset-empty notion-dataset-empty--warn">设置库与日期库指向同一份数据（相同 data source）：日历读写不受影响，但标签设置不会写入 Notion。请把另一个数据源或数据库“设为设置库”。</div>}
        {settings.notionToken.trim() && activeDatabaseId && !activeSettingsDatabaseId && <div className="notion-dataset-empty notion-dataset-empty--warn">还差一步：请把任意数据集“设为设置数据库”，用于保存标签等数据；未选择前日历可正常读写。</div>}
        {discoveredDatasets.length > 0 && <div className="notion-discovered-panel">
          <div className="notion-discovered-heading"><strong>发现结果</strong><span>点击用途即添加到本机并启用，移除不会删除 Notion 内容</span></div>
          <div className="notion-discovered-list">{discoveredDatasets.map((dataset) => {
            const datasetKey = notionDatasetKey(dataset)
            const isDate = datasetKey === activeDatasetKey
            const isSettings = datasetKey === activeSettingsDatasetKey
            return <div className="notion-discovered-item" key={notionDatasetKey(dataset)}>
              <div className="notion-discovered-copy"><strong>{dataset.databaseTitle}</strong><small>{dataset.dataSourceName}</small></div>
              <div className="notion-role-actions">
                <button type="button" className={isDate ? 'primary-button' : 'secondary-button'} disabled={busy !== 'idle' || isSettings} title={isSettings ? '不能与设置数据库相同' : undefined} onClick={() => handleAddDataset(dataset, 'date')}>{isDate ? '日期库' : '设为日期库'}</button>
                <button type="button" className={isSettings ? 'primary-button' : 'secondary-button'} disabled={busy !== 'idle' || isDate} title={isDate ? '不能与日期数据库相同' : undefined} onClick={() => handleAddDataset(dataset, 'settings')}>{isSettings ? '设置库' : '设为设置库'}</button>
              </div>
            </div>
          })}</div>
        </div>}
        {discoveryAttempted && discoveredDatasets.length === 0 && <div className="notion-discovered-panel">
          <div className="notion-discovered-heading"><strong>没有发现可访问的数据集</strong><span>API 调用成功，但这个 Integration 还没有任何共享数据源</span></div>
          <div className="notion-dataset-empty">请到 Notion 打开目标数据库或其所在页面，点击「··· → Connections」选择这个 Integration。共享后回到这里再次点击「发现数据集」。</div>
        </div>}
      </div>
      {connection && connection.dataSources.length > 1 && <div className="notion-data-source-picker"><label className="field-label" htmlFor="notion-data-source"><span>当前 Database 的 data source</span><span className="field-hint">也可以从连接结果切换</span></label><select id="notion-data-source" className="settings-input" value={activeDataSourceId} onChange={(event) => { const source = connection.dataSources.find((item) => item.id === event.target.value); if (!source) return; rememberDataset({ databaseId: connection.databaseId, databaseTitle: connection.databaseTitle, dataSourceId: source.id, dataSourceName: source.name }); setConnection(null) }}>{connection.dataSources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></div>}
      {connection && <div className="notion-connection-panel"><div className="notion-connection-heading"><span><Check size={14} />已连接到 {connection.databaseTitle}</span><small>{connection.dataSourceName}</small></div><div className="notion-mapping-grid"><span>标题：{mapping?.titleProperty ?? '未识别'}</span><span>日期：{mapping?.dateProperty ?? '未识别'}</span><span>正文：{mapping?.contentProperty ?? '未配置'}</span><span>标签：{mapping?.tagsProperty ?? '未配置'}</span><span>附件：{mapping?.filesProperty ?? '未配置'}</span></div>{mapping && !mapping.ready && <div className="notion-mapping-error">{mapping.message}</div>}<div className="notion-schema-list">{connection.properties.map((property) => <span key={`${property.id}-${property.name}`}><b>{property.name}</b><small>{property.propertyType}</small></span>)}</div></div>}
      {settingsConnection && <div className="notion-connection-panel notion-connection-panel--settings"><div className="notion-connection-heading"><span><Check size={14} />设置数据库已连接：{settingsConnection.databaseTitle}</span><small>{settingsConnection.dataSourceName}</small></div><div className="notion-mapping-grid"><span>名称：{settingsConnection.mapping.nameProperty ?? '未识别'}</span><span>标签数据：{settingsConnection.mapping.dataProperty ?? '未识别'}</span></div>{!settingsConnection.mapping.ready && <div className="notion-mapping-error">{settingsConnection.mapping.message}</div>}<div className="notion-settings-note">标签保存在一条「CalendarMark 标签」记录里；只读取这条记录，不会加载或修改设置库中的其他内容。</div><div className="notion-schema-list">{settingsConnection.properties.map((property) => <span key={`${property.id}-${property.name}`}><b>{property.name}</b><small>{property.propertyType}</small></span>)}</div></div>}
      <div className="source-card-footer source-card-footer--notion"><span><RefreshCw size={15} className={busy !== 'idle' ? 'spin' : ''} />{busyLabel}</span><div className="notion-actions"><button type="button" className="secondary-button" disabled={busy !== 'idle'} onClick={() => { void handleTestToken() }}><KeyRound size={15} />测试 Token</button><button type="button" className="secondary-button" disabled={busy !== 'idle'} onClick={() => { void handleTestDataset() }}><Database size={15} />测试数据集</button><button type="button" className="secondary-button" disabled={busy !== 'idle'} onClick={() => { void handleCheckConnection() }}><RefreshCw size={15} />检查连接</button><button type="button" className="secondary-button" disabled={busy !== 'idle' || !isConfigured} onClick={() => onReloadRemote?.()}><RefreshCw size={15} />重新读取</button></div></div>
    </div>
    <div className="info-banner"><Sparkles size={16} /><span><strong>远程直连规则：</strong>日期数据库每个日期只维护一条记录，编辑会更新对应日期那一条，不会新增；标签定义保存在设置数据库。保存和删除直接写入 Notion，不落本机数据文件。Notion 侧有外部改动时，可点击“重新读取”。</span></div>
    {testModal && (
      <div className="notion-test-overlay" role="dialog" aria-modal="true" aria-label={testModal.title} onClick={(event) => { if (event.target === event.currentTarget) setTestModal(null) }}>
        <div className={'notion-test-modal' + (testModal.status === 'error' ? ' notion-test-modal--error' : testModal.status === 'success' ? ' notion-test-modal--success' : '')}>
          <div className="notion-test-icon">
            {testModal.status === 'loading'
              ? <RefreshCw size={22} className="spin" />
              : testModal.status === 'success'
                ? <Check size={22} />
                : <X size={22} />}
          </div>
          <h3>{testModal.title}</h3>
          <p>{testModal.message}</p>
          {testModal.details && testModal.details.length > 0 && (
            <ul className="notion-test-details">
              {testModal.details.map((item) => <li key={item}>{item}</li>)}
            </ul>
          )}
          <div className="notion-test-actions">
            <button type="button" className="primary-button" onClick={() => setTestModal(null)}>知道了</button>
          </div>
        </div>
      </div>
    )}
  </>
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
  const [busySync, setBusySync] = useState<{ targetId: string; direction: RemoteSyncDirection } | null>(null)
  const remoteTargets = createRemoteSyncTargets(settings, {
    activateNotionDataset: (dataset) => onChangeSettings((previous) => ({
      ...previous,
      notionDatabaseId: dataset.databaseId,
      notionDataSourceId: dataset.dataSourceId,
    })),
    configureNotion: onSelectNotion,
  })
  const configuredCount = remoteTargets.filter((target) => target.configured).length

  function isBusy(target: RemoteSyncTarget, direction: RemoteSyncDirection): boolean {
    return busySync?.targetId === target.id && busySync.direction === direction
  }


  function anyBusy(): boolean {
    return busySync !== null
  }

  async function handleRemoteSync(target: RemoteSyncTarget, direction: RemoteSyncDirection) {
    if (!target.configured) {
      onNotice(`请先完成 ${target.label} 的配置：${target.requirement}`)
      target.configure?.()
      return
    }
    setBusySync({ targetId: target.id, direction })
    try {
      if (direction === 'pull') {
        const result = await target.pullToLocal(entries, tags)
        onChangeTags(result.tags)
        onChangeEntries(result.entries)
        onNotice(formatSyncNotice(`已从 ${target.label} 拉取 ${result.pulledCount} 条记录到本地`, result.warnings))
      } else {
        const result = await target.pushFromLocal(entries, tags)
        onChangeEntries(result.entries)
        if (result.tags) onChangeTags(result.tags)
        onNotice(formatSyncNotice(`已推送 ${result.pushedCount} 条本地记录到 ${target.label}`, result.warnings))
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusySync(null)
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
        <div className="source-card-top"><div className="source-placeholder-icon"><Cloud size={18} /></div><div><strong>已绑定的远程数据源</strong><span>每个远程目标都支持拉取到本地和推送本地记录</span></div><span className="connection-badge"><span className={`status-dot ${configuredCount ? 'status-dot--ready' : 'status-dot--muted'}`} />{configuredCount ? `${configuredCount} 个可用` : '未绑定'}</span></div>
        <div className="source-divider" />
        {remoteTargets.length > 0
          ? <div className="remote-sync-target-list">
            {remoteTargets.map((target) => (
              <div className={'remote-sync-target' + (target.active ? ' remote-sync-target--active' : '')} key={target.id}>
                <button
                  type="button"
                  className="remote-sync-target-select"
                  onClick={target.activate}
                  disabled={!target.activate}
                  aria-current={target.active ? 'true' : undefined}
                >
                  <span className="remote-sync-provider">{target.provider === 'notion' ? 'N' : 'Q'}</span>
                  <span className="remote-sync-copy">
                    <strong>{target.label}</strong>
                    <small>{target.detail}</small>
                  </span>
                  {target.active && <span className="remote-sync-current">当前</span>}
                </button>
                <div className="remote-sync-actions">
                  <button type="button" className="secondary-button" disabled={anyBusy()} onClick={() => { void handleRemoteSync(target, 'pull') }}>
                    <ArrowLeft size={15} className={isBusy(target, 'pull') ? 'spin' : ''} />
                    {isBusy(target, 'pull') ? '正在拉取…' : '拉取到本地'}
                  </button>
                  <button type="button" className="primary-button" disabled={anyBusy()} onClick={() => { void handleRemoteSync(target, 'push') }}>
                    <Cloud size={15} className={isBusy(target, 'push') ? 'spin' : ''} />
                    {isBusy(target, 'push') ? '正在推送…' : '推送到远程'}
                  </button>
                </div>
                {!target.configured && <div className="remote-sync-requirement">{target.requirement}</div>}
              </div>
            ))}
          </div>
          : <div className="local-sync-empty">
          <div><strong>还没有绑定远程数据源</strong><span>绑定 Notion 数据集后，这里会显示可同步目标。</span></div>
          <div className="local-sync-actions">
            <button type="button" className="secondary-button" onClick={onSelectNotion}><Database size={15} />配置 Notion</button>
          </div>
        </div>}
      </div>
    </div>
    <div className="info-banner"><Sparkles size={16} /><span><strong>本地同步规则：</strong>CalendarMark 当前以本地记录为主；列表中的每个远程目标都可以拉取到本地，也可以把本地记录推送到该远程。想让每次编辑直接写远程？切换到对应数据源即可。</span></div>
  </>
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

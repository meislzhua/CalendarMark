import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, Dispatch, FormEvent, ReactNode, SetStateAction } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Cloud,
  Command,
  Database,
  FileImage,
  FileText,
  ExternalLink,
  HardDrive,
  Hash,
  KeyRound,
  Keyboard,
  Layers3,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelRightClose,
  Palette,
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
  Zap,
} from 'lucide-react'
import './App.css'
import {
  DATA_SOURCE_DEFINITIONS,
  DEFAULT_SETTINGS,
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
  isDesktopTauriRuntime,
  listenForSettingsOpen,
  registerGlobalShortcut,
  showMainWindow,
} from './tauri'
import {
  archiveNotionPage,
  checkNotionConnection,
  discoverNotionDatasets,
  pullNotionEntries,
  pushNotionEntries,
} from './notion'
import type {
  NotionConnectionInfo,
  NotionDatasetOption,
  NotionEntryRecord,
  NotionPushResult,
} from './notion'

type View = 'calendar' | 'settings'
type SettingsSection = 'source' | 'shortcut' | 'interface' | 'tags'

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
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [entries, setEntries] = useState<CalendarEntry[]>(() => settings.dataSource === 'notion' ? [] : loadEntries())
  const [tags, setTags] = useState<Tag[]>(() => settings.dataSource === 'notion' ? [] : loadTags())
  const [draft, setDraft] = useState<CalendarEntry>(() => createDraft(today))
  const [newTagName, setNewTagName] = useState('')
  const [shortcutState, setShortcutState] = useState<'ready' | 'browser' | 'error'>('browser')
  const [notice, setNotice] = useState('')
  const [remoteDataState, setRemoteDataState] = useState<RemoteDataState>(settings.dataSource === 'notion' ? 'needs-config' : 'local')
  const previousDataSourceRef = useRef<AppSettings['dataSource'] | null>(null)
  const previousNotionTargetRef = useRef<string | null>(null)
  const [remoteReloadToken, setRemoteReloadToken] = useState(0)
  const skipLocalSaveRef = useRef(false)
  const notionTarget = getNotionTarget(settings)
  const notionTargetKey = `${notionTarget.databaseId}:${notionTarget.dataSourceId}`

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

    if (settings.dataSource !== 'notion') {
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
    const targetChanged = previousNotionTargetRef.current !== notionTargetKey
    previousNotionTargetRef.current = notionTargetKey
    if (sourceChanged || targetChanged) {
      setEntries([])
      setTags([])
    }
  }, [settings.dataSource, notionTargetKey])

  useEffect(() => {
    if (settings.dataSource !== 'notion') return undefined
    if (!settings.notionToken.trim() || !notionTarget.databaseId) {
      setRemoteDataState('needs-config')
      return undefined
    }

    let cancelled = false
    setRemoteDataState('loading')
    // Token 逐字符输入、数据集信息被连接结果规范化时都会重新触发本 effect；
    // 用短防抖合并连续变化，避免每个按键都发起一次远端请求。
    const timer = window.setTimeout(() => {
      if (cancelled) return
      void pullNotionEntries(settings.notionToken, notionTarget.databaseId, notionTarget.dataSourceId)
        .then((result) => {
          if (cancelled) return
          const merged = mergeNotionEntries(result.entries, [], [])
          setEntries(merged.entries)
          setTags(merged.tags)
          setSettings((previous) => withNotionDataset(previous, {
            databaseId: result.connection.databaseId,
            databaseTitle: result.connection.databaseTitle,
            dataSourceId: result.connection.dataSourceId,
            dataSourceName: result.connection.dataSourceName,
          }))
          setRemoteDataState('ready')
          setNotice('已读取 Notion：' + result.entries.length + ' 条记录' + (result.warnings.length ? '；' + result.warnings.slice(0, 2).join('；') : ''))
        })
        .catch((error) => {
          if (cancelled) return
          setRemoteDataState('error')
          setNotice(error instanceof Error ? error.message : String(error))
        })
    }, 500)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [settings.dataSource, settings.notionToken, notionTarget.databaseId, notionTarget.dataSourceId, remoteReloadToken])

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

  useEffect(() => {
    let cancelled = false
    void registerGlobalShortcut(settings.shortcut, () => {
      setView('calendar')
      setDrawerOpen(false)
      void showMainWindow()
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
      setDrawerOpen(false)
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

  const tagById = (tagId: string) => tags.find((tag) => tag.id === tagId)

  function openDate(dateKey: string) {
    const existing = entries.find((entry) => entry.date === dateKey)
    setDraft(existing ? { ...existing, tagIds: [...existing.tagIds], attachments: [...existing.attachments] } : createDraft(dateKey))
    setSelectedDate(dateKey)
    setView('calendar')
    setDrawerOpen(true)
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

    if (settings.dataSource === 'notion') {
      if (remoteDataState === 'loading') {
        setNotice('正在读取 Notion 数据，请稍候再保存')
        return
      }
      const target = getNotionTarget(settings)
      if (!settings.notionToken.trim() || !target.databaseId) {
        setNotice('请先在设置中配置 Notion Token 并添加数据集')
        return
      }
      setRemoteDataState('saving')
      try {
        const result = await pushNotionEntries(
          settings.notionToken,
          target.databaseId,
          target.dataSourceId || undefined,
          [toNotionEntryInput(cleaned, tags, target.dataSourceId || undefined)],
        )
        const savedEntry = applyPushResultToEntry(cleaned, result)
        setEntries((previous) => {
          const index = previous.findIndex((entry) => entry.id === savedEntry.id)
          if (index === -1) return [...previous, savedEntry]
          const next = [...previous]
          next[index] = savedEntry
          return next
        })
        setSettings((previous) => withNotionDataset(previous, {
          databaseId: result.connection.databaseId,
          databaseTitle: result.connection.databaseTitle,
          dataSourceId: result.connection.dataSourceId,
          dataSourceName: result.connection.dataSourceName,
        }))
        setRemoteDataState('ready')
        setDrawerOpen(false)
        setNotice(formatSyncNotice('已直接保存到 Notion', result.warnings))
      } catch (error) {
        setRemoteDataState('error')
        setNotice(error instanceof Error ? error.message : String(error))
      }
      return
    }

    setEntries((previous) => {
      const index = previous.findIndex((entry) => entry.id === cleaned.id)
      if (index === -1) return [...previous, cleaned]
      const next = [...previous]
      next[index] = cleaned
      return next
    })
    setDrawerOpen(false)
    setNotice('日期内容已保存')
  }

  async function handleDeleteEntry() {
    const existing = entries.find((entry) => entry.id === draft.id)
    if (!existing) return
    if (settings.dataSource === 'notion' && existing.remote?.provider === 'notion') {
      const target = getNotionTarget(settings)
      if (!settings.notionToken.trim() || !target.databaseId) {
        setNotice('删除 Notion 记录前，请先补全连接配置')
        return
      }
      setRemoteDataState('deleting')
      try {
        setNotice('正在从 Notion 归档记录…')
        await archiveNotionPage(settings.notionToken, existing.remote.id)
      } catch (error) {
        setRemoteDataState('error')
        setNotice(error instanceof Error ? error.message : String(error))
        return
      }
      setRemoteDataState('ready')
    }
    setEntries((previous) => previous.filter((entry) => entry.id !== draft.id))
    setDrawerOpen(false)
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

  async function deleteTag(tagId: string) {
    const nextTags = tags.filter((tag) => tag.id !== tagId)
    const changedEntries = entries
      .filter((entry) => entry.tagIds.includes(tagId))
      .map((entry) => ({ ...entry, tagIds: entry.tagIds.filter((id) => id !== tagId) }))

    if (settings.dataSource === 'notion' && changedEntries.length > 0) {
      const target = getNotionTarget(settings)
      if (!settings.notionToken.trim() || !target.databaseId) {
        setNotice('请先在设置中配置 Notion Token 并添加数据集')
        return
      }

      // 远程直连模式先写远端，成功后再更新界面状态，失败时保持与远端一致。
      setRemoteDataState('saving')
      try {
        const result = await pushNotionEntries(
          settings.notionToken,
          target.databaseId,
          target.dataSourceId || undefined,
          changedEntries.map((entry) => toNotionEntryInput(entry, nextTags, target.dataSourceId || undefined)),
        )
        const pushedByLocalId = new Map(result.entries.map((entry) => [entry.localId, entry]))
        setEntries((previous) => previous.map((entry) => {
          const pushed = pushedByLocalId.get(entry.id)
          return pushed ? applyPushResultToEntry(entry, { ...result, entries: [pushed] }) : entry
        }))
        setSettings((previous) => withNotionDataset(previous, {
          databaseId: result.connection.databaseId,
          databaseTitle: result.connection.databaseTitle,
          dataSourceId: result.connection.dataSourceId,
          dataSourceName: result.connection.dataSourceName,
        }))
        setRemoteDataState('ready')
        setNotice(formatSyncNotice('标签已从 Notion 记录中移除', result.warnings))
      } catch (error) {
        setRemoteDataState('error')
        setNotice(error instanceof Error ? error.message : String(error))
        return
      }
    } else {
      setTags(nextTags)
      setNotice('标签已删除')
    }

    setEntries((previous) => previous.map((entry) => ({
      ...entry,
      tagIds: entry.tagIds.filter((id) => id !== tagId),
    })))
    setTags(nextTags)
    setDraft((previous) => ({ ...previous, tagIds: previous.tagIds.filter((id) => id !== tagId) }))
  }

  const isCurrentMonthToday = today.slice(0, 7) === toDateKey(currentMonth).slice(0, 7)
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
    <div className="app-shell">
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
          {tags.slice(0, 4).map((tag) => (
            <button key={tag.id} className="quick-link" onClick={() => openDate(selectedDate)}>
              <span className={`tag-dot tag-dot--${tag.color}`} />
              <span>{tag.name}</span>
              <span className="quick-link-count">{entries.filter((entry) => entry.tagIds.includes(tag.id)).length}</span>
            </button>
          ))}
          <button className="quick-link quick-link--muted" onClick={() => { setView('settings'); setSettingsSection('tags') }}>
            <Plus size={15} />
            <span>管理标签</span>
          </button>
        </div>

        <div className="sidebar-footer">
          <div className="shortcut-hint">
            <div className="shortcut-hint-icon"><Zap size={15} /></div>
            <div>
              <span>快速打开</span>
              <kbd>{settings.shortcut.replace('CommandOrControl', 'Ctrl')}</kbd>
            </div>
          </div>
          <div className="data-source-mini">
            <span className={'status-dot ' + (settings.dataSource === 'notion' ? 'status-dot--ready' : '')} />
            <span>{settings.dataSource === 'notion' ? 'Notion 远程数据' : '本地数据'}</span>
            <span className="data-source-divider">·</span>
            <span>{settings.dataSource === 'notion' ? remoteStatusText : '可按需同步 Notion'}</span>
          </div>
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
                <h2>{monthTitle}</h2>
                <button className="plain-icon-button" aria-label="下个月" onClick={() => moveMonth(1)}><ChevronRight size={18} /></button>
              </div>
              <div className="calendar-toolbar-actions">
                <button className="text-button" onClick={() => setCurrentMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}><ArrowLeft size={15} />回到今天</button>
                <button className="primary-button" onClick={() => openDate(today)}><Plus size={16} />记录今天</button>
              </div>
            </section>

            <section className="overview-grid">
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
                    const isToday = cell.dateKey === today
                    const isSelected = cell.dateKey === selectedDate && drawerOpen
                    return (
                      <button type="button" key={cell.dateKey} className={`calendar-day ${cell.isCurrentMonth ? '' : 'calendar-day--outside'} ${isToday ? 'calendar-day--today' : ''} ${isSelected ? 'calendar-day--selected' : ''}`} onClick={() => openDate(cell.dateKey)}>
                        <div className="day-number-row"><span className="day-number">{cell.date.getDate()}</span>{dayEntries.length > 0 && <span className="entry-count">{dayEntries.length}</span>}</div>
                        <div className="day-tags">{dayTags.slice(0, 2).map((tag) => <span key={tag.id} className={`calendar-tag calendar-tag--${tag.color}`}>{tag.name}</span>)}{dayTags.length > 2 && <span className="more-tag">+{dayTags.length - 2}</span>}</div>
                        {dayEntries.some((entry) => entry.attachments.length > 0) && <span className="attachment-indicator"><FileImage size={12} /></span>}
                      </button>
                    )
                  })}
                </div>
              </div>

              <aside className="month-insight">
                <div className="insight-card insight-card--highlight">
                  <div className="insight-topline"><Sparkles size={15} /><span>本月概览</span><MoreHorizontal size={17} /></div>
                  <div className="insight-number">{currentMonthEntries.length}<span>条记录</span></div>
                  <p>每一个小小的标记，都在帮你找回生活的脉络。</p>
                  <div className="progress-track"><span style={{ width: `${Math.min(100, currentMonthEntries.length * 12 + 8)}%` }} /></div>
                  <div className="progress-caption"><span>记录节奏</span><strong>{isCurrentMonthToday ? '进行中' : '已归档'}</strong></div>
                </div>
                <div className="insight-card">
                  <div className="insight-topline"><Layers3 size={15} /><span>最近更新</span><button className="card-link" onClick={() => currentMonthEntries[0] && openDate(currentMonthEntries[0].date)}>查看全部 <ArrowRight size={13} /></button></div>
                  <div className="recent-list">
                    {currentMonthEntries.slice(0, 3).map((entry) => <button key={entry.id} className="recent-item" onClick={() => openDate(entry.date)}><span className="recent-date">{fromDateKey(entry.date).getDate()}</span><span className="recent-copy"><strong>{entry.title || '未命名记录'}</strong><small>{formatDateKey(entry.date, { month: 'short', day: 'numeric' })}</small></span><ChevronRight size={14} /></button>)}
                    {currentMonthEntries.length === 0 && <div className="empty-recent">这个月还没有记录，写下第一笔吧。</div>}
                  </div>
                </div>
                <div className="insight-card insight-card--tip"><div className="tip-icon"><Command size={16} /></div><div><strong>一个小提示</strong><p>按下快捷键，随时记下脑海里闪过的念头。</p></div></div>
              </aside>
            </section>
          </>
        ) : (
          <SettingsView settings={settings} settingsSection={settingsSection} setSettingsSection={setSettingsSection} onChangeSettings={setSettings} entries={entries} onChangeEntries={setEntries} tags={tags} onChangeTags={setTags} onAddTag={(name) => addTag(name)} onDeleteTag={deleteTag} shortcutState={shortcutState} onNotice={setNotice} onReloadRemote={() => setRemoteReloadToken((token) => token + 1)} />
        )}
      </main>

      {view === 'calendar' && <>
        <div className={`drawer-backdrop ${drawerOpen ? 'drawer-backdrop--visible' : ''}`} onClick={() => setDrawerOpen(false)} />
        <aside className={`editor-drawer ${drawerOpen ? 'editor-drawer--open' : ''}`} aria-hidden={!drawerOpen}>
          <form className="editor-form" onSubmit={handleSaveEntry}>
            <div className="drawer-header"><div><span className="eyebrow">日期记录</span><h2>{formatDateKey(selectedDate)}</h2></div><button type="button" className="icon-button" aria-label="关闭抽屉" onClick={() => setDrawerOpen(false)}><PanelRightClose size={18} /></button></div>
            <div className="drawer-scroll">
              <label className="field-label" htmlFor="entry-title">标题</label>
              <input id="entry-title" className="title-input" placeholder="今天发生了什么？" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              <label className="field-label" htmlFor="entry-content">内容</label>
              <textarea id="entry-content" className="content-textarea" placeholder="写下细节、想法或下一步行动……" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} rows={7} />
              <div className="field-label field-label--row"><span>快捷标签</span><span className="field-hint">点击即可切换</span></div>
              <div className="tag-picker">{tags.map((tag) => <button type="button" key={tag.id} className={`tag-choice tag-choice--${tag.color} ${draft.tagIds.includes(tag.id) ? 'tag-choice--active' : ''}`} onClick={() => toggleDraftTag(tag.id)}><span className="tag-dot" />{tag.name}{draft.tagIds.includes(tag.id) && <Check size={13} />}</button>)}</div>
              <div className="inline-add-tag"><input aria-label="新标签名称" placeholder="添加新标签" value={newTagName} onChange={(event) => setNewTagName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); handleAddTagFromDrawer() } }} /><button type="button" aria-label="添加标签" onClick={handleAddTagFromDrawer}><Plus size={15} /></button></div>
              <div className="field-label field-label--row"><span>附件</span><span className="field-hint">图片或文档，单个 ≤ 5 MB</span></div>
              <label className="upload-zone"><Upload size={18} /><span><strong>拖拽或选择文件</strong><small>支持图片、TXT、Markdown、PDF</small></span><input type="file" multiple accept="image/*,.txt,.md,.pdf" onChange={handleFiles} /></label>
              {draft.attachments.length > 0 && <div className="attachment-list">{draft.attachments.map((attachment) => <AttachmentItem key={attachment.id} attachment={attachment} onRemove={() => setDraft((previous) => ({ ...previous, attachments: previous.attachments.filter((item) => item.id !== attachment.id) }))} />)}</div>}
            </div>
            <div className="drawer-footer">{entries.some((entry) => entry.id === draft.id) && <button type="button" className="danger-button" disabled={remoteDataState === 'deleting'} onClick={() => { void handleDeleteEntry() }}><Trash2 size={15} />删除</button>}<div className="drawer-footer-actions"><button type="button" className="secondary-button" onClick={() => setDrawerOpen(false)}>取消</button><button type="submit" className="primary-button" disabled={remoteDataState === 'saving'}><Save size={15} />{settings.dataSource === 'notion' ? '保存到 Notion' : '保存记录'}</button></div></div>
          </form>
        </aside>
      </>}

      {notice && <div className="toast" role="status"><Check size={15} />{notice}</div>}
    </div>
  )
}

function AttachmentItem({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const isImage = attachment.mimeType.startsWith('image/')
  const previewUrl = attachment.dataUrl || attachment.sourceUrl
  return <div className="attachment-item">{isImage && previewUrl ? <img src={previewUrl} alt={attachment.name} /> : <div className="attachment-file-icon"><FileText size={17} /></div>}<div className="attachment-copy"><strong title={attachment.name}>{attachment.name}</strong><small>{attachment.size > 0 ? formatBytes(attachment.size) : 'Notion 远程附件'}</small></div><button type="button" className="plain-icon-button" aria-label={`移除 ${attachment.name}`} onClick={onRemove}><X size={14} /></button></div>
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
  shortcutState: 'ready' | 'browser' | 'error'
  onNotice: (message: string) => void
  onReloadRemote: () => void
}

function SettingsView({ settings, settingsSection, setSettingsSection, onChangeSettings, entries, onChangeEntries, tags, onChangeTags, onAddTag, onDeleteTag, shortcutState, onNotice, onReloadRemote }: SettingsViewProps) {
  const [newTag, setNewTag] = useState('')
  const sections: { id: SettingsSection; label: string; description: string; icon: typeof Database }[] = [
    { id: 'source', label: '数据源', description: '选择数据来源', icon: Database },
    { id: 'shortcut', label: '快捷键', description: '随时打开窗口', icon: Keyboard },
    { id: 'interface', label: '界面', description: '调整显示方式', icon: Palette },
    { id: 'tags', label: '标签管理', description: '整理你的分类', icon: TagIcon },
  ]
  const update = (partial: Partial<AppSettings>) => onChangeSettings((previous) => ({ ...previous, ...partial }))
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
        {sections.map(({ id, label, description, icon: Icon }) => <button key={id} className={settingsSection === id ? 'settings-nav-item active' : 'settings-nav-item'} onClick={() => setSettingsSection(id)}><span className="settings-nav-icon"><Icon size={17} /></span><span><strong>{label}</strong><small>{description}</small></span><ChevronRight size={15} /></button>)}
        <div className="settings-nav-note"><CircleHelp size={15} /><span>数据源可以替换；外部连接凭据只保存在本机，不会上传到 CalendarMark 服务。</span></div>
      </nav>
      <section className="settings-content">
        {settingsSection === 'source' && <DataSourceSettings settings={settings} onChangeSettings={onChangeSettings} entries={entries} onChangeEntries={onChangeEntries} tags={tags} onChangeTags={onChangeTags} onNotice={onNotice} onReloadRemote={onReloadRemote} />}
        {settingsSection === 'shortcut' && <><SettingsTitle icon={<Keyboard size={18} />} eyebrow="快捷键" title="不用打断思路，就能打开记录窗口" description="桌面版会在启动时注册全局快捷键；浏览器预览不会抢占系统快捷键。" /><div className="preference-card"><div className="preference-row"><div className="preference-copy"><strong>打开 CalendarMark</strong><span>建议使用不容易和其他软件冲突的组合键</span></div><div className="shortcut-input-wrap"><Command size={15} /><input aria-label="全局快捷键" value={settings.shortcut} onChange={(event) => update({ shortcut: event.target.value })} /></div></div><div className="preference-row preference-row--subtle"><span className="connection-badge connection-badge--plain"><span className={`status-dot ${shortcutState === 'error' ? 'status-dot--error' : ''}`} />{shortcutState === 'ready' ? '桌面快捷键已注册' : shortcutState === 'error' ? '快捷键注册失败，请更换组合' : '浏览器预览模式'}</span><button className="text-button" onClick={() => update({ shortcut: DEFAULT_SETTINGS.shortcut })}>恢复默认</button></div></div><div className="shortcut-preview"><div className="shortcut-preview-icon"><Zap size={18} /></div><div><strong>快速记录的节奏</strong><p>按下快捷键后，CalendarMark 会显示主窗口；再点击某一天即可打开右侧记录抽屉。</p></div><kbd>{settings.shortcut.replace('CommandOrControl', 'Ctrl')}</kbd></div></>}
        {settingsSection === 'interface' && <><SettingsTitle icon={<Palette size={18} />} eyebrow="界面" title="选择让你感觉舒服的明暗" description="主题设置会立即应用到 CalendarMark 的所有界面。" /><div className="theme-options"><ThemeOption icon={<Sun size={18} />} title="浅色" description="干净明亮的纸张感" active={settings.theme === 'light'} onClick={() => update({ theme: 'light' })} /><ThemeOption icon={<Moon size={18} />} title="深色" description="夜间记录更舒适" active={settings.theme === 'dark'} onClick={() => update({ theme: 'dark' })} /><ThemeOption icon={<Monitor size={18} />} title="跟随系统" description="随系统自动切换" active={settings.theme === 'auto'} onClick={() => update({ theme: 'auto' })} /></div><div className="preference-card"><div className="preference-row"><div className="preference-copy"><strong>启动时显示上次浏览的月份</strong><span>下次打开时保留你的浏览上下文</span></div><span className="toggle-switch toggle-switch--on"><span /></span></div><div className="preference-row"><div className="preference-copy"><strong>关闭窗口时保留在托盘</strong><span>点击右上角关闭只隐藏窗口，不退出应用</span></div><span className="toggle-switch toggle-switch--on"><span /></span></div></div></>}
        {settingsSection === 'tags' && <><SettingsTitle icon={<TagIcon size={18} />} eyebrow="标签管理" title="让标签替你整理生活的纹理" description="快捷标签会显示在日历格子和记录抽屉里。" /><div className="tag-manager-card"><div className="tag-manager-header"><div><strong>我的标签</strong><span>{tags.length} 个标签</span></div><form className="tag-add-form" onSubmit={submitTag}><input aria-label="标签名称" placeholder="输入新标签" value={newTag} onChange={(event) => setNewTag(event.target.value)} /><button type="submit" aria-label="添加标签"><Plus size={16} /></button></form></div><div className="managed-tags">{tags.map((tag) => <div className="managed-tag" key={tag.id}><span className={`tag-dot tag-dot--${tag.color}`} /><span>{tag.name}</span><span className="managed-tag-count">快捷标签</span><button className="plain-icon-button" aria-label={`删除 ${tag.name}`} onClick={() => onDeleteTag(tag.id)}><Trash2 size={14} /></button></div>)}</div></div><div className="info-banner info-banner--warm"><Hash size={16} /><span>小建议：保持标签在 3–8 个之间，日历会更清晰，也更容易回顾。</span></div></>}
      </section>
    </div>
  </div>
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
    {selectedSource.id === 'notion' && <NotionSourceSettings mode="direct" settings={settings} onChangeSettings={onChangeSettings} entries={entries} onChangeEntries={onChangeEntries} tags={tags} onChangeTags={onChangeTags} onNotice={onNotice} onReloadRemote={onReloadRemote} />}
    {selectedSource.id === 'local' && <LocalSourceSettings settings={settings} onChangeSettings={onChangeSettings} entries={entries} onChangeEntries={onChangeEntries} tags={tags} onChangeTags={onChangeTags} onNotice={onNotice} onSelectNotion={() => update({ dataSource: 'notion' })} />}
    {selectedSource.status === 'planned' && <PlannedSourceSettings sourceId={selectedSource.id} />}
  </>
}

function DataSourceIcon({ id }: { id: DataSourceId }) {
  if (id === 'local') return <HardDrive size={17} />
  if (id === 'webdav') return <Cloud size={17} />
  if (id === 'obsidian') return <BookOpen size={17} />
  return <Database size={17} />
}

type NotionBusyState = 'idle' | 'discovering' | 'checking' | 'pulling' | 'pushing'
type NotionSourceMode = 'direct' | 'local-sync'

type NotionSourceSettingsProps = {
  mode: NotionSourceMode
  settings: AppSettings
  onChangeSettings: Dispatch<SetStateAction<AppSettings>>
  entries: CalendarEntry[]
  onChangeEntries: (entries: CalendarEntry[]) => void
  tags: Tag[]
  onChangeTags: (tags: Tag[]) => void
  onNotice: (message: string) => void
  onReloadRemote?: () => void
}

function NotionSourceSettings({ mode, settings, onChangeSettings, entries, onChangeEntries, tags, onChangeTags, onNotice, onReloadRemote }: NotionSourceSettingsProps) {
  const [connection, setConnection] = useState<NotionConnectionInfo | null>(null)
  const [discoveredDatasets, setDiscoveredDatasets] = useState<NotionDatasetOption[]>([])
  const [busy, setBusy] = useState<NotionBusyState>('idle')
  const isDirectMode = mode === 'direct'
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

  async function handlePull() {
    if (!isConfigured) {
      onNotice('请先填写 Token，点击“发现数据集”并添加一个数据集')
      return
    }
    setBusy('pulling')
    try {
      const result = await pullNotionEntries(settings.notionToken, activeDatabaseId, activeDataSourceId)
      const merged = mergeNotionEntries(result.entries, entries, tags)
      onChangeTags(merged.tags)
      onChangeEntries(merged.entries)
      setConnection(result.connection)
      rememberConnection(result.connection)
      onNotice(formatSyncNotice(isDirectMode ? `已读取 Notion ${result.entries.length} 条记录` : `已从 Notion 拉取 ${result.entries.length} 条记录到本地`, result.warnings))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('idle')
    }
  }

  async function handlePush() {
    if (!isConfigured) {
      onNotice('请先填写 Token，点击“发现数据集”并添加一个数据集')
      return
    }
    setBusy('pushing')
    try {
      const result = await pushNotionEntries(
        settings.notionToken,
        activeDatabaseId,
        activeDataSourceId || undefined,
        entries.map((entry) => toNotionEntryInput(entry, tags, activeDataSourceId || undefined)),
      )
      applyPushResult(result, onChangeEntries, entries)
      setConnection(result.connection)
      rememberConnection(result.connection)
      onNotice(formatSyncNotice(`已推送 ${result.entries.length} 条本地记录到 Notion`, result.warnings))
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
      : busy === 'pulling'
        ? '正在从 Notion 拉取…'
        : busy === 'pushing'
          ? '正在推送本地记录…'
          : isDirectMode
            ? '远程直连：编辑后自动保存'
            : '连接状态：未检查'
  const mapping = connection?.mapping

  return <>
    <div className="source-card source-card--notion">
      <div className="source-card-top"><div className="notion-logo">N</div><div><strong>Notion</strong><span>{isDirectMode ? '远程数据源 · 读取和写入均直接访问 Notion' : '本地数据源 · 可按需与 Notion 双向同步'}</span></div><span className="connection-badge"><span className={`status-dot ${connection ? 'status-dot--ready' : 'status-dot--muted'}`} />{connection ? '已连接' : isDirectMode && isConfigured ? '自动同步' : isConfigured ? '待检查' : '待配置'}</span></div>
      <div className="source-divider" />
      <div className="source-fields">
        <label className="field-label" htmlFor="notion-token"><span>Integration Token</span><span className="field-hint"><KeyRound size={12} />仅保存在本机</span></label>
        <input id="notion-token" className="settings-input" type="password" placeholder="secret_… 或 ntn_…" value={settings.notionToken} onChange={(event) => { update({ notionToken: event.target.value }); setConnection(null); setDiscoveredDatasets([]) }} />
      </div>
      <div className="notion-dataset-manager">
        <div className="notion-dataset-header">
          <div><strong>同步数据集</strong><span>从 Token 可访问的 Notion data source 中选择</span></div>
          <button type="button" className="secondary-button" disabled={busy !== 'idle'} onClick={() => { void handleDiscoverDatasets() }}><Search size={14} />{busy === 'discovering' ? '正在发现…' : '发现数据集'}</button>
        </div>
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
      <div className="source-card-footer source-card-footer--notion"><span><RefreshCw size={15} className={busy !== 'idle' ? 'spin' : ''} />{busyLabel}</span><div className="notion-actions"><button type="button" className="secondary-button" disabled={busy !== 'idle'} onClick={() => { void handleCheckConnection() }}><RefreshCw size={15} />检查连接</button>{isDirectMode
        ? <button type="button" className="secondary-button" disabled={busy !== 'idle' || !isConfigured} onClick={() => onReloadRemote?.()}><RefreshCw size={15} />重新读取</button>
        : <><button type="button" className="secondary-button" disabled={busy !== 'idle' || !isConfigured} onClick={() => { void handlePull() }}><ArrowLeft size={15} />拉取到本地</button><button type="button" className="primary-button" disabled={busy !== 'idle' || !isConfigured} onClick={() => { void handlePush() }}><Cloud size={15} />推送到 Notion</button></>}</div></div>
    </div>
    <NotionSetupGuide />
    <div className="info-banner"><Sparkles size={16} /><span><strong>{isDirectMode ? '远程直连规则：' : '本地同步规则：'}</strong>{isDirectMode ? 'CalendarMark 启动或切换到 Notion 时自动读取远端数据；保存和删除记录会直接写入 Notion，不会把记录持久化到本机数据文件。Notion 侧有外部改动时，可点击“重新读取”刷新当前数据集。' : 'CalendarMark 当前以本地记录为主；点击“拉取到本地”合并 Notion 数据，点击“推送到 Notion”将本地记录创建或更新到远端。'}</span></div>
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
  return {
    ...entry,
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

function NotionSetupGuide() {
  return <section className="notion-guide" aria-labelledby="notion-guide-title">
    <div className="notion-guide-header"><div><span className="eyebrow">连接引导</span><h3 id="notion-guide-title">3 步准备好 Notion 数据源</h3><p>CalendarMark 会根据 Token 自动发现已授权的数据集，不需要手工填写 ID。</p></div><a className="guide-link" href="https://developers.notion.com/guides/get-started/quick-start" target="_blank" rel="noreferrer">官方文档 <ExternalLink size={13} /></a></div>
    <div className="notion-guide-steps">
      <div className="notion-guide-step"><span className="notion-guide-number">1</span><div><strong>创建 Internal connection</strong><p>打开 Notion Integrations，在 Build 中创建 Internal connection，然后进入 Configuration 复制 Installation access token。</p><a className="guide-link guide-link--inline" href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer">打开 Notion Integrations <ExternalLink size={12} /></a></div></div>
      <div className="notion-guide-step"><span className="notion-guide-number">2</span><div><strong>把目标数据库分享给连接</strong><p>打开目标数据库右上角的 <b>•••</b>，选择 Add connections，搜索刚创建的连接并确认。没有这一步，API 无法访问数据库。</p></div></div>
      <div className="notion-guide-step"><span className="notion-guide-number">3</span><div><strong>发现并添加数据集</strong><p>回到 CalendarMark，填写 Token 后点击“发现数据集”，在结果中点击“添加数据集”，再选择当前同步目标。</p><code className="notion-url-example">Token → 发现数据集 → 添加数据集</code></div></div>
    </div>
    <div className="notion-guide-note"><KeyRound size={14} /><span>不要把 Token 发给别人、放进截图或提交到 Git。CalendarMark 会从 Rust 侧直接请求 Notion API，不经过 CalendarMark 自有服务；“添加数据集”只保存本机的同步目标，不会修改或删除 Notion 内容。</span></div>
  </section>
}

type LocalSourceSettingsProps = Omit<NotionSourceSettingsProps, 'mode'> & { onSelectNotion: () => void }

function LocalSourceSettings({ settings, onChangeSettings, entries, onChangeEntries, tags, onChangeTags, onNotice, onSelectNotion }: LocalSourceSettingsProps) {
  return <>
    <div className="source-card source-card--local">
      <div className="source-card-top"><div className="source-placeholder-icon"><HardDrive size={18} /></div><div><strong>本地存储</strong><span>本地记录为主，可按需同步远程数据</span></div><span className="connection-badge"><span className="status-dot status-dot--ready" />可用</span></div>
      <div className="source-divider" />
      <div className="local-source-body"><p>当前日历使用本机数据，保存会立即写入本地。下方可以选择一个已授权的 Notion 数据集，手动拉取到本地或将本地记录推送到远程。</p><div className="local-source-points"><span><Check size={14} />离线可用</span><span><Check size={14} />本地优先</span><span><Check size={14} />按需同步</span></div></div>
      <div className="source-card-footer"><span><Database size={15} />想让每次编辑直接写远程？</span><button type="button" className="secondary-button" onClick={onSelectNotion}><Database size={15} />切换为 Notion 直连</button></div>
    </div>
    <NotionSourceSettings mode="local-sync" settings={settings} onChangeSettings={onChangeSettings} entries={entries} onChangeEntries={onChangeEntries} tags={tags} onChangeTags={onChangeTags} onNotice={onNotice} />
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

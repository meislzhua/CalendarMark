import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent, FormEvent, ReactNode } from 'react'
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
  Link2,
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
  const [entries, setEntries] = useState<CalendarEntry[]>(loadEntries)
  const [tags, setTags] = useState<Tag[]>(loadTags)
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [draft, setDraft] = useState<CalendarEntry>(() => createDraft(today))
  const [newTagName, setNewTagName] = useState('')
  const [shortcutState, setShortcutState] = useState<'ready' | 'browser' | 'error'>('browser')
  const [notice, setNotice] = useState('')

  const calendarCells = useMemo(() => getCalendarCells(currentMonth), [currentMonth])
  const monthTitle = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
  }).format(currentMonth)
  const currentMonthEntries = entries
    .filter((entry) => fromDateKey(entry.date).getMonth() === currentMonth.getMonth()
      && fromDateKey(entry.date).getFullYear() === currentMonth.getFullYear())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  useEffect(() => saveEntries(entries), [entries])
  useEffect(() => saveTags(tags), [tags])
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

  function handleSaveEntry(event?: FormEvent) {
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

  function handleDeleteEntry() {
    if (!entries.some((entry) => entry.id === draft.id)) return
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

  function deleteTag(tagId: string) {
    setTags((previous) => previous.filter((tag) => tag.id !== tagId))
    setEntries((previous) => previous.map((entry) => ({
      ...entry,
      tagIds: entry.tagIds.filter((id) => id !== tagId),
    })))
    setDraft((previous) => ({ ...previous, tagIds: previous.tagIds.filter((id) => id !== tagId) }))
    setNotice('标签已删除')
  }

  const isCurrentMonthToday = today.slice(0, 7) === toDateKey(currentMonth).slice(0, 7)

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
            <span className="status-dot" />
            <span>本地草稿</span>
            <span className="data-source-divider">·</span>
            <span className="notion-wordmark">N</span>
            <span>Notion 待连接</span>
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
          <SettingsView settings={settings} settingsSection={settingsSection} setSettingsSection={setSettingsSection} onChangeSettings={setSettings} tags={tags} onAddTag={(name) => addTag(name)} onDeleteTag={deleteTag} shortcutState={shortcutState} onNotice={setNotice} />
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
            <div className="drawer-footer">{entries.some((entry) => entry.id === draft.id) && <button type="button" className="danger-button" onClick={handleDeleteEntry}><Trash2 size={15} />删除</button>}<div className="drawer-footer-actions"><button type="button" className="secondary-button" onClick={() => setDrawerOpen(false)}>取消</button><button type="submit" className="primary-button"><Save size={15} />保存记录</button></div></div>
          </form>
        </aside>
      </>}

      {notice && <div className="toast" role="status"><Check size={15} />{notice}</div>}
    </div>
  )
}

function AttachmentItem({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const isImage = attachment.mimeType.startsWith('image/')
  return <div className="attachment-item">{isImage ? <img src={attachment.dataUrl} alt={attachment.name} /> : <div className="attachment-file-icon"><FileText size={17} /></div>}<div className="attachment-copy"><strong title={attachment.name}>{attachment.name}</strong><small>{formatBytes(attachment.size)}</small></div><button type="button" className="plain-icon-button" aria-label={`移除 ${attachment.name}`} onClick={onRemove}><X size={14} /></button></div>
}

type SettingsViewProps = {
  settings: AppSettings
  settingsSection: SettingsSection
  setSettingsSection: (section: SettingsSection) => void
  onChangeSettings: (settings: AppSettings) => void
  tags: Tag[]
  onAddTag: (name: string) => void
  onDeleteTag: (tagId: string) => void
  shortcutState: 'ready' | 'browser' | 'error'
  onNotice: (message: string) => void
}

function SettingsView({ settings, settingsSection, setSettingsSection, onChangeSettings, tags, onAddTag, onDeleteTag, shortcutState, onNotice }: SettingsViewProps) {
  const [newTag, setNewTag] = useState('')
  const sections: { id: SettingsSection; label: string; description: string; icon: typeof Database }[] = [
    { id: 'source', label: '数据源', description: '选择数据来源', icon: Database },
    { id: 'shortcut', label: '快捷键', description: '随时打开窗口', icon: Keyboard },
    { id: 'interface', label: '界面', description: '调整显示方式', icon: Palette },
    { id: 'tags', label: '标签管理', description: '整理你的分类', icon: TagIcon },
  ]
  const update = (partial: Partial<AppSettings>) => onChangeSettings({ ...settings, ...partial })
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
        {settingsSection === 'source' && <DataSourceSettings settings={settings} onChangeSettings={onChangeSettings} onNotice={onNotice} />}
        {settingsSection === 'shortcut' && <><SettingsTitle icon={<Keyboard size={18} />} eyebrow="快捷键" title="不用打断思路，就能打开记录窗口" description="桌面版会在启动时注册全局快捷键；浏览器预览不会抢占系统快捷键。" /><div className="preference-card"><div className="preference-row"><div className="preference-copy"><strong>打开 CalendarMark</strong><span>建议使用不容易和其他软件冲突的组合键</span></div><div className="shortcut-input-wrap"><Command size={15} /><input aria-label="全局快捷键" value={settings.shortcut} onChange={(event) => update({ shortcut: event.target.value })} /></div></div><div className="preference-row preference-row--subtle"><span className="connection-badge connection-badge--plain"><span className={`status-dot ${shortcutState === 'error' ? 'status-dot--error' : ''}`} />{shortcutState === 'ready' ? '桌面快捷键已注册' : shortcutState === 'error' ? '快捷键注册失败，请更换组合' : '浏览器预览模式'}</span><button className="text-button" onClick={() => update({ shortcut: DEFAULT_SETTINGS.shortcut })}>恢复默认</button></div></div><div className="shortcut-preview"><div className="shortcut-preview-icon"><Zap size={18} /></div><div><strong>快速记录的节奏</strong><p>按下快捷键后，CalendarMark 会显示主窗口；再点击某一天即可打开右侧记录抽屉。</p></div><kbd>{settings.shortcut.replace('CommandOrControl', 'Ctrl')}</kbd></div></>}
        {settingsSection === 'interface' && <><SettingsTitle icon={<Palette size={18} />} eyebrow="界面" title="选择让你感觉舒服的明暗" description="主题设置会立即应用到 CalendarMark 的所有界面。" /><div className="theme-options"><ThemeOption icon={<Sun size={18} />} title="浅色" description="干净明亮的纸张感" active={settings.theme === 'light'} onClick={() => update({ theme: 'light' })} /><ThemeOption icon={<Moon size={18} />} title="深色" description="夜间记录更舒适" active={settings.theme === 'dark'} onClick={() => update({ theme: 'dark' })} /><ThemeOption icon={<Monitor size={18} />} title="跟随系统" description="随系统自动切换" active={settings.theme === 'auto'} onClick={() => update({ theme: 'auto' })} /></div><div className="preference-card"><div className="preference-row"><div className="preference-copy"><strong>启动时显示上次浏览的月份</strong><span>下次打开时保留你的浏览上下文</span></div><span className="toggle-switch toggle-switch--on"><span /></span></div><div className="preference-row"><div className="preference-copy"><strong>关闭窗口时保留在托盘</strong><span>点击右上角关闭只隐藏窗口，不退出应用</span></div><span className="toggle-switch toggle-switch--on"><span /></span></div></div></>}
        {settingsSection === 'tags' && <><SettingsTitle icon={<TagIcon size={18} />} eyebrow="标签管理" title="让标签替你整理生活的纹理" description="快捷标签会显示在日历格子和记录抽屉里。" /><div className="tag-manager-card"><div className="tag-manager-header"><div><strong>我的标签</strong><span>{tags.length} 个标签</span></div><form className="tag-add-form" onSubmit={submitTag}><input aria-label="标签名称" placeholder="输入新标签" value={newTag} onChange={(event) => setNewTag(event.target.value)} /><button type="submit" aria-label="添加标签"><Plus size={16} /></button></form></div><div className="managed-tags">{tags.map((tag) => <div className="managed-tag" key={tag.id}><span className={`tag-dot tag-dot--${tag.color}`} /><span>{tag.name}</span><span className="managed-tag-count">快捷标签</span><button className="plain-icon-button" aria-label={`删除 ${tag.name}`} onClick={() => onDeleteTag(tag.id)}><Trash2 size={14} /></button></div>)}</div></div><div className="info-banner info-banner--warm"><Hash size={16} /><span>小建议：保持标签在 3–8 个之间，日历会更清晰，也更容易回顾。</span></div></>}
      </section>
    </div>
  </div>
}

function DataSourceSettings({ settings, onChangeSettings, onNotice }: { settings: AppSettings; onChangeSettings: (settings: AppSettings) => void; onNotice: (message: string) => void }) {
  const selectedSource = DATA_SOURCE_DEFINITIONS.find((source) => source.id === settings.dataSource) ?? DATA_SOURCE_DEFINITIONS[0]
  const update = (partial: Partial<AppSettings>) => onChangeSettings({ ...settings, ...partial })

  function statusLabel(status: typeof selectedSource.status): string {
    if (status === 'active') return '可用'
    if (status === 'preview') return '配置预览'
    return '规划中'
  }

  return <>
    <SettingsTitle icon={<Database size={18} />} eyebrow="数据源" title="选择可以替换的数据来源" description="CalendarMark 用统一的数据源入口承载不同连接方式；当前先把 Notion 适配器和本地存储整理好，后续可以继续加入更多 provider。" />
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
    {selectedSource.id === 'notion' && <NotionSourceSettings settings={settings} onChangeSettings={onChangeSettings} onNotice={onNotice} />}
    {selectedSource.id === 'local' && <LocalSourceSettings onSelectNotion={() => update({ dataSource: 'notion' })} />}
    {selectedSource.status === 'planned' && <PlannedSourceSettings sourceId={selectedSource.id} />}
  </>
}

function DataSourceIcon({ id }: { id: DataSourceId }) {
  if (id === 'local') return <HardDrive size={17} />
  if (id === 'webdav') return <Cloud size={17} />
  if (id === 'obsidian') return <BookOpen size={17} />
  return <Database size={17} />
}

function NotionSourceSettings({ settings, onChangeSettings, onNotice }: { settings: AppSettings; onChangeSettings: (settings: AppSettings) => void; onNotice: (message: string) => void }) {
  const isConfigured = Boolean(settings.notionToken.trim() && settings.notionDatabaseId.trim())
  const update = (partial: Partial<AppSettings>) => onChangeSettings({ ...settings, ...partial })

  return <>
    <div className="source-card source-card--notion">
      <div className="source-card-top"><div className="notion-logo">N</div><div><strong>Notion</strong><span>首个外部数据源 · 先完成连接配置</span></div><span className="connection-badge"><span className={`status-dot ${isConfigured ? 'status-dot--ready' : 'status-dot--muted'}`} />{isConfigured ? '已填写配置' : '待配置'}</span></div>
      <div className="source-divider" />
      <div className="source-fields">
        <label className="field-label" htmlFor="notion-token"><span>Integration Token</span><span className="field-hint"><KeyRound size={12} />仅保存在本机</span></label>
        <input id="notion-token" className="settings-input" type="password" placeholder="secret_… 或 ntn_…" value={settings.notionToken} onChange={(event) => update({ notionToken: event.target.value })} />
        <label className="field-label" htmlFor="notion-database"><span>Database ID</span><span className="field-hint"><Link2 size={12} />从数据库链接中复制</span></label>
        <input id="notion-database" className="settings-input" placeholder="32 位 Database ID" value={settings.notionDatabaseId} onChange={(event) => update({ notionDatabaseId: event.target.value })} />
      </div>
      <div className="source-card-footer"><span><Cloud size={15} />真实同步适配器将在后续版本接入</span><button type="button" className="secondary-button" onClick={() => onNotice(isConfigured ? '配置已保存，Notion 同步适配器待接入' : '请先填写 Token 和 Database ID')}><RefreshCw size={15} />检查配置</button></div>
    </div>
    <NotionSetupGuide />
    <div className="info-banner"><Sparkles size={16} /><span><strong>数据映射建议：</strong>Notion 数据库至少包含 Date、Title、Content 和 Tags 属性。当前版本先保存连接配置，真实读写同步将在适配器接入后启用。</span></div>
  </>
}

function NotionSetupGuide() {
  return <section className="notion-guide" aria-labelledby="notion-guide-title">
    <div className="notion-guide-header"><div><span className="eyebrow">连接引导</span><h3 id="notion-guide-title">3 步准备好 Notion 信息</h3><p>Token 是连接密钥，Database ID 用来告诉 CalendarMark 要读取哪一个数据库。</p></div><a className="guide-link" href="https://developers.notion.com/guides/get-started/quick-start" target="_blank" rel="noreferrer">官方文档 <ExternalLink size={13} /></a></div>
    <div className="notion-guide-steps">
      <div className="notion-guide-step"><span className="notion-guide-number">1</span><div><strong>创建 Internal connection</strong><p>打开 Notion Integrations，在 Build 中创建 Internal connection，然后进入 Configuration 复制 Installation access token。</p><a className="guide-link guide-link--inline" href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer">打开 Notion Integrations <ExternalLink size={12} /></a></div></div>
      <div className="notion-guide-step"><span className="notion-guide-number">2</span><div><strong>把目标数据库分享给连接</strong><p>打开目标数据库右上角的 <b>•••</b>，选择 Add connections，搜索刚创建的连接并确认。没有这一步，API 无法访问数据库。</p></div></div>
      <div className="notion-guide-step"><span className="notion-guide-number">3</span><div><strong>复制 Database ID</strong><p>将数据库作为整页打开，点击 Share → Copy link。复制 URL 中 workspace 后、<code>?v=</code> 前的 32 位字符串。</p><code className="notion-url-example">https://www.notion.so/workspace/<b>database_id</b>?v=view_id</code></div></div>
    </div>
    <div className="notion-guide-note"><KeyRound size={14} /><span>不要把 Token 发给别人、放进截图或提交到 Git；当前 MVP 只在本机保存配置。一个数据库包含多个 data source 时，后续同步适配器还会从 Database ID 继续发现对应的 data source ID。</span></div>
  </section>
}

function LocalSourceSettings({ onSelectNotion }: { onSelectNotion: () => void }) {
  return <div className="source-card source-card--local">
    <div className="source-card-top"><div className="source-placeholder-icon"><HardDrive size={18} /></div><div><strong>本地存储</strong><span>离线优先的数据来源</span></div><span className="connection-badge"><span className="status-dot status-dot--ready" />可用</span></div>
    <div className="source-divider" />
    <div className="local-source-body"><p>记录会继续保存在当前设备，适合不需要云端同步的使用方式。切换到本地存储不会删除已填写的 Notion 配置。</p><div className="local-source-points"><span><Check size={14} />离线可用</span><span><Check size={14} />无需账号</span><span><Check size={14} />即时保存</span></div></div>
    <div className="source-card-footer"><span><Database size={15} />想跨设备同步？可以切换回 Notion</span><button type="button" className="secondary-button" onClick={onSelectNotion}><Database size={15} />配置 Notion</button></div>
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

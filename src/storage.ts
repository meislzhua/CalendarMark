import {
  DEFAULT_SETTINGS,
  DEFAULT_TAGS,
  getSeedEntries,
  oneEntryPerDate,
} from './types'
import type { AppSettings, CalendarEntry, Tag } from './types'
import { isAndroidTauriRuntime } from './tauri'

const STORAGE_KEYS = {
  entries: 'calendarmark.entries.v1',
  tags: 'calendarmark.tags.v1',
  settings: 'calendarmark.settings.v1',
} as const

function read<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key)
    return value ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}

function write<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // The UI remains usable when storage is unavailable (for example in private mode).
  }
}

/**
 * 启动自检：WebView 的 localStorage 在异常环境下可能不可写（隐私模式/配额/配置损坏），
 * 此时设置会静默丢失，表现为“明明配置过，重开又变成待配置”。
 * 与其吞掉错误，不如显式暴露给 UI。
 */
export function checkStorageAvailable(): boolean {
  try {
    const probeKey = 'calendarmark.storage-probe.v1'
    window.localStorage.setItem(probeKey, '1')
    const readable = window.localStorage.getItem(probeKey) === '1'
    window.localStorage.removeItem(probeKey)
    return readable
  } catch {
    return false
  }
}

export function loadEntries(): CalendarEntry[] {
  return oneEntryPerDate(read(STORAGE_KEYS.entries, getSeedEntries()))
}

export function loadTags(): Tag[] {
  return read(STORAGE_KEYS.tags, DEFAULT_TAGS)
}

export function loadSettings(): AppSettings {
  const stored = read<Partial<AppSettings>>(STORAGE_KEYS.settings, DEFAULT_SETTINGS)
  const settings = { ...DEFAULT_SETTINGS, ...stored }
  // Android 使用单列堆叠布局：界面模式选择在移动端隐藏，
  // 因此安卓端固定按抽屉（单列）模式渲染，避免沿用桌面默认的窗口双栏。
  if (isAndroidTauriRuntime()) settings.uiMode = 'drawer'
  // 兼容旧版本：把单个 qiniuToken（AK:SK）迁移为分开的 AK / SK 字段
  const legacyToken = (stored as { qiniuToken?: string }).qiniuToken
  if (legacyToken && !settings.qiniuAccessKey) {
    const separator = legacyToken.includes(':') ? ':' : /\s+/
    const parts = legacyToken.trim().split(separator, 2)
    if (parts.length === 2 && parts[0] && parts[1]) {
      settings.qiniuAccessKey = parts[0].trim()
      settings.qiniuSecretKey = parts[1].trim()
    }
  }
  delete (settings as { qiniuToken?: string }).qiniuToken
  // 七牛源因 CDN 缓存/回源计费模型暂时下线。旧配置仍保留，当前数据源回落到本地，
  // 避免升级后应用继续直接读写七牛或停留在不可用状态。
  if (settings.dataSource === 'qiniu') settings.dataSource = 'local'
  return settings
}

export function saveEntries(entries: CalendarEntry[]): void {
  write(STORAGE_KEYS.entries, oneEntryPerDate(entries))
}

export function saveTags(tags: Tag[]): void {
  write(STORAGE_KEYS.tags, tags)
}

export function saveSettings(settings: AppSettings): void {
  write(STORAGE_KEYS.settings, settings)
}

import {
  DEFAULT_SETTINGS,
  DEFAULT_TAGS,
  getSeedEntries,
  oneEntryPerDate,
} from './types'
import type { AppSettings, CalendarEntry, Tag } from './types'

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

export function loadEntries(): CalendarEntry[] {
  return oneEntryPerDate(read(STORAGE_KEYS.entries, getSeedEntries()))
}

export function loadTags(): Tag[] {
  return read(STORAGE_KEYS.tags, DEFAULT_TAGS)
}

export function loadSettings(): AppSettings {
  const stored = read<Partial<AppSettings>>(STORAGE_KEYS.settings, DEFAULT_SETTINGS)
  const settings = { ...DEFAULT_SETTINGS, ...stored }
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

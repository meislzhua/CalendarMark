import {
  DEFAULT_SETTINGS,
  DEFAULT_TAGS,
  getSeedEntries,
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
  return read(STORAGE_KEYS.entries, getSeedEntries())
}

export function loadTags(): Tag[] {
  return read(STORAGE_KEYS.tags, DEFAULT_TAGS)
}

export function loadSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...read(STORAGE_KEYS.settings, DEFAULT_SETTINGS) }
}

export function saveEntries(entries: CalendarEntry[]): void {
  write(STORAGE_KEYS.entries, entries)
}

export function saveTags(tags: Tag[]): void {
  write(STORAGE_KEYS.tags, tags)
}

export function saveSettings(settings: AppSettings): void {
  write(STORAGE_KEYS.settings, settings)
}

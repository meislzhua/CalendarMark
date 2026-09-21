import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './tauri'

export type NotionPropertyInfo = {
  name: string
  id: string
  propertyType: string
}

export type NotionDataSourceOption = {
  id: string
  name: string
}

export type NotionDatasetOption = {
  databaseId: string
  databaseTitle: string
  dataSourceId: string
  dataSourceName: string
}

export type NotionPageOption = {
  pageId: string
  title: string
}

export type NotionPageSearchResult = {
  pages: NotionPageOption[]
  warnings: string[]
}

export type NotionDiscoveryResult = {
  datasets: NotionDatasetOption[]
  warnings: string[]
}

export type NotionMappingInfo = {
  ready: boolean
  titleProperty?: string
  dateProperty?: string
  contentProperty?: string
  tagsProperty?: string
  filesProperty?: string
  message?: string
}

export type NotionConnectionInfo = {
  databaseId: string
  databaseTitle: string
  dataSourceId: string
  dataSourceName: string
  dataSources: NotionDataSourceOption[]
  properties: NotionPropertyInfo[]
  mapping: NotionMappingInfo
}

export type NotionAttachmentRecord = {
  name: string
  mimeType: string
  size: number
  sourceUrl?: string
  remoteId?: string
  remoteFile?: {
    kind: 'file' | 'external'
    value: Record<string, unknown>
  }
}

export type NotionEntryRecord = {
  remoteId: string
  dataSourceId: string
  date: string
  title: string
  content: string
  tagNames: string[]
  mood?: string
  attachments: NotionAttachmentRecord[]
  updatedAt: string
  url?: string
}

export type NotionPullResult = {
  connection: NotionConnectionInfo
  entries: NotionEntryRecord[]
  warnings: string[]
}

export type NotionAttachmentInput = {
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
}

export type NotionEntryInput = {
  localId: string
  remoteId?: string
  date: string
  title: string
  content: string
  tagNames: string[]
  mood?: string
  attachments: NotionAttachmentInput[]
}

export type NotionPullQuery = {
  dateStart?: string
  dateEnd?: string
  tag?: string
}

export type NotionPushRecord = {
  localId: string
  remoteId: string
  dataSourceId: string
  updatedAt: string
  url?: string
  uploadedAttachments: number
  attachments: NotionAttachmentRecord[]
}

export type NotionPushResult = {
  connection: NotionConnectionInfo
  entries: NotionPushRecord[]
  warnings: string[]
}

export type NotionSettingsMappingInfo = {
  ready: boolean
  nameProperty?: string
  dataProperty?: string
  colorProperty?: string
  colorPropertyType?: string
  retiredProperty?: string
  idProperty?: string
  message?: string
}

export type NotionSettingsConnectionInfo = {
  databaseId: string
  databaseTitle: string
  dataSourceId: string
  dataSourceName: string
  properties: NotionPropertyInfo[]
  mapping: NotionSettingsMappingInfo
}

export type NotionTagRecord = {
  remoteId: string
  tagId?: string
  name: string
  color?: string
  retired: boolean
  updatedAt: string
}

export type NotionSettingsPullResult = {
  connection: NotionSettingsConnectionInfo
  tags: NotionTagRecord[]
  warnings: string[]
}

export type NotionTagInput = {
  id: string
  name: string
  color?: string
  retired?: boolean
}

export type NotionSettingsPushResult = {
  connection: NotionSettingsConnectionInfo
  tags: NotionTagRecord[]
  warnings: string[]
}

export type NotionTokenTestResult = {
  botName?: string
  workspaceName?: string
}

function ensureTauriRuntime(): void {
  if (!isTauriRuntime()) {
    throw new Error('请在 Tauri 桌面版或 Android 版中使用 Notion 同步')
  }
}

export async function checkNotionConnection(
  token: string,
  databaseId: string,
  dataSourceId?: string,
): Promise<NotionConnectionInfo> {
  ensureTauriRuntime()
  return invoke<NotionConnectionInfo>('notion_check_connection', {
    token,
    databaseId,
    dataSourceId: dataSourceId || null,
  })
}

export async function discoverNotionDatasets(token: string): Promise<NotionDiscoveryResult> {
  ensureTauriRuntime()
  return invoke<NotionDiscoveryResult>('notion_discover_datasets', { token })
}

export async function pullNotionEntries(
  token: string,
  databaseId: string,
  dataSourceId?: string,
  query?: NotionPullQuery,
): Promise<NotionPullResult> {
  ensureTauriRuntime()
  return invoke<NotionPullResult>('notion_pull_entries', {
    token,
    databaseId,
    dataSourceId: dataSourceId || null,
    query: query ?? null,
  })
}

export async function pushNotionEntries(
  token: string,
  databaseId: string,
  dataSourceId: string | undefined,
  entries: NotionEntryInput[],
): Promise<NotionPushResult> {
  ensureTauriRuntime()
  return invoke<NotionPushResult>('notion_push_entries', {
    token,
    databaseId,
    dataSourceId: dataSourceId || null,
    entries,
  })
}

export async function archiveNotionPage(token: string, pageId: string): Promise<void> {
  ensureTauriRuntime()
  await invoke('notion_archive_page', { token, pageId })
}

export async function testNotionToken(token: string): Promise<NotionTokenTestResult> {
  ensureTauriRuntime()
  return invoke<NotionTokenTestResult>('notion_test_token', { token })
}

export async function testNotionDataset(
  token: string,
  databaseId: string,
  dataSourceId?: string,
): Promise<NotionConnectionInfo> {
  ensureTauriRuntime()
  return invoke<NotionConnectionInfo>('notion_test_dataset', {
    token,
    databaseId,
    dataSourceId: dataSourceId || null,
  })
}

export async function archiveNotionPagesByDate(
  token: string,
  databaseId: string,
  date: string,
  dataSourceId?: string,
): Promise<number> {
  ensureTauriRuntime()
  return invoke<number>('notion_archive_pages_by_date', {
    token,
    databaseId,
    date,
    dataSourceId: dataSourceId || null,
  })
}

export async function searchNotionPages(token: string): Promise<NotionPageSearchResult> {
  ensureTauriRuntime()
  return invoke<NotionPageSearchResult>('notion_search_pages', { token })
}

export async function createNotionDatabase(
  token: string,
  parentPageId: string,
  title: string,
): Promise<NotionConnectionInfo> {
  ensureTauriRuntime()
  return invoke<NotionConnectionInfo>('notion_create_database', {
    token,
    parentPageId,
    title,
  })
}

export async function checkNotionSettingsConnection(
  token: string,
  databaseId: string,
  dataSourceId?: string,
): Promise<NotionSettingsConnectionInfo> {
  ensureTauriRuntime()
  return invoke<NotionSettingsConnectionInfo>('notion_check_settings_connection', {
    token,
    databaseId,
    dataSourceId: dataSourceId || null,
  })
}

export async function pullNotionSettings(
  token: string,
  databaseId: string,
  dataSourceId?: string,
): Promise<NotionSettingsPullResult> {
  ensureTauriRuntime()
  return invoke<NotionSettingsPullResult>('notion_pull_settings', {
    token,
    databaseId,
    dataSourceId: dataSourceId || null,
  })
}

export async function pushNotionSettings(
  token: string,
  databaseId: string,
  dataSourceId: string | undefined,
  tags: NotionTagInput[],
): Promise<NotionSettingsPushResult> {
  ensureTauriRuntime()
  return invoke<NotionSettingsPushResult>('notion_push_settings', {
    token,
    databaseId,
    dataSourceId: dataSourceId || null,
    tags,
  })
}

export async function createNotionSettingsDatabase(
  token: string,
  parentPageId: string,
  title: string,
): Promise<NotionSettingsConnectionInfo> {
  ensureTauriRuntime()
  return invoke<NotionSettingsConnectionInfo>('notion_create_settings_database', {
    token,
    parentPageId,
    title,
  })
}

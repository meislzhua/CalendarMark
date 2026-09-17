import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './tauri'
import type { QiniuRegionOption } from './types'

export type QiniuUsage = {
  storageBytes: number
  updatedAt: number
}

export type QiniuDayDocument = {
  date: string
  entries: Array<{
    id: string
    title: string
    content: string
    tagNames: string[]
    mood?: string
    updatedAt: string
    attachments: Array<{
      id: string
      name: string
      key: string
      mimeType: string
      size: number
    }>
  }>
}

export type QiniuTagIndex = {
  date: string
  title: string
  entryIds: string[]
}

function ensureTauriRuntime(): void {
  if (!isTauriRuntime()) {
    throw new Error('请在 Tauri 桌面版或 Android 版中使用七牛数据源')
  }
}

export async function listQiniuBuckets(token: string): Promise<string[]> {
  ensureTauriRuntime()
  return invoke<string[]>('qiniu_list_buckets', { token })
}

export async function listQiniuRegions(): Promise<QiniuRegionOption[]> {
  ensureTauriRuntime()
  return invoke<QiniuRegionOption[]>('qiniu_regions')
}

export async function createQiniuBucket(token: string, bucket: string, region: string): Promise<void> {
  ensureTauriRuntime()
  await invoke('qiniu_create_bucket', { token, bucket, region })
}

export async function listQiniuBucketDomains(token: string, bucket: string): Promise<string[]> {
  ensureTauriRuntime()
  return invoke<string[]>('qiniu_bucket_domains', { token, bucket })
}

export async function getQiniuUsage(token: string, bucket: string, region: string): Promise<QiniuUsage> {
  ensureTauriRuntime()
  return invoke<QiniuUsage>('qiniu_get_usage', { token, bucket, region })
}

export async function listQiniuKeys(token: string, bucket: string, region: string, prefix: string): Promise<string[]> {
  ensureTauriRuntime()
  return invoke<string[]>('qiniu_list_keys', { token, bucket, region, prefix })
}

export async function getQiniuObjects(
  token: string,
  bucket: string,
  region: string,
  domain: string,
  keys: string[],
): Promise<Array<string | null>> {
  ensureTauriRuntime()
  return invoke<Array<string | null>>('qiniu_get_objects', { token, bucket, region, domain, keys })
}

export async function getQiniuAttachmentDataUrl(
  token: string,
  bucket: string,
  region: string,
  domain: string,
  key: string,
  mimeType: string,
): Promise<string | null> {
  ensureTauriRuntime()
  return invoke<string | null>('qiniu_get_attachment_data_url', { token, bucket, region, domain, key, mimeType })
}

export async function signQiniuDownloadUrls(
  token: string,
  domain: string,
  keys: string[],
): Promise<string[]> {
  ensureTauriRuntime()
  return invoke<string[]>('qiniu_sign_download_urls', { token, domain, keys })
}

export async function putQiniuObject(
  token: string,
  bucket: string,
  region: string,
  key: string,
  dataBase64: string,
  contentType: string,
): Promise<void> {
  ensureTauriRuntime()
  await invoke('qiniu_put_object', { token, bucket, region, key, dataBase64: dataBase64, contentType })
}

export async function deleteQiniuObject(
  token: string,
  bucket: string,
  region: string,
  key: string,
): Promise<void> {
  ensureTauriRuntime()
  await invoke('qiniu_delete_object', { token, bucket, region, key })
}

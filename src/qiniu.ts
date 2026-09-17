import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './tauri'
import type { QiniuRegionOption } from './types'

export type QiniuUsage = {
  storageBytes: number
  getCalls: number
  putDeleteCalls: number
  cdnOriginFlowBytes: number
  outboundFlowBytes: number
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

export type QiniuObjectInput = {
  key: string
  dataBase64: string
  contentType: string
}

function ensureTauriRuntime(): void {
  if (!isTauriRuntime()) {
    throw new Error('请在 Tauri 桌面版或 Android 版中使用七牛数据源')
  }
}

function raw(accessKey: string, secretKey: string) {
  return { accessKey, secretKey }
}

export async function listQiniuBuckets(accessKey: string, secretKey: string): Promise<string[]> {
  ensureTauriRuntime()
  return invoke<string[]>('qiniu_list_buckets', { raw: raw(accessKey, secretKey) })
}

export async function listQiniuRegions(): Promise<QiniuRegionOption[]> {
  ensureTauriRuntime()
  return invoke<QiniuRegionOption[]>('qiniu_regions')
}

export async function createQiniuBucket(accessKey: string, secretKey: string, bucket: string, region: string): Promise<void> {
  ensureTauriRuntime()
  await invoke('qiniu_create_bucket', { raw: raw(accessKey, secretKey), bucket, region })
}

export async function listQiniuBucketDomains(accessKey: string, secretKey: string, bucket: string): Promise<string[]> {
  ensureTauriRuntime()
  return invoke<string[]>('qiniu_bucket_domains', { raw: raw(accessKey, secretKey), bucket })
}

export async function queryQiniuBucketRegion(accessKey: string, secretKey: string, bucket: string): Promise<string> {
  ensureTauriRuntime()
  return invoke<string>('qiniu_query_region', { raw: raw(accessKey, secretKey), bucket })
}

export async function getQiniuUsage(accessKey: string, secretKey: string): Promise<QiniuUsage> {
  ensureTauriRuntime()
  return invoke<QiniuUsage>('qiniu_get_usage', { raw: raw(accessKey, secretKey) })
}

export async function listQiniuKeys(accessKey: string, secretKey: string, bucket: string, region: string, prefix: string): Promise<string[]> {
  ensureTauriRuntime()
  return invoke<string[]>('qiniu_list_keys', { raw: raw(accessKey, secretKey), bucket, region, prefix })
}

export async function getQiniuObjects(
  accessKey: string,
  secretKey: string,
  bucket: string,
  region: string,
  domain: string,
  keys: string[],
): Promise<Array<string | null>> {
  ensureTauriRuntime()
  return invoke<Array<string | null>>('qiniu_get_objects', { raw: raw(accessKey, secretKey), bucket, region, domain, keys })
}

export async function getQiniuAttachmentDataUrl(
  accessKey: string,
  secretKey: string,
  bucket: string,
  region: string,
  domain: string,
  key: string,
  mimeType: string,
): Promise<string | null> {
  ensureTauriRuntime()
  return invoke<string | null>('qiniu_get_attachment_data_url', { raw: raw(accessKey, secretKey), bucket, region, domain, key, mimeType })
}

export async function signQiniuDownloadUrls(
  accessKey: string,
  secretKey: string,
  domain: string,
  keys: string[],
): Promise<string[]> {
  ensureTauriRuntime()
  return invoke<string[]>('qiniu_sign_download_urls', { raw: raw(accessKey, secretKey), domain, keys })
}

export async function putQiniuObject(
  accessKey: string,
  secretKey: string,
  bucket: string,
  region: string,
  key: string,
  dataBase64: string,
  contentType: string,
): Promise<void> {
  ensureTauriRuntime()
  await invoke('qiniu_put_object', { raw: raw(accessKey, secretKey), bucket, region, key, dataBase64, contentType })
}

export async function putQiniuObjects(
  accessKey: string,
  secretKey: string,
  bucket: string,
  region: string,
  objects: QiniuObjectInput[],
): Promise<void> {
  ensureTauriRuntime()
  await invoke('qiniu_put_objects', { raw: raw(accessKey, secretKey), bucket, region, objects })
}

export async function deleteQiniuObject(
  accessKey: string,
  secretKey: string,
  bucket: string,
  region: string,
  key: string,
): Promise<void> {
  ensureTauriRuntime()
  await invoke('qiniu_delete_object', { raw: raw(accessKey, secretKey), bucket, region, key })
}

export async function deleteQiniuObjects(
  accessKey: string,
  secretKey: string,
  bucket: string,
  region: string,
  keys: string[],
): Promise<void> {
  ensureTauriRuntime()
  await invoke('qiniu_delete_objects', { raw: raw(accessKey, secretKey), bucket, region, keys })
}

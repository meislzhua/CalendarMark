import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { UiMode } from './types'
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'
import {
  register,
  unregister,
} from '@tauri-apps/plugin-global-shortcut'

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

export const isTauriRuntime = (): boolean => Boolean(window.__TAURI_INTERNALS__)
export const isDesktopTauriRuntime = (): boolean => isTauriRuntime() && !/Android|iPhone|iPad/i.test(navigator.userAgent)
export const isAndroidTauriRuntime = (): boolean => isTauriRuntime() && /Android/i.test(navigator.userAgent)

let registeredShortcut: string | null = null
let registeredHandler: (() => void) | null = null
let registrationQueue: Promise<{ ok: boolean; error?: string }> = Promise.resolve({ ok: true })

export async function showMainWindow(): Promise<void> {
  if (!isDesktopTauriRuntime()) return
  const appWindow = getCurrentWindow()
  await appWindow.show()
  await appWindow.setFocus()
}

export async function toggleMainWindow(): Promise<void> {
  if (!isDesktopTauriRuntime()) return
  const appWindow = getCurrentWindow()

  if (await appWindow.isVisible()) {
    // 窗口已显示：已聚焦则收起，未聚焦则把焦点带回窗口
    if (await appWindow.isFocused()) {
      await appWindow.hide()
      return
    }
    await appWindow.show()
    await appWindow.setFocus()
    return
  }

  await appWindow.show()
  await appWindow.setFocus()
}

export async function hideMainWindow(): Promise<void> {
  if (!isDesktopTauriRuntime()) return
  await getCurrentWindow().hide()
}

export async function openInExternalBrowser(url: string): Promise<boolean> {
  if (!isTauriRuntime()) return false

  try {
    await openUrl(url)
    return true
  } catch {
    return false
  }
}

export async function onWindowFocusChanged(handler: (focused: boolean) => void): Promise<() => void> {
  if (!isDesktopTauriRuntime()) return () => undefined
  try {
    const appWindow = getCurrentWindow()
    return await appWindow.onFocusChanged(({ payload }) => handler(payload))
  } catch {
    return () => undefined
  }
}

export async function registerGlobalShortcut(
  shortcut: string,
  onPressed: () => void,
): Promise<{ ok: boolean; error?: string }> {
  if (!isDesktopTauriRuntime()) return { ok: true }

  // 回调只更新引用，快捷键不变时无需重新注册。
  registeredHandler = onPressed
  if (registeredShortcut === shortcut) return { ok: true }

  // React StrictMode 和快速连续修改会并发触发注册；
  // 用串行队列保证 注销 → 注册 的顺序，避免竞态导致注册失败或状态错乱。
  registrationQueue = registrationQueue.then(async () => {
    try {
      if (registeredShortcut && registeredShortcut !== shortcut) {
        try {
          await unregister(registeredShortcut)
        } catch {
          // 旧快捷键可能已被系统注销，忽略后继续注册新的
        }
        registeredShortcut = null
      }
      if (!registeredShortcut) {
        await register(shortcut, (event) => {
          if (event.state === 'Pressed') registeredHandler?.()
        })
        registeredShortcut = shortcut
      }
      return { ok: true }
    } catch (error) {
      registeredShortcut = null
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  return registrationQueue
}

export async function listenForSettingsOpen(
  onOpen: () => void,
): Promise<() => void> {
  if (!isDesktopTauriRuntime()) return () => undefined

  try {
    return await listen('calendar-mark:open-settings', onOpen)
  } catch {
    return () => undefined
  }
}

export async function readAutostartEnabled(): Promise<boolean | null> {
  if (!isDesktopTauriRuntime()) return null

  try {
    return await isEnabled()
  } catch {
    return null
  }
}

export async function setAutostartEnabled(enabled: boolean): Promise<boolean> {
  if (!isDesktopTauriRuntime()) return false

  try {
    if (enabled) {
      await enable()
    } else {
      await disable()
    }
    return (await isEnabled()) === enabled
  } catch {
    return false
  }
}

type WindowWorkArea = {
  x: number
  y: number
  width: number
  height: number
}

async function readWorkArea(): Promise<WindowWorkArea | null> {
  try {
    return await invoke<WindowWorkArea>('get_window_work_area')
  } catch {
    return null
  }
}

export async function applyUiMode(mode: UiMode): Promise<boolean> {
  if (!isDesktopTauriRuntime()) return false
  const appWindow = getCurrentWindow()

  try {
    if (mode === 'drawer') {
      const area = await readWorkArea()
      if (!area) return false
      const width = Math.max(380, Math.min(460, Math.round(area.width * 0.3)))
      await appWindow.setDecorations(false)
      await appWindow.setMinSize(new LogicalSize(340, 480))
      await appWindow.setSize(new LogicalSize(width, area.height))
      await appWindow.setPosition(new LogicalPosition(area.x + area.width - width, area.y))
      return true
    }

    await appWindow.setDecorations(true)
    await appWindow.setMinSize(new LogicalSize(760, 560))
    await appWindow.setSize(new LogicalSize(1400, 900))
    await appWindow.center()
    return true
  } catch {
    return false
  }
}

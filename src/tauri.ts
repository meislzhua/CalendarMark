import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
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

let registeredShortcut: string | null = null

export async function showMainWindow(): Promise<void> {
  if (!isTauriRuntime()) return
  const appWindow = getCurrentWindow()
  await appWindow.show()
  await appWindow.setFocus()
}

export async function toggleMainWindow(): Promise<void> {
  if (!isTauriRuntime()) return
  const appWindow = getCurrentWindow()
  if (await appWindow.isVisible()) {
    await appWindow.hide()
  } else {
    await showMainWindow()
  }
}

export async function registerGlobalShortcut(
  shortcut: string,
  onPressed: () => void,
): Promise<{ ok: boolean; error?: string }> {
  if (!isTauriRuntime()) return { ok: true }

  try {
    if (registeredShortcut && registeredShortcut !== shortcut) {
      await unregister(registeredShortcut)
      registeredShortcut = null
    }
    if (!registeredShortcut) {
      await register(shortcut, (event) => {
        if (event.state === 'Pressed') onPressed()
      })
      registeredShortcut = shortcut
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function listenForSettingsOpen(
  onOpen: () => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined

  try {
    return await listen('calendar-mark:open-settings', onOpen)
  } catch {
    return () => undefined
  }
}

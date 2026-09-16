# CalendarMark 技术架构

## 1. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│ React / TypeScript                                          │
│  Calendar View ── Editor Drawer ── Settings                 │
│       │                  │                                  │
│       └──────────── local state / localStorage ─────────────┘
│                          │                                  │
│              tauri.ts (browser-safe bridge)                 │
└──────────────────────────┼──────────────────────────────────┘
                           │ Tauri IPC / Window API
┌──────────────────────────┼──────────────────────────────────┐
│ Rust / Tauri 2            │                                  │
│  tray icon · hide on close · global-shortcut plugin          │
│  future: secure storage · Notion HTTP adapter               │
└──────────────────────────┼──────────────────────────────────┘
                           │
              Windows / macOS / Android targets
```

前端保持可在浏览器运行，因此视觉和常规交互不依赖 Tauri。`src/tauri.ts` 只在检测到 Tauri runtime 后调用窗口和全局快捷键 API，浏览器预览会优雅降级。

## 2. 前端模块

### `src/types.ts`

集中定义 `CalendarEntry`、`Tag`、`Attachment`、`AppSettings`、`DataSourceId` 和 `DATA_SOURCE_DEFINITIONS`，并提供日期键、种子数据和 ID 工具，避免 UI 组件重复解释数据格式。数据源定义包含 `notion`、`local`、`webdav`、`obsidian` 四个入口及 `active / preview / planned` 状态，新增 provider 时不需要重写设置页的选择器。

### `src/storage.ts`

MVP 本地存储适配层，负责从 `localStorage` 读写：

- `calendarmark.entries.v1`
- `calendarmark.tags.v1`
- `calendarmark.settings.v1`

后续可以把同一组函数替换为 Tauri Store/SQLite，而不改变日历和抽屉组件的调用方式。

### `src/tauri.ts`

- `showMainWindow()`：显示并聚焦主窗口。
- `toggleMainWindow()`：为未来托盘/快捷入口保留的切换能力。
- `registerGlobalShortcut()`：处理快捷键注册、修改时注销旧组合、浏览器降级。
- `listenForSettingsOpen()`：接收 Rust 托盘发出的 `calendar-mark:open-settings` 事件。

### `src/App.tsx`

当前 MVP 使用单一页面状态管理，`view` 区分日历/设置，`drawerOpen` 控制记录抽屉；以后可以按需要拆成 `CalendarPage`、`EntryDrawer`、`SettingsPage`，但目前集中实现有利于快速验证产品流程。

## 3. Rust/Tauri 模块

`src-tauri/src/lib.rs` 的职责保持窄小：

1. 初始化日志插件。
2. 桌面目标初始化全局快捷键插件。
3. 创建托盘图标和菜单。
4. 托盘“打开”调用 `show_main_window`。
5. 托盘“设置”显示窗口并 emit `calendar-mark:open-settings`。
6. 托盘“退出”调用 `app.exit(0)`。
7. 拦截主窗口 `CloseRequested`，改为 `hide()`。

Android 不创建桌面托盘，相关代码由 `#[cfg(desktop)]` 排除；React 页面和数据模型继续复用。

## 4. 数据模型

```ts
type CalendarEntry = {
  id: string
  date: string       // YYYY-MM-DD，本地日期，不含时区
  title: string
  content: string
  tagIds: string[]
  attachments: Attachment[]
  updatedAt: string  // ISO 8601
}

type Attachment = {
  id: string
  name: string
  mimeType: string
  size: number
  dataUrl: string
}
```

日期使用本地 `YYYY-MM-DD`，不直接序列化 `Date`，避免跨时区同步时出现前后一天的问题。

## 5. 可替换数据源和 Notion 边界

设置页采用“数据源选择器 + provider 配置面板”的两层结构：

```text
DataSourceDefinition[]
├── Notion          preview  → Token / Database ID / 连接引导
├── 本地存储         active   → 无需配置
├── WebDAV           planned
└── Obsidian Vault   planned
```

`AppSettings.dataSource` 只保存当前选择，Notion 专属字段仍以 `notionToken` 和 `notionDatabaseId` 保存。这样切换到其他 provider 时不会丢弃已有 Notion 配置，也不会把外部数据源的字段塞进一个不可扩展的通用表单。

推荐下一阶段加入 `src/dataSources/`：

```text
DataSource
├── connect(): Result
├── pull(range): CalendarEntry[]
├── push(entries): SyncResult
└── disconnect(): void
```

`NotionDataSource` 应由 Rust 侧通过 HTTP client 请求 Notion API，前端只传递用户操作和已脱敏的同步结果。设置页已内嵌连接引导：创建 Internal connection、将数据库通过 Add connections 分享给连接、从 Share → Copy link 提取 Database ID。Token 存储优先使用系统 Keychain/Windows Credential Manager，而不是 localStorage。同步应包含：分页、指数退避、字段映射校验、远端 `last_edited_time` 与本地 `updatedAt` 的冲突策略。

Notion 当前 API 还区分 database container 与 data source：用户先提供 Database ID，连接成功后由适配器调用 Retrieve a database 发现 `data_sources`，再使用对应的 data source ID 读取 schema 和记录。

## 6. 权限和安全

- `src-tauri/capabilities/default.json` 只开放 core 默认能力以及全局快捷键 register/unregister。
- 不打开 shell、任意文件系统或任意远程 URL 权限。
- CSP 当前为 `null` 以支持 Vite/Tauri MVP；生产发布接入 Notion API 前应收紧 CSP，并把网络请求放入 Rust。
- 附件当前是本地 Data URL，后续应迁移到应用数据目录并做大小/类型校验。
- Notion Token 不发送给 CalendarMark 服务；未实现真实同步前不会发起 Notion 网络请求。

## 7. 跨平台策略

| 平台 | UI | 托盘 | 全局快捷键 | CI 打包 |
| --- | --- | --- | --- | --- |
| Windows | React/Tauri | 启用 | 启用 | `windows-latest` |
| macOS | React/Tauri | 启用 | 启用 | `macos-latest` |
| Android | React/Tauri mobile | 不启用 | 不启用 | Ubuntu + SDK/NDK |

Android 的 `src-tauri/gen/android` 目前由 CI 在构建时生成，并被 `.gitignore` 排除；若未来需要原生 Android 定制，应取消忽略并将工程纳入版本控制。

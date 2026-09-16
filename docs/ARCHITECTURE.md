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
│  Notion HTTP adapter · field mapping · pagination            │
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

### `src/notion.ts`

只负责 Tauri IPC 的类型和调用封装：发现数据集、检查连接、拉取页面、推送记录和归档页面。浏览器预览不会直接访问 Notion；点击同步按钮时会提示需要使用 Tauri 桌面版或 Android 版。

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
8. 注册 Notion 命令，将 Token 留在 Rust 命令调用边界内，不把 Notion API 请求放进 React WebView。

`src-tauri/src/notion.rs` 使用 `reqwest` + Rustls 调用 Notion REST API，当前实现：

- `POST /search`：按 `object=data_source` 过滤当前 Token 可访问的数据源，分页读取并补充所属 Database 名称。
- `Retrieve a database`：根据选中的 Database ID 发现所有 `data_sources`，兼容旧配置并允许用户切换目标 data source。
- `Retrieve a data source`：读取 schema，并按属性类型自动识别 title、date、rich_text、multi_select、files。
- `POST /data_sources/{id}/query`：分页拉取页面，处理游标重复和异常分页响应。
- `POST /pages` / `PATCH /pages/{id}`：创建或更新本地记录对应的页面。
- `POST /file_uploads` + multipart send：上传本地 Data URL 附件并将 file upload ID 写入 files 属性。
- `PATCH /pages/{id}` with `in_trash=true`：删除本地远端关联记录时归档页面。
- 对 429 和 5xx 做最多三次短退避重试，错误消息只返回 Notion 的状态和 message，不输出 Token。

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
  remote?: {
    provider: DataSourceId
    id: string
    dataSourceId?: string
    lastSyncedAt?: string
  }
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
├── Notion          active   → Token / 数据集发现与选择 / 同步操作
├── 本地存储         active   → 无需配置
├── WebDAV           planned
└── Obsidian Vault   planned
```

`AppSettings.dataSource` 只保存当前选择，Notion 专属字段保存 `notionToken`、当前选中的 `notionDatabaseId` / `notionDataSourceId`，以及可切换的 `notionDatasets` 本地列表。Database/Data source ID 仍作为同步适配器的内部引用和旧配置兼容字段，但设置界面不再要求用户手工填写。

Notion 同步路径如下：

```text
Integration Token
    │
    ▼
Search data_sources ── add to local list ── select dataset
    │                                          │
    ▼                                          ▼
Retrieve database / schema ── property mapping ── query pages
    │                                          │
    └─────────────── connection result ────────┘
                         │
             pull merge / push create-or-update
```

当前同步是用户主动触发的“拉取 / 推送”模型，不会后台自动覆盖本地记录。远端页面 ID 保存在 `CalendarEntry.remote`，推送时据此决定创建还是更新；拉取时按该引用更新已有条目，不会删除本地未出现在远端结果中的条目。

## 6. 权限和安全

- `src-tauri/capabilities/default.json` 只开放 core 默认能力以及全局快捷键 register/unregister。
- 不打开 shell、任意文件系统或任意远程 URL 权限。
- CSP 当前为 `null` 以支持 Vite/Tauri MVP；Notion 请求已经放入 Rust，生产发布仍应收紧 WebView CSP。
- 当前 Token 随 `AppSettings` 保存在 WebView localStorage，方便 MVP 使用但不是系统级密钥链；正式发布前应迁移到 Tauri Store 的安全后端或系统 Keychain。
- Notion Token 不发送给 CalendarMark 服务。拉取的文件 URL 是 Notion 返回的临时 URL；本地附件先作为 Data URL 保存并在推送时通过 File Upload API 上传，后续应把附件迁移到应用数据目录。
- 当前没有自动冲突解决、后台队列或离线重试；双端同时编辑时以用户最后一次显式拉取/推送为准。

## 7. 跨平台策略

| 平台 | UI | 托盘 | 全局快捷键 | CI 打包 |
| --- | --- | --- | --- | --- |
| Windows | React/Tauri | 启用 | 启用 | `windows-latest` |
| macOS | React/Tauri | 启用 | 启用 | `macos-latest` |
| Android | React/Tauri mobile | 不启用 | 不启用 | Ubuntu + SDK/NDK |

Android 的 `src-tauri/gen/android` 目前由 CI 在构建时生成，并被 `.gitignore` 排除；若未来需要原生 Android 定制，应取消忽略并将工程纳入版本控制。

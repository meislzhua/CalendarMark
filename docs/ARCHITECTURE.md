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
│  Notion HTTP adapter · Qiniu Kodo adapter · pagination       │
└──────────────────────────┼──────────────────────────────────┘
                           │
              Windows / macOS / Android targets
```

前端保持可在浏览器运行，因此视觉和常规交互不依赖 Tauri。`src/tauri.ts` 只在检测到 Tauri runtime 后调用窗口、全局快捷键和开机启动 API，浏览器预览会优雅降级。

## 2. 前端模块

### `src/types.ts`

集中定义 `CalendarEntry`、`Tag`、`Attachment`、`AppSettings`、`DataSourceId` 和 `DATA_SOURCE_DEFINITIONS`，并提供日期键、种子数据和 ID 工具，避免 UI 组件重复解释数据格式。数据源定义包含 `notion`、`local`、`qiniu`、`webdav`、`obsidian` 入口及 `active / preview / planned` 状态，新增 provider 时不需要重写设置页的选择器。

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
- 快捷键注册使用串行队列：StrictMode/快速连续修改时保证 注销 → 注册 顺序，避免竞态导致注册失败；回调通过引用更新，快捷键不变时不重新注册。
- `openInExternalBrowser()`：通过 opener 插件用系统默认浏览器打开外部链接（如 Notion Integrations 页面）。
- `readAutostartEnabled()` / `setAutostartEnabled()`：包装 autostart 插件；仅桌面 runtime 可用，浏览器和移动端返回不可用状态。
- `toggleMainWindow()`：快捷键语义——窗口已聚焦时收起，未聚焦或隐藏时显示并聚焦。
- `applyUiMode()`：切换窗口/抽屉模式。抽屉模式读取 Rust 侧 `get_window_work_area` 返回的工作区，将窗口调整为贴右侧的无边框窄窗口；窗口模式恢复装饰、尺寸并居中。
- `listenForSettingsOpen()`：接收 Rust 托盘发出的 `calendar-mark:open-settings` 事件。

### `src/notion.ts`

只负责 Tauri IPC 的类型和调用封装：发现数据集、检查连接、读取页面、写入页面和归档页面。远程直连模式由 App 在启动/切换数据集时调用读取命令；本地模式的设置面板才显示显式拉取/推送按钮。浏览器预览不会直接访问 Notion。

### `src/qiniu.ts`

七牛 Kodo IPC 封装：列出/创建空间（创建后自动设为私有）、获取空间域名、读取账号级多维用量、列举对象键、读写对象、签名下载链接和删除对象。前端不持有密钥签名逻辑，只透传用户配置。

### `src/data-source.ts`

统一的日历数据源接口 `CalendarDataSource`：`loadMonth(year, month)` 按月读取、`queryTagDates(tagName)` 跨月标签查询、`saveEntry` / `deleteEntry` 单条写入。本地实现是内存直通（App state + localStorage effect 持久化）；Notion 实现封装 IPC 的筛选查询（dateStart/dateEnd/tag）、远端引用合并与归档；七牛实现把日历数据映射为对象存储布局。UI 层只依赖此接口，不感知数据源差异；新增远程数据源（WebDAV/Obsidian）时实现同一接口即可接入月份按需加载与写入。

七牛 Kodo 目录布局：

```text
{prefix}/date/{YYYY-MM-DD}.json        # 当天全部记录（数组），保存只写一个对象，避免跨设备读改写竞态
{prefix}/files/{file_id}{.ext}         # 附件原始内容，MIME/大小等元数据在日期文档中
{prefix}/tags/{tag}/{YYYY-MM-DD}.json  # 标签 → 日期倒排索引，快捷入口一次前缀列举即可跨月查询
{prefix}/meta/tags.json                # 标签定义（颜色/停用态），换设备不丢
```

`loadMonth` 一次并发读取当月全部日期文档，图片附件由 Rust 侧经签名下载链接取回并转为 Data URL 预览；`saveEntry` 先上传新增附件，再写日期文档并增量维护标签索引；`deleteEntry` 删除记录独享的附件对象、重写或删除日期文档并清理失效索引。

Rust 侧 `notion_pull_entries` 接受可选 query（日期区间 + 标签），转换为 Notion query filter 在服务端筛选，分页仍由适配器循环处理；超过单页 100 条的数据集无需全量拉取。心情映射为可选的“心情”select 属性（按属性类型自动识别），推送时写入/清除 select 值，读取时带回 `mood` 字段。Notion 配置区分两个数据库：日期数据库按“一天一条”语义保存记录（推送前先按日期查询，有则更新那一条、无则创建，重复页面归档）；设置数据库通过 `notion_pull_settings` / `notion_push_settings` 只维护一条「CalendarMark 标签」记录（rich_text 存 JSON），按标题过滤读取，不加载也不修改设置库中的其他内容。

### `src/App.tsx`

当前 MVP 使用单一页面状态管理，`view` 区分日历/设置。日历总览由“日历 + 常驻记录面板”组成：窗口模式两列并排（面板在右侧、共享视口高度），抽屉模式单列堆叠（面板在日历下方）；点击日期只更新选中态与面板内容，不再弹出抽屉层。远程模式按月加载数据：`currentMonth` 变化时通过数据源接口查询该月，已加载月份缓存复用，“重新读取”清空缓存强制刷新；快捷入口的标签浮层通过 `queryTagDates` 跨月查询。保存/删除统一走数据源接口。侧栏“数据源状态”是可点击入口（跳转设置数据源分区），快捷入口“管理标签”跳转到标签管理分区；年月标题点击展开年月快捷选择器。

设置页分为数据源、系统、界面和标签管理四个分区。系统设置包含开机启动开关（autostart 插件）和全局快捷键；快捷键通过“读取组合键”按钮捕获下一次按键组合生成 Tauri accelerator（至少需要一个 Ctrl/Cmd/Alt 修饰键，Esc 取消），不再依赖手工输入。日历总览工具栏在远程直连模式下提供刷新按钮，等价于设置页的“重新读取”。本地存储的数据源卡片只列出已绑定的 Notion 数据集并保留拉取/推送按钮，Token、数据集发现和连接引导统一放在 Notion 数据源页。

设置内容共享同一个固定高度的滚动容器：左侧导航点击后定位到目标分区在**实际滚动容器**（窗口模式为 `settings-content`，抽屉模式为 `main-area`）中的位置并平滑滚动，滚动途中冻结 scroll-spy，IntersectionObserver 以视口为基准反向高亮当前分区；`scrollbar-gutter: stable` 保证滚动条出现/消失不会引起布局偏移，页面级滚动始终为零。标签采用“停用”语义：`Tag.retired` 只把标签移出选择列表，历史记录的 `tagIds`、日历展示和 Notion `multi_select` 都保持不变，标签管理页提供恢复入口。`AppSettings.uiMode` 控制窗口/抽屉模式，`document.documentElement.dataset.uiMode` 驱动 CSS 紧凑布局；抽屉模式下 `app-shell` 固定为视口高度、顶栏不继承 `min-height: 100vh`，主区域 `flex: 1` 内部滚动，抽屉窗口重新显示时会重放滑入动效。

记录删除采用两段式确认：第一次点击只切换到确认条，确认后才执行本地删除或 Notion 归档。侧栏快捷入口的标签会弹出日期浮层（该标签下的去重日期 + 记录标题，最多 8 条），点击后调用 `openDate` 跳转日历并打开当天记录。

## 3. Rust/Tauri 模块

`src-tauri/src/lib.rs` 的职责保持窄小：

1. 初始化日志插件。
2. 桌面目标初始化全局快捷键和 autostart 插件。
3. 创建托盘图标和菜单。
4. 托盘“打开”调用 `show_main_window`。
5. 托盘“设置”显示窗口并 emit `calendar-mark:open-settings`。
6. 托盘“退出”调用 `app.exit(0)`。
7. 拦截主窗口 `CloseRequested`，改为 `hide()`。
8. 注册 Notion 命令，将 Token 留在 Rust 命令调用边界内，不把这些 API 请求放进 React WebView；七牛命令当前不再注册。

`src-tauri/src/notion.rs` 使用 `reqwest` + Rustls 调用 Notion REST API，当前实现：

- `POST /search`：按 `object=data_source` 过滤当前 Token 可访问的数据源，分页读取并补充所属 Database 名称。
- `POST /search`（`object=page`）：新建数据库前列出可作为父级的页面。
- `POST /databases`：在选定父页面下创建数据库，一次性建立 名称/日期/内容/标签/附件 标准属性；Notion API 要求父级必须是连接可访问的页面。
- `Retrieve a database`：根据选中的 Database ID 发现所有 `data_sources`，兼容旧配置并允许用户切换目标 data source。
- `Retrieve a data source`：读取 schema，并按属性类型自动识别 title、date、rich_text、multi_select、files。
- `POST /data_sources/{id}/query`：分页拉取页面，处理游标重复和异常分页响应。
- `POST /pages` / `PATCH /pages/{id}`：创建或更新日历记录对应的页面；远程直连模式在单条记录保存时调用，本地模式由显式推送调用。
- `POST /file_uploads` + multipart send：上传本地 Data URL 附件并将 file upload ID 写入 files 属性；推送结果会回传每个附件的稳定引用（file upload ID / external 链接），前端保存后再次编辑时优先复用引用，不会重复上传同一文件。
- `PATCH /pages/{id}` with `in_trash=true`：删除本地远端关联记录时归档页面。
- 对 429 和 5xx 做最多三次短退避重试，错误消息只返回 Notion 的状态和 message，不输出 Token。

Android 不创建桌面托盘，相关代码由 `#[cfg(desktop)]` 排除；React 页面和数据模型继续复用。

`src-tauri/src/qiniu.rs` 同样基于 `reqwest` + Rustls，不引入七牛 SDK，签名算法按官方文档实现（`hmac` + `sha1` + URL-safe Base64）：

- 管理凭证（`Authorization: Qiniu AK:sign`）：签名串 = `Method Path?Query\nHost: host\n[Content-Type: ct]\n\n[body]`，用于空间管理、对象管理和账号级用量统计。
- URL-safe Base64 必须保留 `=` padding（与官方 SDK 的 `base64.URLEncoding` 一致）：HMAC-SHA1 签名编码后为 28 字符；去掉 padding 会被服务端判定 bad token（401）。
- 上传凭证（表单上传）：`AK:urlsafe(HMAC-SHA1(encodedPolicy)):urlsafe(policy)`，policy 限定 `scope=bucket:key` 与 deadline；上传前先通过 UC `/v2/query` 查询空间真实区域，再提交到对应的官方源站上传域名（如 `up-z2.qiniup.com`）。
- 下载凭证（私有空间）：`domain/key?e=deadline&token=AK:sign`，纯本地 HMAC 计算，无需网络请求即可生成附件预览/外链。
- 对象管理：v1 `POST {rsf.qiniu.com}/list` 前缀列举、`POST {rs.qiniu.com}/delete/<EncodedEntryURI>` 删除（612 幂等处理），读取经签名下载链接取回内容。rs/rsf 使用中心域名自动路由到空间真实区域，避免用户选错区域导致 `incorrect zone`。
- 区域自动识别：选择空间时调用 `GET /v2/query?ak=&bucket=` 获取空间真实区域（如 z2）并写回设置，用于空间信息展示；上传前也会重新查询真实区域，不信任可能陈旧的本地设置。对象管理和用量统计使用中心域名/账号级汇总，同样不依赖用户手选区域。
- 账号级用量并发调用 `/v6/space`、`/v6/blob_io?select=hits&$metric=hits`、`/v6/rs_put?select=hits`、`/v6/blob_io?select=flow&$metric=cdn_flow_out` 和 `/v6/blob_io?select=flow&$metric=flow_out`；时间范围是中国时区本月 1 日至今，请求数/流量按天求和，存储取最后快照。单个指标失败时先降级为 0，全部失败才向 UI 报错。
- `mkbucketv3` 创建空间成功后立即调用 `/private?bucket=..&private=1`，保证快捷创建的空间一定是私有空间。

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

日期使用本地 `YYYY-MM-DD`，不直接序列化 `Date`，避免跨时区同步时出现前后一天的问题。远程直连模式的 `entries` 和 `tags` 只作为当前窗口的运行时状态，不由 `saveEntries` / `saveTags` 持久化到本机；本地模式才使用这两个 localStorage 键。

## 5. 可替换数据源和 Notion 边界

设置页采用“数据源选择器 + provider 配置面板”的两层结构：

```text
DataSourceDefinition[]
├── Notion          active   → Token / 数据集发现与选择 / 同步操作
├── 本地存储         active   → 无需配置
├── 七牛 Kodo        planned  → 暂时下线；旧配置回落本地，适配代码保留
├── WebDAV           planned
└── Obsidian Vault   planned
```

`AppSettings.dataSource` 只保存当前选择。Notion 专属字段保存 `notionToken`、当前选中的 `notionDatabaseId` / `notionDataSourceId`，以及可切换的 `notionDatasets` 本地列表；七牛专属字段保存分开的 `qiniuAccessKey` / `qiniuSecretKey`、`qiniuBucket`、`qiniuRegion`、`qiniuDomain`（空间域名缓存，用于生成签名下载链接）和 `qiniuPrefix`（旧版本的单个 `qiniuToken` 会在读取设置时自动迁移为 AK/SK 两个字段）。

数据源运行语义如下：

```text
Integration Token
   │
   ▼
Notion 远程直连
    │
    ├─ 启动/切换数据集 ── query pages ── 内存中的日历
    ├─ 重新读取 ──────── query pages ── 刷新内存数据
    ├─ 保存记录 ──────── create/update page
    └─ 删除记录 ──────── archive page

本地数据源
    │
    ├─ 启动/切换 ─────── localStorage
    ├─ 拉取到本地 ────── Notion query → 合并本地记录
    └─ 推送到 Notion ─── local records → create/update pages
```

远端页面 ID 保存在 `CalendarEntry.remote`，写入时据此决定创建还是更新；本地模式的拉取采用合并策略，不会删除本地未出现在远端结果中的条目。当前不会后台持续监听 Notion 的外部修改，外部改动需要点击“重新读取”刷新，也不提供自动冲突解决。

七牛适配器暂时下线：设置入口显示为规划中，`loadSettings` 会把旧的 `dataSource: qiniu` 自动回落为 `local`，本地同步目标也不再生成七牛项。相关 Rust/TS 适配代码保留用于后续评估新的缓存与计费方案，但当前 UI 不提供直连或手动同步入口，也不会发起七牛请求。

## 6. 权限和安全

- `src-tauri/capabilities/default.json` 只开放 core 默认能力、全局快捷键 register/unregister、autostart 的 enable/disable/is-enabled，以及窗口 show/hide/set-focus/set-size/set-position/set-decorations 等模式切换所需权限。
- 不打开 shell、任意文件系统或任意远程 URL 权限。
- CSP 当前为 `null` 以支持 Vite/Tauri MVP；Notion 请求已经放入 Rust，生产发布仍应收紧 WebView CSP。
- 当前 Token 随 `AppSettings` 保存在 WebView localStorage，方便 MVP 使用但不是系统级密钥链；正式发布前应迁移到 Tauri Store 的安全后端或系统 Keychain。
- Notion Token 不发送给 CalendarMark 服务。拉取的文件 URL 是 Notion 返回的临时 URL；本地附件先作为 Data URL 保存并在推送时通过 File Upload API 上传，后续应把附件迁移到应用数据目录。
- 七牛 AccessKey/SecretKey 是账号级凭据。数据源下线后配置仍留在本机，但应用不会主动请求七牛；建议泄露过的密钥立即轮换，并在恢复该数据源前为 CalendarMark 创建专用子账号授权。
- 当前没有自动冲突解决、后台队列或离线重试；远程直连模式下双端同时编辑以最后一次写入为准，本地模式下以用户最后一次显式拉取/推送为准。

## 7. 跨平台策略

| 平台 | UI | 托盘 | 全局快捷键 | CI 打包 |
| --- | --- | --- | --- | --- |
| Windows | React/Tauri | 启用 | 启用 | `windows-latest` |
| macOS | React/Tauri | 启用 | 启用 | `macos-latest` |
| Android | React/Tauri mobile | 不启用 | 不启用 | Ubuntu + SDK/NDK |

Android 的 `src-tauri/gen/android` 目前由 CI 在构建时生成，并被 `.gitignore` 排除；若未来需要原生 Android 定制，应取消忽略并将工程纳入版本控制。

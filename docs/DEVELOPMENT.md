# CalendarMark 开发手册

## 1. 安装依赖

```bash
npm ci
cargo check --manifest-path src-tauri/Cargo.toml
```

开发时也可以使用 `npm install` 更新依赖。Node 版本建议使用 22 LTS；Tauri CLI 和 Rust crate 都保持在 major version 2。

## 2. 常用命令

```bash
npm run dev              # Vite 浏览器预览
npm run build            # TypeScript + Vite 生产构建
npm run lint             # Oxlint
npm run tauri:dev        # Tauri 桌面开发
npm run tauri:build      # 当前平台桌面包
npm run tauri:android:init
npm run tauri:android:dev
npm run tauri:android:build
```

Rust 代码修改后可以单独验证：

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
```

## 3. 开发顺序

1. 先用 `npm run dev` 验证日历、抽屉和设置，不需要桌面工具链。
2. 再用 `npm run tauri:dev` 验证托盘、关闭隐藏和全局快捷键。
3. 需要 Android 时配置 JDK 17、Android SDK/NDK，执行 `tauri android init`。
4. 提交前运行 `npm run build`、`npm run lint`、`cargo check`。

## 4. Notion 开发约定

Notion 已由 `src-tauri/src/notion.rs` 通过 Rust HTTP client 接入，React 只通过 `src/notion.ts` 发起 IPC 调用。设置页会引导用户创建 Internal connection、分享目标数据库，然后用 Token 自动发现和选择数据集。

- 不在 React 前端直接调用 Notion API。
- 不把 Integration Token 写入日志、错误 toast 或 GitHub Actions 输出；请求错误只返回 HTTP 状态和 Notion message。
- 当前 Token 为了 MVP 体验保存在 WebView localStorage，正式发布前应迁移到 Tauri Store 的安全后端或系统 Keychain。
- 点击“发现数据集”时使用 `POST /search` 的 `object=data_source` 过滤器和游标分页，列出当前 Token 可访问的数据源；用户添加的数据集保存在 `AppSettings.notionDatasets`，并分别绑定到 `notionDatabaseId`（日期数据库）和 `notionSettingsDatabaseId`（设置数据库）。
- “新建数据库”先通过 `POST /search` 的 `object=page` 列出可作为父级的页面，再用 `POST /databases` 创建标准属性结构（日期库：名称/日期/内容/标签/附件；设置库：名称/颜色/停用/ID）；Notion API 不允许在 workspace 根级创建数据库，父级页面是硬性要求。
- 选定数据集后调用 Retrieve a database / Retrieve a data source 读取 schema；数据库包含多个 data source 时仍可从连接结果切换。旧版本只保存 Database ID 的设置仍可兼容读取，并会在成功连接后迁移到数据集列表。
- 字段映射按属性类型优先、按中文/英文名称辅助识别：`title` + `date` 为必需，`rich_text` / `multi_select` / `files` 为可选。
- 查询使用 cursor 分页；429 和 5xx 最多做三次短退避重试。
- 写入时先按日期查询日期数据库：该日期已有页面就更新那一条（优先本地 `remote.id`，其次是最近编辑的页面），没有才创建；同日期多余页面归档，保证“一天一条”。附件优先复用已有的 file upload ID / external 引用，只有新附件才创建 File Upload 并通过 multipart 上传。推送结果会回传每个附件的稳定引用，前端按索引合并保存，后续编辑不再重复上传。
- 标签定义保存在设置数据库的一条「CalendarMark 标签」记录里（title 属性做标题、rich_text 属性存 JSON）：`notion_pull_settings` 按标题过滤只读这一条，`notion_push_settings` 只创建/更新这一条，绝不归档设置库中的其他页面。旧版“每个标签一行”的数据在首次读取时迁移一次，旧页面保持不变。
- `AppSettings.dataSource=notion` 是远程直连模式：App 在启动、切换数据集或点击“重新读取”时调用查询命令，保存和删除直接调用 Notion；自动读取带 500ms 防抖，避免逐字符输入 Token 时重复请求。
- `AppSettings.dataSource=local` 才显示显式“拉取到本地 / 推送到 Notion”按钮；两种模式都不做后台自动覆盖，冲突和可选字段缺失通过同步警告反馈给用户。

### 系统能力

- 开机启动由 `tauri-plugin-autostart` 实现，插件只在桌面目标初始化；能力文件只授权 `enable/disable/is-enabled` 三个命令。
- `src/tauri.ts` 中的 `readAutostartEnabled` / `setAutostartEnabled` 负责浏览器和移动端降级，UI 层不需要重复判断平台。
- 快捷键录制在 `SystemSettings` 中通过捕获型 `keydown` 监听实现：至少一个 Ctrl/Cmd/Alt 修饰键 + 普通按键才生成合法 accelerator，Esc 取消录制。
- 快捷键注册必须走 `registerGlobalShortcut` 的串行队列，不要在组件里直接调用插件 API；并发注册（StrictMode/快速修改）会因注销-注册竞态而失败。
- 外部链接一律通过 `openInExternalBrowser`（tauri-plugin-opener）在系统浏览器打开，不要在 WebView 内导航离开应用。
- 标签删除是“停用”语义：只更新 `Tag.retired`，不要从 entries、draft 或 Notion 内容中移除标签引用；需要真正清理历史时再引入显式的批量操作。
- 抽屉模式依赖 `get_window_work_area` 命令与窗口权限；新增窗口操作时同步更新 capabilities，浏览器预览通过 `isDesktopTauriRuntime` 降级。

### 数据源接口

- UI 层读写日历数据必须通过 `CalendarDataSource`（`src/data-source.ts`），不要在组件里直接调用 `pullNotionEntries` / `pushNotionEntries`；按月加载与月份缓存在 App 的数据 effect 中统一处理。
- 远程查询带 `dateStart`/`dateEnd`/`tag` 条件时由 Notion 服务端过滤；新增筛选维度先扩展 `NotionPullQuery` 与 Rust `build_query_filter`。
- 心情字段是 `CalendarEntry.mood`（emoji 字符串）；Notion 映射到“心情”select 属性，属性不存在时静默忽略。

本地可以使用单元测试验证字段映射和 ID 规范化：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

官方参考：[快速开始](https://developers.notion.com/guides/get-started/quick-start)、[授权与页面分享](https://developers.notion.com/guides/get-started/authorization)、[数据库与 data source](https://developers.notion.com/guides/data-apis/working-with-databases)。

## 5. GitHub Actions

### 普通 CI

`ci.yml` 在 PR 和主分支 push 上运行前端构建、lint、Rust check。

### 跨平台打包

`package.yml` 的桌面 job 使用 `tauri-apps/tauri-action`，Android job 使用官方 Tauri CLI：

```text
checkout → Node 22 → Rust stable → npm ci
Windows/macOS → tauri-action → Workflow Artifact
Android → JDK 17 → Android SDK/NDK → tauri android init --ci → split APK → universal AAB → Artifact
```

当前只上传未签名构建产物。要做正式发布，至少需要：

- Android keystore 及 `ANDROID_KEYSTORE_*` secrets。
- Windows 代码签名证书及密码。
- Apple Developer 证书、App Store Connect / notarization secrets。
- 将 Release job 改为 tag 触发并启用签名。

## 6. 故障排查

### 快捷键无法注册

检查组合键是否被其他应用占用，并在设置页更换。浏览器预览显示“浏览器预览模式”是正常的；只有 Tauri 桌面 runtime 会实际注册全局快捷键。

### 关闭窗口后找不到应用

这是预期行为：窗口会隐藏到托盘。右键托盘图标选择“打开 CalendarMark”；开发时可以从任务栏或终止进程退出。

### Android job 失败

优先检查 Java 17、Android SDK platform/build-tools 和 NDK 版本是否一致，再确认 `tauri android init --ci` 在构建前执行。生成的 `src-tauri/gen/android` 不在仓库中是当前 MVP 的有意选择。

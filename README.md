# CalendarMark

CalendarMark 是一个基于 Tauri 2 的本地优先日历记录工具：用标签标记日期，用文字和图片保存当天的上下文，再通过一个全局快捷键快速回到记录窗口。

> 当前版本是可运行的 MVP：日历、标签、日期记录、图片/文档附件、右侧抽屉动画、Windows/macOS 托盘与快捷键入口已经完成；Notion 已提供真实 API 连接、远程直连读写、本地模式拉取/推送、页面归档和附件上传。

## 产品要点

- **日历总览**：按月查看每个日期的标签、记录数量、心情和附件标记；点击年月可快捷跳转任意月份。
- **常驻记录面板**：窗口模式在日历右侧、抽屉模式在日历下方直接编辑选中日期，不再弹出抽屉层。
- **心情记录**：每条记录可选心情 emoji，显示在日历格子上，并同步到 Notion 的“心情”select 属性（存在时）。
- **标签体系**：停用标签只是不再提供选择，已有记录和远端内容保持不变，可随时恢复；侧栏快捷入口点击标签会列出带该标签的日期，点击日期直接跳转。
- **删除保护**：删除日期记录需要二次确认，避免误触。
- **日期记录**：标题、正文、快捷标签，以及图片、TXT、Markdown、PDF 附件。
- **右侧抽屉**：点击日期打开编辑抽屉，带遮罩和滑入/滑出动画，不打断当前日历上下文。
- **快捷标签**：预置标签可一键切换，也可在抽屉或设置中创建、删除。
- **桌面入口**：Windows/macOS 使用托盘菜单打开主界面、打开设置或退出；关闭窗口默认隐藏到托盘；可在系统设置中开启开机启动。
- **全局快捷键**：默认 `Ctrl/Cmd + Shift + Space`；窗口已聚焦时按下会收起窗口，未聚焦时带回焦点；在系统设置中点击“读取组合键”后直接按下按键即可录制新组合。
- **界面模式**：窗口模式为常规桌面窗口；抽屉模式（桌面端专属）切换为贴屏幕右侧的无边框窄边栏，带滑入动效，可在设置 → 界面中切换。
- **可替换数据源**：设置页提供 Notion、本地存储和后续数据源的统一选择入口；Notion 是当前已实现的外部适配器。
- **Notion 数据源**：选中 Notion 即远程直连；配置时分别选择“日期数据库”（每个日期一条记录，修改即更新那一条）和“设置数据库”（保存标签等设置）。选中本地存储时，可对已配置的 Notion 数据库执行“拉取到本地 / 推送到 Notion”。
- **七牛 Kodo 数据源**：暂时下线。其实时读写依赖源站直读或 CDN 回源，免费额度模型不适合 CalendarMark 的低延迟保存场景；旧配置会保留，但当前数据源会自动回落到本地存储。
- **本地优先**：MVP 使用 WebView 本地存储保存草稿，不依赖服务端即可使用。

## 技术栈

| 层 | 技术 |
| --- | --- |
| UI | React 19 + TypeScript + Vite |
| 桌面壳 | Tauri 2 + Rust |
| 交互图标 | lucide-react |
| 桌面能力 | Tauri tray icon、global-shortcut、autostart、opener、window/event API |
| CI/CD | GitHub Actions + tauri-apps/tauri-action |
| 目标平台 | Windows、macOS、Android（Android Action 中初始化生成工程） |

## 快速开始

### 环境要求

- Node.js 22 LTS 或更新版本
- Rust stable（当前 crate 的最低版本为 1.85）、Cargo
- Windows 桌面开发需要 WebView2 与 Visual Studio C++ Build Tools
- macOS 构建需要 Xcode Command Line Tools
- Android 构建需要 JDK 17、Android SDK、Android NDK；本机没有 Android 工具链时可直接使用 GitHub Actions

### Web 预览

```bash
npm install
npm run dev
```

打开 Vite 输出的地址即可预览全部 UI；浏览器模式不会注册系统全局快捷键和开机启动，但其他日历/抽屉/设置交互仍可使用。

### Tauri 桌面开发

```bash
npm install
npm run tauri:dev
```

桌面端会启用托盘和全局快捷键。关闭主窗口不会退出应用，而是隐藏到托盘；请在托盘右键菜单中选择“退出”。

### Android

本机已配置 Android SDK 时：

```bash
npm run tauri:android:init
npm run tauri:android:dev
npm run tauri:android:build
```

仓库的 Android 工程目录暂不提交，GitHub Actions 会在 Android job 中执行 `tauri android init --ci` 后完成 APK/AAB 构建。

### Notion 在 Android 上连不上的排查

Android 版和桌面版走的是同一套实现（同一个 React 设置页 → 同一个 Tauri IPC 命令 → Rust 侧同一个 reqwest 客户端），官方 Android 模板也已声明 `INTERNET` 权限。因此“桌面能发现数据集、Android 不行”通常是设备网络差异，而不是平台实现差异：

- 手机直连的网络如果无法访问 `api.notion.com`（中国大陆直连常见），请求会失败或超时；桌面机可能因为路由器透明代理而正常。请在手机上开启代理 / VPN，或切换到可直连 Notion 的网络后重试。
- 网络错误会在页面提示“无法建立到 api.notion.com 的连接 / 连接超时”，并附带底层原因；同一信息也会写入 logcat（tag 为 `calendarmark::notion`），可用 `adb logcat -s calendarmark::notion` 查看。
- Notion 请求设置了 10s 建连超时和 30s 请求超时（附件上传 180s），并对 DNS / 建连类瞬时失败自动重试两次，不会出现按钮永久转圈的情况。

## GitHub Actions

工作流位于 `.github/workflows/`：

- `ci.yml`：Pull Request / 主分支执行前端 lint、TypeScript build 和 Rust check。
- `package.yml`：手动触发、主分支推送或 `v*` tag 触发 Windows、macOS、Linux、Android 打包并上传 Workflow Artifacts；tag 构建还会把安装包发布到对应的 GitHub Release 提供下载。

Android job 会安装 JDK 17、Android SDK platform/build-tools/NDK，并使用 `tauri android init --ci` 生成移动端工程。正式发布前建议再接入 Android keystore、Windows code signing 和 Apple signing/notarization secrets。

## 项目结构

```text
.
├── src/                         # React UI、数据模型与本地存储
│   ├── App.tsx                  # 日历、设置、编辑抽屉
│   ├── App.css                  # 视觉系统与响应式布局
│   ├── types.ts                 # Entry / Tag / Attachment / Settings
│   ├── notion.ts                # Notion IPC 类型和同步调用
│   ├── qiniu.ts                 # 七牛 Kodo IPC 封装（暂时下线，保留适配代码）
│   ├── storage.ts               # MVP 本地存储适配层
│   ├── data-source.ts           # 统一数据源接口（本地/Notion；七牛保留为下线适配器）
│   └── tauri.ts                 # 桌面窗口与快捷键桥接
├── src-tauri/
│   ├── src/lib.rs               # 托盘、窗口关闭策略、命令注册
│   ├── src/notion.rs            # Notion API、字段映射、分页、文件上传
│   ├── src/qiniu.rs             # 七牛签名、空间管理、对象读写、用量统计
│   ├── tauri.conf.json          # 桌面/移动端构建配置
│   └── capabilities/            # Tauri 2 权限声明
├── docs/
│   ├── PRODUCT.md               # 产品方案与交互说明
│   ├── ARCHITECTURE.md          # 技术架构、数据模型和安全边界
│   ├── DEVELOPMENT.md           # 开发、验证和发布手册
│   └── ROADMAP.md               # 迭代路线
└── .github/workflows/           # CI 与跨平台打包
```

## Notion 配置说明

在“设置 → 数据源”中选择 Notion，页面会直接展示连接引导：

1. 在 Notion Integrations 创建 Internal connection，并在 Configuration 复制 Installation access token。
2. 打开目标数据库的 `•••` 菜单，选择 Add connections，将该连接加入数据库。
3. 回到 CalendarMark，填入 Token，点击“发现数据集”，在结果中点击“添加数据集”，再选择当前同步目标。不需要手工复制 Database ID。

页面内提供了 [Notion 官方快速开始](https://developers.notion.com/guides/get-started/quick-start)、[授权说明](https://developers.notion.com/guides/get-started/authorization) 和 Integrations 入口。Token 是秘密信息，不应截图、提交到 Git 或发送给他人。CalendarMark 将 Token 保存在当前 WebView 的本机设置中，并由 Rust 侧直接请求 Notion API，不会发送到 CalendarMark 自有服务；正式发布前建议将凭据迁移到系统密钥链，详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

点击“发现数据集”后，CalendarMark 会通过 Notion Search 列出当前 Token 可访问的 data source，并读取所属数据库名称。点击“添加数据集”会把同步目标保存在本机；可以保存多个数据集并随时切换，移除只会删除本机引用，不会删除 Notion 内容。选定数据集后，CalendarMark 会读取 schema。至少需要一个 `title` 类型属性和一个 `date` 类型属性；`rich_text`、`multi_select`、`files` 类型属性会分别映射正文、标签和附件，名称可以是中文或英文，适配器按属性类型自动识别。

如果还没有合适的数据库，可以点击“新建数据库”：Notion API 支持创建数据库，但要求父级必须是连接可访问的页面，因此需要先从 Token 可访问的页面中选择一个父页面，再填写名称。CalendarMark 会自动创建 名称（title）/ 日期（date）/ 内容（rich_text）/ 标签（multi_select）/ 附件（files）五个属性，并把新数据库直接加入数据集列表。

选择 Notion 作为当前数据源时：

1. CalendarMark 启动或切换数据集时按月读取远端页面（Notion query 服务端日期/标签筛选，超过单页 100 条时自动分页），已加载的月份在本地缓存，切换年月不会重复请求。
2. 保存记录会直接创建或更新 Notion 页面；本地附件会直接上传到 Notion File Upload API。
3. 附件首次上传后会保存 Notion 返回的 file upload ID，再次编辑同一条记录时直接复用引用，不会重复上传文件。
4. 删除记录会直接将对应 Notion 页面移入回收站。
5. 远程模式不会把记录和标签写入本机的 entries/tags localStorage。
6. 日历总览工具栏和设置页都提供“重新读取”入口；修改 Token 或点击刷新时会重新读取当前数据集，读取请求带短防抖，输入 Token 不会逐字符发起请求。

选择本地存储作为当前数据源时：

1. 日历继续使用本机数据，保存只写入本地。
2. “本地存储”下方只列出本机已绑定的 Notion 数据集；选择同步目标后可点击“拉取到本地”或“推送到 Notion”。Token、数据集发现和连接引导统一放在 Notion 数据源页配置。
3. 本地模式的删除只删除本地记录，不会因为删除本地记录而自动归档远端页面；需要时再显式推送本地数据。

## 七牛 Kodo 状态说明

七牛 Kodo 已暂时从可用数据源中移除：

1. 设置页不再允许选择七牛，也不会在本地储存页显示七牛同步目标。
2. 已保存的 AccessKey / SecretKey / 空间配置仍保留在本机设置中，便于未来找到更合适的缓存/计费方案后恢复。
3. 旧版本若停留在七牛数据源，升级后会自动切回本地存储，避免继续产生 GET、外网流出或 CDN 回源用量。
4. 历史对象仍留在七牛空间中；需要取回数据时可在七牛控制台导出，或使用包含该功能的旧版本操作后尽快迁回本地/Notion。

## 当前边界

- 本地记录目前使用 WebView localStorage；附件以 Data URL 保存，单个文件限制为 5 MB，适合 MVP 演示，不适合大规模资料库。
- 停用标签不会从历史记录或 Notion 中移除，只影响后续选择；标签管理页提供恢复入口。
- 抽屉模式通过无边框窄窗口实现，窗口几何在切换模式时一次性调整；目前不会随屏幕分辨率变化自动重新贴边。
- 抽屉模式窗口内容整体约束在视口内（顶栏 + 可滚动主区域），设置导航会滚动实际容器并高亮当前分区，不会出现整页滚动条。
- Notion 直连模式会在启动/切换时读取远端，单条保存和删除直接写远程；当前不会在应用后台持续监听 Notion 的外部修改。
- 点击某个日期时，抽屉默认打开该日期最近更新的一条记录；同一日期存在多条记录时，MVP 暂不提供同日多条记录的切换编辑。
- 本地模式的远程同步仍是显式“拉取到本地 / 推送到 Notion”，没有冲突解决；当同一条记录在两端同时修改时，应先拉取确认，再推送本地版本。
- 拉取的 Notion 文件属性使用 Notion 返回的临时下载 URL 预览；本地新附件会上传，附件存储仍会随当前记录写入 WebView localStorage，适合 MVP，不适合大规模资料库。
- Android 共享了 React UI 与数据模型；托盘和桌面全局快捷键只在桌面目标启用。

## 许可证

MIT

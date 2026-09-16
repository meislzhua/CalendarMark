# CalendarMark

CalendarMark 是一个基于 Tauri 2 的本地优先日历记录工具：用标签标记日期，用文字和图片保存当天的上下文，再通过一个全局快捷键快速回到记录窗口。

> 当前版本是可运行的 MVP：日历、标签、日期记录、图片/文档附件、右侧抽屉动画、Windows/macOS 托盘与快捷键入口已经完成；设置页已经按可替换数据源设计，Notion 提供首个外部连接配置入口，真实双向同步将在下一阶段接入。

## 产品要点

- **日历总览**：按月查看每个日期的标签、记录数量和附件标记。
- **日期记录**：标题、正文、快捷标签，以及图片、TXT、Markdown、PDF 附件。
- **右侧抽屉**：点击日期打开编辑抽屉，带遮罩和滑入/滑出动画，不打断当前日历上下文。
- **快捷标签**：预置标签可一键切换，也可在抽屉或设置中创建、删除。
- **桌面入口**：Windows/macOS 使用托盘菜单打开主界面、打开设置或退出；关闭窗口默认隐藏到托盘。
- **全局快捷键**：默认 `Ctrl/Cmd + Shift + Space`，可在设置中修改。
- **可替换数据源**：设置页提供 Notion、本地存储和后续数据源的统一选择入口；当前首个外部适配器为 Notion。
- **本地优先**：MVP 使用 WebView 本地存储保存草稿，不依赖服务端即可使用。

## 技术栈

| 层 | 技术 |
| --- | --- |
| UI | React 19 + TypeScript + Vite |
| 桌面壳 | Tauri 2 + Rust |
| 交互图标 | lucide-react |
| 桌面能力 | Tauri tray icon、global-shortcut、window/event API |
| CI/CD | GitHub Actions + tauri-apps/tauri-action |
| 目标平台 | Windows、macOS、Android（Android Action 中初始化生成工程） |

## 快速开始

### 环境要求

- Node.js 22 LTS 或更新版本
- Rust stable、Cargo
- Windows 桌面开发需要 WebView2 与 Visual Studio C++ Build Tools
- macOS 构建需要 Xcode Command Line Tools
- Android 构建需要 JDK 17、Android SDK、Android NDK；本机没有 Android 工具链时可直接使用 GitHub Actions

### Web 预览

```bash
npm install
npm run dev
```

打开 Vite 输出的地址即可预览全部 UI；浏览器模式不会注册系统全局快捷键，但其他日历/抽屉/设置交互仍可使用。

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

## GitHub Actions

工作流位于 `.github/workflows/`：

- `ci.yml`：Pull Request / 主分支执行前端 lint、TypeScript build 和 Rust check。
- `package.yml`：手动触发、主分支推送或 `v*` tag 触发 Windows、macOS、Android 打包并上传 Workflow Artifacts。

Android job 会安装 JDK 17、Android SDK platform/build-tools/NDK，并使用 `tauri android init --ci` 生成移动端工程。正式发布前建议再接入 Android keystore、Windows code signing 和 Apple signing/notarization secrets。

## 项目结构

```text
.
├── src/                         # React UI、数据模型与本地存储
│   ├── App.tsx                  # 日历、设置、编辑抽屉
│   ├── App.css                  # 视觉系统与响应式布局
│   ├── types.ts                 # Entry / Tag / Attachment / Settings
│   ├── storage.ts               # MVP 本地存储适配层
│   └── tauri.ts                 # 桌面窗口与快捷键桥接
├── src-tauri/
│   ├── src/lib.rs               # 托盘、窗口关闭策略、Tauri 插件初始化
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
3. 将数据库作为整页打开，使用 Share → Copy link，复制 URL 中 workspace 后、`?v=` 前的 32 位字符串作为 Database ID。

页面内提供了 [Notion 官方快速开始](https://developers.notion.com/guides/get-started/quick-start)、[授权说明](https://developers.notion.com/guides/get-started/authorization) 和 Integrations 入口。Token 是秘密信息，不应截图、提交到 Git 或发送给他人。MVP 只将配置保存在本机，不会将令牌发给 CalendarMark 自有服务；真正接入同步时，推荐由 Rust 侧完成 Notion API 请求，并使用系统密钥链保存令牌，详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 当前边界

- 本地记录目前使用 WebView localStorage；附件以 Data URL 保存，单个文件限制为 5 MB，适合 MVP 演示，不适合大规模资料库。
- 数据源选择器和 Notion 连接引导已经完成；当前 Notion 仍是配置预览，真实 API 同步、冲突解决、分页与重试属于下一阶段。
- Android 共享了 React UI 与数据模型；托盘和桌面全局快捷键只在桌面目标启用。

## 许可证

MIT

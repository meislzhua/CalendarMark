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
- 点击“发现数据集”时使用 `POST /search` 的 `object=data_source` 过滤器和游标分页，列出当前 Token 可访问的数据源；用户添加的数据集保存在 `AppSettings.notionDatasets`，可以保存多个并切换。
- 选定数据集后调用 Retrieve a database / Retrieve a data source 读取 schema；数据库包含多个 data source 时仍可从连接结果切换。旧版本只保存 Database ID 的设置仍可兼容读取，并会在成功连接后迁移到数据集列表。
- 字段映射按属性类型优先、按中文/英文名称辅助识别：`title` + `date` 为必需，`rich_text` / `multi_select` / `files` 为可选。
- 查询使用 cursor 分页；429 和 5xx 最多做三次短退避重试。
- 推送时根据本地 `remote.id` 选择创建或更新页面；附件先创建 File Upload，再通过 multipart 上传并写入 `files` 属性。
- 同步是显式拉取/推送，不做后台自动覆盖；冲突和可选字段缺失通过同步警告反馈给用户。

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

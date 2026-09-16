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

当前设置页只保存配置，不请求 Notion。真实接入时请遵循：

- 不在 React 前端直接调用 Notion API。
- 不把 Integration Token 写入日志、错误 toast 或 GitHub Actions 输出。
- 将 Token 放入 Tauri Store 的安全后端或系统 Keychain。
- 为数据库字段建立可配置映射，不假设用户数据库属性名称一定是英文。
- 使用分页和重试；同步结果可解释，冲突需要用户可见。

## 5. GitHub Actions

### 普通 CI

`ci.yml` 在 PR 和主分支 push 上运行前端构建、lint、Rust check。

### 跨平台打包

`package.yml` 的桌面 job 使用 `tauri-apps/tauri-action`，Android job 使用官方 Tauri CLI：

```text
checkout → Node 22 → Rust stable → npm ci
Windows/macOS → tauri-action → Workflow Artifact
Android → JDK 17 → Android SDK/NDK → tauri android init --ci → APK/AAB Artifact
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

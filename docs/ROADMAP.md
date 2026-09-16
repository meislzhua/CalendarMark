# CalendarMark 路线图

## 已完成：MVP（0.1）

- React + TypeScript + Vite 前端。
- Tauri 2 桌面壳与基础权限。
- 月历、日期标签、标题/正文、附件。
- 右侧编辑抽屉和打开/关闭动画。
- 本地存储、主题切换、快捷标签管理。
- Windows/macOS 托盘、关闭隐藏、全局快捷键。
- 可替换数据源选择器（Notion、本地存储、WebDAV/Obsidian 规划位）。
- Notion 配置界面、Token 授权引导、数据集发现/添加/切换和数据映射约定。
- Notion 真实 API 适配器：搜索可访问 data source、连接检查、schema 映射、分页拉取。
- 本地记录推送/更新、Notion 页面归档、File Upload 附件上传和同步警告。
- Windows/macOS/Android GitHub Actions 构建入口。

## 下一步：可靠同步和凭据安全（0.2.x）

- Token 从 WebView localStorage 迁移到系统 Keychain / Windows Credential Manager。
- 拉取/推送冲突对比、离线队列和可恢复重试。
- 可视化字段映射向导，支持同一 data source 中多个候选字段。
- 后台同步策略和最近同步历史。

## 后续：可靠本地资料库（0.3）

- SQLite / Tauri Store 持久化，替代 localStorage。
- 附件移入应用数据目录，不再把原图直接写入记录 JSON。
- 全文搜索、按标签/附件筛选。
- 同一天多条记录与时间线视图。
- 同步冲突对比和手动解决。

## 再后续：发布体验（1.0）

- Windows、macOS 签名与自动更新。
- Android keystore、Play 发布流程。
- 导入/导出 Markdown/JSON。
- 可选的云端备份，但保持本地优先和可迁移。

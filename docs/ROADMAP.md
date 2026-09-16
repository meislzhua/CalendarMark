# CalendarMark 路线图

## 已完成：MVP（0.1）

- React + TypeScript + Vite 前端。
- Tauri 2 桌面壳与基础权限。
- 月历、日期标签、标题/正文、附件。
- 右侧编辑抽屉和打开/关闭动画。
- 本地存储、主题切换、快捷标签管理。
- Windows/macOS 托盘、关闭隐藏、全局快捷键。
- 可替换数据源选择器（Notion、本地存储、WebDAV/Obsidian 规划位）。
- Notion 配置界面、Token/Database ID 获取引导和数据映射约定。
- Windows/macOS/Android GitHub Actions 构建入口。

## 下一步：Notion 连接（0.2）

- 将 provider 状态从配置预览升级为真实连接状态。
- Rust Notion HTTP client 和分页查询。
- Token 使用系统安全存储。
- Database 字段映射向导。
- Database ID → data source ID 发现流程。
- 首次连接的只读拉取和本地预览。
- 本地记录推送、同步状态和失败重试。

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

---
created: 2026-10-13
completed: 2026-10-15
status: delivered
feature: packaging
related:
  - ../decisions/009-构建机的Electron本地路径.md
  - ../decisions/008-打包产物只留最近一份预览.md
---

# 2026-10 Windows 安装包卸载选项与菜单一致性

## 目标

1. 卸载时可选择是否连同本地数据库与缓存一起删除，默认保留。
2. Windows 窗口内不再显示 Edit / Window 菜单，与 macOS 呈现一致。
3. 用新功能重新打包 Windows 安装包。

## 实现

### 卸载数据处理

`build/installer.nsh` 新增自定义卸载页，经 `electron-builder.yml` 的 `nsis.include` 接入。

页面提供单个复选框：勾选则删除 `%APPDATA%\memocraft`（数据库、`data\attachments` 图片、AI 密钥、全部浏览器缓存）；不勾选只移除程序本体。默认不勾选——卸载时保留知识库是安全默认值。

**勾选结果用临时标记文件传递**，不用寄存器或自定义变量。页面离开时把 `delete` / `keep` 写入 `%TEMP%\memocraft-uninstall-choice.txt`，卸载区段读取后立即删除该文件。这样做的原因：

- 寄存器（`$R9`）与自定义 `Var` 在 electron-builder 的宏展开时机下都出现过编译失败或状态丢失（详见下方约束表）；
- **SSH 会话无法渲染 GUI**，勾选路径无法用截图或点击自动化验证；标记文件是可见产物，失败时能区分「没写」与「没读到」；
- 页面未显示时（静默卸载、更新）标记不存在，语义自然退回「保留数据」。

`--delete-app-data` 命令行参数仍然生效，保持与 electron-builder 原有约定一致。

### Windows 菜单

`src/main/index.ts` 改为仅在 darwin 注册应用菜单，其他平台 `Menu.setApplicationMenu(null)`。菜单角色只提供展示入口，撤销/复制/粘贴由 Chromium 原生处理；Microsoft Store 版 Windows 应用同样不显示窗口菜单。

## NSIS 定制约束（再次修改本节前必读）

以下每条都对应一次实际编译失败或线上缺陷，症状多为「只报行号、不报原因」，排查成本很高：

| 约束 | 原因 |
| --- | --- |
| 必须 `!include LogicLib.nsh` | 模板使用 `${If}`/`${IfNot}`，但自身不引入 LogicLib |
| 勾选结果不要用寄存器或自定义 Var 传递 | 宏展开作用域下状态不可靠；自定义 Var 还会触发 `warning 6001`，而 electron-builder 把警告当错误 |
| 页面函数内不引用 `$isDeleteAppData` | `installer.nsi` 第 40 行先加载页面宏，第 131 行才声明该变量 |
| `NSD_GetState` 必须传两个参数 | 少传输出变量时宏展开越界 |
| 不定义 `customRemoveFiles` | 模板在该宏存在时会跳过自带的文件与快捷方式删除逻辑（`uninstaller.nsh` 第 161-163 行 `!ifmacrodef/!else`），导致程序本体删不掉 |
| 顶层不放可执行指令 | 只有 Section/Function 内可执行；顶层 `StrCpy` 报 `not valid outside Section or Function` |

排查方法：删减宏体二分定位；把出问题的宏体复制到独立脚本，用与构建相同的参数（`/INPUTCHARSET UTF8`、`/DAPP_PACKAGE_NAME=...`）单独编译；`!echo` 只对 `!define` 有效，不能用来探测 `!macro` 是否存在。

## 实际验证

构建：`pnpm run package:win --config.electronDist=...`（`clean:release` → `build` → `electron-builder --win nsis`），退出码 0，产物 `Memocraft-0.2.0-x64.exe`（109.61 MB）。

| 场景 | 程序目录 | 数据库 | attachments 图片 | 浏览器缓存 | 更新器缓存 | 标记文件 |
| --- | --- | --- | --- | --- | --- | --- |
| 标记 `delete`（勾选） | 已删 | 已删 | 已删 | 已删 | 已删 | 已清理 |
| 标记 `keep`（不勾选） | 已删 | 保留 | 保留 | — | — | 已清理 |
| 无标记（静默卸载） | 已删 | 保留 | 保留 | — | — | 不存在 |

删除路径用 109 个真实图片文件与数据库一起验证，确认 `data\attachments` 与 `memocraft.sqlite` 均被删除。注册表项、开始菜单与桌面快捷方式在三种场景下都清除（注册表清理在卸载器退出后数秒内完成，过早检查会误判为残留）。

## 已知限制

1. **卸载页的视觉呈现未经人眼确认**：SSH 会话无可渲染的交互式桌面，卸载器进程会立即退出，无法截图；自动化只能验证标记文件的读取分支。复选框是否真的写出 `delete`，需在本机双击卸载器实测一次。
2. **未签名**：安装包无代码签名，Windows 首次运行会提示「未知发布者」。
3. **删除不可恢复**：勾选删除后知识库无法找回，页面文案已明确提示。

## 修订记录

- 2026-10-13：首版用寄存器传递勾选结果，构建通过，但用户实测勾选后数据仍残留，判定为状态未传递到位。
- 2026-10-15：改为标记文件方案，并按用户要求把浏览器缓存一并清除（删除整个 `%APPDATA%\memocraft`，而非只删 `data` 子目录）。

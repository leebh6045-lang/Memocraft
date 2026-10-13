---
created: 2026-10-13
completed: 2026-10-13
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

`build/installer.nsh` 新增自定义卸载页，通过 electron-builder 的 `nsis.include` 接入（`electron-builder.yml`）。

页面提供单个复选框：勾选则删除 `%APPDATA%\memocraft`（数据库、手记图片、AI 密钥、缓存）；不勾选只移除程序本体。默认不勾选——卸载时保留知识库是安全默认值。

删除逻辑不依赖 electron-builder 自带的 `$isDeleteAppData`：模板在 `uninstaller.nsh` 的 Section 内部（第 216 行）才声明该变量，而 `customUnInstall` 在第 157 行展开，早于声明；引用它会得到「只报行号、不报原因」的编译失败，由本文件提前声明又会与模板冲突（`variable already declared`）。因此本文件自己承接勾选结果并执行删除，删除目标与模板保持一致，并保留 `--delete-app-data` 命令行参数语义。

### Windows 菜单

`src/main/index.ts` 改为仅在 darwin 注册应用菜单，其他平台 `Menu.setApplicationMenu(null)`。菜单角色只提供展示入口，撤销/复制/粘贴由 Chromium 原生处理；Microsoft Store 版 Windows 应用同样不显示窗口菜单。

## NSIS 定制约束（再次修改本节前必读）

以下每条都对应一次实际编译失败，症状都是「只报行号、不报原因」，排查成本很高：

| 约束 | 原因 | 症状 |
| --- | --- | --- |
| 必须 `!include LogicLib.nsh` | electron-builder 模板使用 `${If}`/`${IfNot}`，但自身不引入 LogicLib | 模板报未定义宏 |
| 勾选状态用内置寄存器 `$R9` 传递，不用自定义 `Var` | 自定义变量在宏展开时的可见性受 include 注入时机影响 | `Error in macro customUnInstall on macroline N` |
| 页面函数内不引用 `$isDeleteAppData` | `installer.nsi` 第 40 行先加载页面宏，第 131 行才声明该变量 | 同上，行号指向 `StrCpy` |
| `NSD_GetState` 必须传两个参数 | 少传输出变量时宏展开越界 | 行号指向该调用 |
| 不定义 `customRemoveFiles` | 模板在该宏存在时跳过自带的文件与快捷方式删除逻辑（`uninstaller.nsh` 第 161-163 行 `!ifmacrodef/!else`） | 程序本体删不掉 |
| 不要期望 makensis 打印具体原因 | 未声明变量、参数不足等都只给行号 | 需用二分/最小化实验定位 |

排查方法：删减宏体二分定位；`/V4` 加 `!echo` 观察；把出问题的宏体复制到独立脚本，用与构建相同的参数（`/INPUTCHARSET UTF8`、`/DAPP_PACKAGE_NAME=...`）单独编译。

## 实际验证

构建：`pnpm run package:win --config.electronDist=...`（`clean:release` → `build` → `electron-builder --win nsis`），退出码 0，产物 `Memocraft-0.2.0-x64.exe`（109.61 MB）。

| 项目 | 结果 |
| --- | --- |
| NSIS 编译 | 通过；`oneClick=false perMachine=false`（向导与自选路径保留） |
| 菜单改动进入产物 | `out/main/index.js` 含 `setApplicationMenu(null)` |
| 默认卸载（不勾选） | 程序目录、开始菜单与桌面快捷方式、注册表项全部清除；**数据目录与哨兵文件保留** |
| `--delete-app-data` 卸载 | 上述全部清除，**数据目录与哨兵文件一并删除**；更新器缓存 `%LOCALAPPDATA%\memocraft-updater` 清除 |
| 卸载器时序 | 注册表清理在卸载器退出后数秒内完成；过早检查会看到「残留」，属误判 |

验证方式：在真实用户目录放置哨兵文件 `%APPDATA%\memocraft\data\canary.txt`，对比两种卸载后它是否存在。删除路径通过 `--delete-app-data` 参数验证——该分支与复选框设置的是同一处置逻辑。

## 已知限制

1. **卸载页的视觉呈现未经人眼确认**：SSH 会话无可渲染的交互式桌面，卸载器进程会立即退出，无法截图；自动化只能验证命令行分支。页面文案与勾选行为需在本机双击卸载器确认一次。
2. **未签名**：安装包无代码签名，Windows 首次运行会提示「未知发布者」，需手动允许。
3. **删除不可恢复**：勾选删除后知识库无法找回，页面文案已明确提示。

## 后续建议

- 若将来启用应用内自动更新，注意模板对 `isUpdated` 场景的保护：更新时不应触发数据删除。当前实现只在用户勾选或显式传参时删除，未显示页面时保持默认的保留语义。
- 本节 NSIS 约束建议在改动 `build/installer.nsh` 前完整重读。

---
created: 2026-10-12
status: accepted
feature: packaging
related:
  - ../features/ai/2026-10-AI接入-交付.md
  - 008-打包产物只留最近一份预览.md
---

# 009：构建机的 Electron 本地路径不进共享配置

## 问题

国内网络下 `@electron/get` 即使配了镜像，仍会去 GitHub 拉校验和，这个小请求会被限速卡到 electron-builder 的 10 分钟单请求超时，导致打包失败。Windows 构建机因此改为直接使用本机已下载的 Electron 目录。

之前的做法是把 `electronDist: D:/Appout/.cache/electron/electron-v44.4.3-win32-x64` 写进 `electron-builder.yml`。这是一个本机绝对路径，进入共享配置后，任何其他机器（本机 macOS）执行 `pnpm run package:dir` / `package:dmg` 都会在打包阶段直接失败：

```
⨯ The specified electronDist does not exist:
  /Users/ly/.../Memocraft/D:/Appout/.cache/electron/electron-v44.4.3-win32-x64
```

macOS 上表现为 dmg 与目录包都停在 21:38 那次构建，`release/<功能>/mac-arm64/` 只剩空目录。

## 选择

`electron-builder.yml` 只保留平台无关的 `electronDownload.mirror`。需要跳过联网下载的机器在命令上临时指定：

```sh
pnpm run package:win --config.electronDist=D:/Appout/.cache/electron/electron-v44.4.3-win32-x64
```

字段覆盖必须写成 `--config.<键>=<值>`：electron-builder 的 `-c` / `--config` 是「指定配置文件路径」的选项，`-c.electronDist=...` 会被当成一个要打开的文件，报 `ENOENT: no such file or directory, open '...\.electronDist=...'`。参数直接跟在脚本名后即可，不要加 `--`（加了会把覆盖项交给脚本而不是 electron-builder）。

`package:win` 脚本内部是 `pnpm clean:release && pnpm build && electron-builder --win nsis`，覆盖项由 pnpm 透传给链末的 electron-builder。若透传仍不生效，可绕过脚本分三步执行：`pnpm clean:release`、`pnpm build`，再直接调用 `node_modules\.bin\electron-builder --win nsis --config.electronDist=<路径>`。

## 原因与代价

理由与 [开发准则](../开发准则.md) 第 9 节一致：本机绝对路径不进入业务配置和源码，环境相关选项集中且可替换。这样 macOS 与 Windows 都能打包，Electron 版本仍由 `package.json` 的 `devDependencies.electron` 决定，不存在漂移。

代价是 Windows 打包命令变长，且那台机器必须记住这个参数（或在自己的本地未提交改动里保留该行，但不能提交）。若那台机器忘了传，打包会退回镜像下载，可能再次撞上校验和超时。

## 重新评估条件

镜像连校验和也不可靠时，改为在构建机上预置官方 zip 并让 `@electron/get` 走本地缓存目录，或用独立于仓库的平台配置文件（`electron-builder.mac.yml` / `electron-builder.win.yml`）分别维护；在那之前不引入第二份配置。

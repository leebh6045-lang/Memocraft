---
created: 2026-10-15
status: delivered
feature: packaging
related:
  - ../features/packaging/2026-10-Windows安装包卸载选项-交付.md
  - ../decisions/009-构建机的Electron本地路径.md
---

# Mac 远程构建 Windows 安装包操作手册

在 macOS 上通过 SSH 驱动机器上的一台 Windows，完成 Memocraft 的 Windows `.exe` 安装包构建与取回。

本文所有命令均在实际构建中验证过。命令里的 `win` 是 SSH 别名，`D:\code\Memocraft-win` 是构建机上的项目目录，按自己的环境替换即可。

---

## 0. 一次性准备（只需做一次）

### 0.1 建立 SSH 免密连接

Windows 端安装 OpenSSH Server（管理员 PowerShell）：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

Mac 端生成专用密钥并部署公钥（Windows 管理员 PowerShell，账户属于 Administrators 组时必须用这个文件）：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/Windows_Key -C "mac-to-windows" -N ""
cat ~/.ssh/Windows_Key.pub
```

```powershell
$key = "<粘贴上面输出的整行>"
Add-Content -Force -Path "$env:ProgramData\ssh\administrators_authorized_keys" -Value $key
icacls.exe "$env:ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "*S-1-5-32-544:F" /grant "*S-1-5-18:F"
Restart-Service sshd
```

Mac 端 `~/.ssh/config`：

```sshconfig
Host win
    HostName <Windows 主机名>.local
    AddressFamily inet
    ConnectTimeout 5
    User <Windows 用户名>
    IdentityFile ~/.ssh/Windows_Key
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

验证：

```bash
ssh win 'hostname; whoami'
```

> **主机名会变的情况**：动态分配 IP 时优先用 `<主机名>.local`，同一局域网内换网段也能解析；若 `.local` 解析失败（部分企业 WiFi 屏蔽多播），退回固定 IP。
>
> **本手册写作时那台 Windows 主机已更换 IP（原 `192.168.5.14` 不可达，主机名 `ly.local` 解析失败），网段内另一台 Windows 又不接受本文的密钥。** 所以下文出现的任何 IP 都是占位示例，请先用 `nc -vz -G 3 <IP> 22` 与 `ssh-keyscan` 确认目标主机，再更新 `~/.ssh/config` 的 `HostName`。

### 0.2 在 Windows 上准备工具链

`node` 必须是 **24.x**（项目 `engines` 要求 `>=24.15.0 <25`），`pnpm` 用项目 `packageManager` 指定的 **11.4.0**。

本次做法是把 Node 解压到 `D:\Appout\tools\node\`，pnpm 用 corepack 拉取，不依赖系统级安装。装好后确认：

```bash
ssh win 'D:\Appout\tools\node\node-v24.21.0-win-x64\node.exe -v'
```

预期 `v24.21.0`。

### 0.3 首次构建：预置离线依赖（关键）

electron-builder 首次打包要下载 4 样东西，而 **GitHub 的 release 资产在国内经常被限速到 100KB/s**，158MB 的 Electron 包会直接撞上 electron-builder 的 10 分钟单请求超时。一次性把它们放到本地（路径按 `electron-builder.yml` 与下列约定）：

| 内容 | 放置位置 |
| --- | --- |
| Electron Windows 二进制 | `D:\Appout\.cache\electron\electron-v<版本>-win32-x64\electron-v<版本>-win32-x64.zip` |
| NSIS 工具链 | `D:\Appout\.cache\electron-builder\nsis-3.0.4.1\nsis-3.0.4.1.7z` |
| NSIS 资源 | `D:\Appout\.cache\electron-builder\nsis-resources-3.4.1\nsis-resources-3.4.1.7z` |
| winCodeSign | `D:\Appout\.cache\electron-builder\winCodeSign-2.6.0\winCodeSign-2.6.0.7z` |
| NSIS bundle（新版格式） | `D:\Appout\.cache\electron-builder\nsis@3.12\nsis-bundle-3.12.tar.gz` |

Electron 的 zip 可直接从 `https://registry.npmmirror.com/-/binary/electron/v<版本>/` 取，**下载后务必对照官方 `SHASUMS256.txt` 校验 SHA256**。其余工具包可从 npmmirror 的 `electron-builder-binaries` 镜像取，同样校验。

### 0.4 关闭 CRLF 换行转换

Windows 的 git 全局 `core.autocrlf=true` 会把检出文件转成 CRLF，导致 `pnpm format:check` 报上百个文件格式错误（**代码本身没问题**）。在构建机的项目目录里关掉：

```bash
ssh win 'git -C D:\code\Memocraft-win config core.autocrlf false; git -C D:\code\Memocraft-win config core.eol lf'
```

---

## 1. 每次构建的标准流程

### 第 1 步：Mac 侧确认代码可构建

不要跳过这步——省得把编译不过的代码送到 Windows 上才发现。

```bash
cd /path/to/Memocraft
pnpm build
```

预期末行 `✓ built in ...`，退出码 0。

### 第 2 步：把当前工作区同步到 Windows

**必须包含未提交改动**（否则打出来的是旧代码）。打包时排除 `node_modules`、`out`、`release` 等生成物：

```bash
# 关闭 macOS 的 AppleDouble 元数据生成，否则会产生大量 ._ 文件
COPYFILE_DISABLE=1 tar --disable-copyfile \
  --exclude='./node_modules' --exclude='./.git' --exclude='./out' \
  --exclude='./release' --exclude='./test-results' --exclude='./playwright-report' \
  --exclude='./.local' --exclude='./.pnpm-store' --exclude='./.DS_Store' --exclude='./.idea' \
  -czf /tmp/memocraft-src.tar.gz .

scp /tmp/memocraft-src.tar.gz win:'D:/Appout/memocraft-src.tar.gz'
```

在 Windows 上解压（先清掉旧源码目录，避免删除的文件残留）：

```bash
ssh win 'Remove-Item "D:\code\Memocraft-win\src","D:\code\Memocraft-win\build","D:\code\Memocraft-win\migrations","D:\code\Memocraft-win\scripts" -Recurse -Force -ErrorAction SilentlyContinue; tar -xzf "D:\Appout\memocraft-src.tar.gz" -C "D:\code\Memocraft-win"'
```

> 若已用 `COPYFILE_DISABLE=1`，通常不会再出现 `._*`；保险起见可检查：`ssh win 'Get-ChildItem D:\code\Memocraft-win -Recurse -Force | Where-Object Name -like "._*"'`。这些文件不会被应用读取（迁移只匹配 `^\d{3}_[a-z0-9_]+\.sql$`），但会被打进安装包，应当清掉。

### 第 3 步：安装依赖

```bash
ssh win 'cd D:\code\Memocraft-win
$env:Path = "D:\Appout\tools\node\bin;D:\Appout\tools\node\node-v24.21.0-win-x64;" + $env:Path
corepack pnpm install --frozen-lockfile'
```

`corepack pnpm` 会按 `package.json` 的 `packageManager` 字段自动取 **pnpm 11.4.0**。依赖未变时这步只需几秒。

### 第 4 步：构建并打包

```bash
ssh win 'cd D:\code\Memocraft-win
$env:Path = "D:\Appout\tools\node\bin;D:\Appout\tools\node\node-v24.21.0-win-x64;" + $env:Path
$env:ELECTRON_BUILDER_CACHE = "D:\Appout\.cache\electron-builder"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
corepack pnpm run package:win --config.electronDist=D:/Appout/.cache/electron/electron-v44.4.3-win32-x64'
```

三条命令的作用：

| 命令 / 变量 | 作用 |
| --- | --- |
| `pnpm run package:win` | 依次执行 `clean:release` → `build` → `electron-builder --win nsis` |
| `--config.electronDist=...` | 指向本地已下载的 Electron 目录，跳过联网下载与校验（**必须有**，否则会撞 GitHub 限速） |
| `ELECTRON_BUILDER_CACHE` | 让 electron-builder 去 D 盘找 NSIS/winCodeSign 缓存 |
| `CSC_IDENTITY_AUTO_DISCOVERY=false` | 没有签名证书，跳过自动发现，避免无意义报错 |

> **参数语法**：字段覆盖必须写成 `--config.<键>=<值>`。写成 `-c.<键>=<值>` 会被 electron-builder 当成配置文件路径，报 `ENOENT: ...\.electronDist=...`。

### 第 5 步：等待并确认产物

NSIS 压缩约需 1–3 分钟。产物在：

```
D:\code\Memocraft-win\release\Memocraft-<版本>-x64.exe
```

确认命令：

```bash
ssh win 'Get-ChildItem "D:\code\Memocraft-win\release" -Filter "*.exe" | Select-Object Name,Length,LastWriteTime'
```

### 第 6 步：取回 Mac

```bash
scp win:'D:/code/Memocraft-win/release/Memocraft-0.2.0-x64.exe' ~/Downloads/
```

---

## 2. 长构建：避免 SSH 断开导致构建被终止

数分钟的构建容易撞上 SSH 超时。**不要用 `Start-Process` 起后台构建**——它仍是 SSH 会话的子进程，会话结束就被连带杀掉（实测会在 NSIS 阶段留下半成品 `memocraft-0.2.0-x64.nsis.7z`）。

用任务计划程序托管，进程完全脱离会话：

```bash
# 1) 把构建写成脚本
#    D:\Appout\run-build.ps1 内容见下方

# 2) 创建并运行一次性任务
ssh win 'schtasks /Create /TN MemoBuild /TR "powershell -NoProfile -ExecutionPolicy Bypass -File D:\Appout\run-build.ps1" /SC ONCE /ST 23:59 /F; schtasks /Run /TN MemoBuild'

# 3) 轮询日志
ssh win 'Get-Content D:\Appout\logs\build-now.log -Tail 5'

# 4) 用完删除任务
ssh win 'schtasks /Delete /TN MemoBuild /F'
```

`D:\Appout\run-build.ps1` 内容：

```powershell
Set-Location D:\code\Memocraft-win
$env:Path = "D:\Appout\tools\node\bin;D:\Appout\tools\node\node-v24.21.0-win-x64;" + $env:Path
$env:ELECTRON_BUILDER_CACHE = "D:\Appout\.cache\electron-builder"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
$log = "D:\Appout\logs\build-now.log"
"[$(Get-Date -Format s)] === package:win ===" | Set-Content $log -Encoding UTF8
corepack pnpm run package:win --config.electronDist=D:/Appout/.cache/electron/electron-v44.4.3-win32-x64 *>&1 | Out-File -FilePath $log -Append -Encoding UTF8
"exit=$LASTEXITCODE" | Add-Content $log
"[$(Get-Date -Format s)] === DONE ===" | Add-Content $log
```

判断成功的标志：日志出现 `exit=0` 与 `=== DONE ===`，且 `release\*.exe` 的修改时间是本次构建。

---

## 3. 产物验证（强烈建议）

### 3.1 安装包基本检查

```bash
ssh win '$exe="D:\code\Memocraft-win\release\Memocraft-0.2.0-x64.exe"; (Get-AuthenticodeSignature $exe).Status; (Get-Item $exe).VersionInfo.FileVersion'
```

未签名时状态为 `NotSigned`，属预期（未购买代码签名证书）。

### 3.2 安装 → 启动 → 数据库迁移

用静默参数装到临时目录：

```bash
ssh win '$t="D:\Appout\verify\install"; Start-Process "D:\code\Memocraft-win\release\Memocraft-0.2.0-x64.exe" -ArgumentList "/S","/D=$t" -Wait; Start-Sleep 5; Test-Path "$t\Memocraft.exe"; (Get-ChildItem "$t\resources\migrations" -Filter "*.sql").Count'
```

迁移文件数量必须等于 `src/storage/schema.ts` 里的 `SCHEMA_VERSION`——**少一个应用就会拒绝打开数据库**（`assertMigrationCount`）。

启动冒烟（用隔离目录，不碰真实知识库）：

```bash
ssh win '$env:MEMOCRAFT_DATA_DIR="D:\Appout\verify\data"; $env:MEMOCRAFT_USER_DATA_DIR="D:\Appout\verify\shell"; $p=Start-Process "D:\Appout\verify\install\Memocraft.exe" -PassThru; Start-Sleep 15; if (Get-Process -Id $p.Id -EA SilentlyContinue) { "存活"; Stop-Process -Id $p.Id -Force } else { "已退出" }; Test-Path "D:\Appout\verify\data\memocraft.sqlite"'
```

### 3.3 卸载行为

见 [Windows 安装包卸载选项交付](2026-10-Windows安装包卸载选项-交付.md) 的验证矩阵。快速自查：

- 默认卸载：程序目录、快捷方式、注册表项清除；`%APPDATA%\memocraft` 保留
- 勾选删除：`%APPDATA%\memocraft` 整体消失，含 `data\attachments` 图片与浏览器缓存

> 注意：注册表项在卸载器退出后数秒才清完，过早检查会误判为残留。

### 3.4 交付前清理

```bash
ssh win 'Remove-Item "D:\Appout\verify" -Recurse -Force -EA SilentlyContinue; Remove-Item "$env:APPDATA\memocraft" -Recurse -Force -EA SilentlyContinue'
```

---

## 4. 发布到 GitHub

```bash
gh release create v0.2.0 ~/Downloads/Memocraft-0.2.0-x64.exe \
  --title "Memocraft 0.2.0" --notes "Windows 安装包"
```

或只上传到已有 release：`gh release upload v0.2.0 <文件路径>`。

---

## 5. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `ssh win` 报 `Could not resolve hostname` | mDNS 名失效或主机离线 | 改用 IP；`nc -vz -G 3 <IP> 22` 确认可达 |
| `Permission denied (publickey)` | 公钥未部署到 `administrators_authorized_keys`，或该文件 ACL 过宽 | 重做 0.1；用 `icacls` 收紧 ACL |
| `pnpm format:check` 报上百文件 | Windows 的 `core.autocrlf=true` 转成 CRLF | 按 0.4 关闭 |
| electron-builder 卡在 `packaging` 十分钟后超时 | 正在从 GitHub 下载 Electron/校验和 | 按 0.3 预置，并确认命令带 `--config.electronDist` |
| 报 `ENOENT: ...\.electronDist=...` | 参数写成了 `-c.electronDist=` | 改成 `--config.electronDist=` |
| 报 `configuration.win should be one of these: null` | `nsis` 配置写进了 `win` 段 | `nsis` 必须是顶层键 |
| 安装后应用启动即退出/报迁移数量不一致 | `migrations` 目录文件数与 `SCHEMA_VERSION` 不符 | 检查是否漏传或混入多余 `.sql` |
| `warning 6001` 导致构建失败 | electron-builder 把 NSIS 警告当错误 | 见卸载选项交付文档的「NSIS 定制约束」表 |
| 构建进程在 SSH 断开后消失 | 后台进程仍属会话子进程 | 改用 2 节的任务计划程序方式 |
| `Get-Process` 找不到卸载器 PID | SSH 会话无可渲染桌面，GUI 进程立即退出 | 属预期；GUI 行为需在本机双击验证 |

### 关于 `.local` 解析与 IP 变化

mDNS 只在同一局域网内有效，且部分企业/公共 WiFi 会屏蔽多播。遇到解析失败：

```bash
dscacheutil -q host -a name <主机名>.local   # 能看到 IP 说明解析正常
ping -c 2 <主机名>.local
```

解析不出来就退回用 IP，并在 `~/.ssh/config` 里把 `HostName` 改成 IP。

---

## 6. 一页速查

```bash
# 1. 本地验证
cd /path/to/Memocraft && pnpm build

# 2. 同步源码（含未提交改动）
COPYFILE_DISABLE=1 tar --disable-copyfile --exclude='./node_modules' --exclude='./.git' \
  --exclude='./out' --exclude='./release' --exclude='./test-results' \
  --exclude='./.local' --exclude='./.pnpm-store' --exclude='./.idea' \
  -czf /tmp/memocraft-src.tar.gz .
scp /tmp/memocraft-src.tar.gz win:'D:/Appout/memocraft-src.tar.gz'
ssh win 'tar -xzf "D:\Appout\memocraft-src.tar.gz" -C "D:\code\Memocraft-win"'

# 3. 构建
ssh win 'cd D:\code\Memocraft-win
$env:Path = "D:\Appout\tools\node\bin;D:\Appout\tools\node\node-v24.21.0-win-x64;" + $env:Path
$env:ELECTRON_BUILDER_CACHE = "D:\Appout\.cache\electron-builder"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
corepack pnpm install --frozen-lockfile
corepack pnpm run package:win --config.electronDist=D:/Appout/.cache/electron/electron-v44.4.3-win32-x64'

# 4. 取回
scp win:'D:/code/Memocraft-win/release/Memocraft-0.2.0-x64.exe' ~/Downloads/

# 5. 发布
gh release create v0.2.0 ~/Downloads/Memocraft-0.2.0-x64.exe --title "Memocraft 0.2.0"
```

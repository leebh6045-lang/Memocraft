; Memocraft 卸载选项页面与本地数据清理。
;
; 需求：卸载时可选择只移除程序，或连同本地数据一起删除；默认保留数据。
; 目标：无论是否勾选，卸载后都不留程序残留；勾选时 %APPDATA%\memocraft 必须整体消失。
;
; ── 为什么用「文件标记」而不是寄存器/变量传递勾选结果 ──────────────────────────
; 寄存器（$R9）与自定义 Var 都试过：前者状态传递不可靠，后者触发编译失败（见下方约束）。
; 更关键的是 SSH 会话无法渲染 GUI，勾选路径无法自动化验证。改为在页面离开时把结果写入
; 临时标记文件，卸载区段读取后删除它：
;   - 不依赖任何宏展开作用域规则；
;   - 有文件产物可直接验证，失败时能区分「没写」还是「没读到」；
;   - 页面未显示时（静默卸载、更新）标记不存在，语义自然退回「保留数据」。
;
; ── 编译约束（每条都对应一次实际失败，改动前必读）────────────────────────────
;   1. 必须 !include LogicLib.nsh：electron-builder 模板使用 ${If}/${IfNot}，但自身不引入。
;   2. customUnInstall 在 Section 内展开（uninstaller.nsh 第 157 行），NSIS 不允许在 Section
;      内声明 Var，宏内也不要引用自定义变量或模板变量。
;   3. 页面函数内不引用 $isDeleteAppData：installer.nsi 第 40 行先加载页面宏、第 131 行才
;      声明该变量；提前引用只会得到「只报行号、不报原因」的编译失败。
;   4. NSD_GetState 必须传两个参数（控件句柄、输出变量）。
;   5. 不定义 customRemoveFiles：模板在该宏存在时会跳过自带的文件与快捷方式删除逻辑
;      （uninstaller.nsh 第 161-163 行 !ifmacrodef/!else），会导致程序本体删不掉。
;   6. 顶层不要放可执行指令（如 StrCpy），只在 Section/Function 内执行。

!include nsDialogs.nsh
!include LogicLib.nsh

!define MEMO_MARKER_FILE "memocraft-uninstall-choice.txt"

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME

  UninstPage custom un.MemoUninstallOptionsPageCreate un.MemoUninstallOptionsPageLeave

  Function un.MemoUninstallOptionsPageCreate
    !insertmacro MUI_HEADER_TEXT "卸载 Memocraft" "请选择本地数据的处理方式。"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 28u "卸载会移除应用本体、桌面与开始菜单快捷方式。$\r$\n本地数据默认保留，便于以后重装继续使用。"

    ${NSD_CreateCheckbox} 0 36u 100% 22u "同时删除本地全部数据（知识库数据库、手记图片、AI 密钥与缓存）"
    Pop $1
    ${NSD_SetState} $1 ${BST_UNCHECKED}

    ${NSD_CreateLabel} 0 64u 100% 26u "不勾选：仅移除程序，知识库与缓存留在用户目录，重装后可继续使用。$\r$\n勾选：知识库一并永久删除，无法恢复。"

    nsDialogs::Show
  FunctionEnd

  ; 离开页面时把勾选结果写成标记文件。页面未显示时不会执行，等价于默认「保留」。
  Function un.MemoUninstallOptionsPageLeave
    ${NSD_GetState} $1 $0
    ClearErrors
    FileOpen $1 "$TEMP\${MEMO_MARKER_FILE}" w
    ${IfNot} ${Errors}
      ${If} $0 == ${BST_CHECKED}
        FileWrite $1 "delete"
      ${Else}
        FileWrite $1 "keep"
      ${EndIf}
      FileClose $1
    ${EndIf}
  FunctionEnd
!macroend

; 读取标记文件决定是否删除本地数据，读取后立即删除标记，避免影响下一次卸载。
; 未显示页面（静默卸载、更新）时标记不存在，默认保留；命令行传 --delete-app-data 仍可强制
; 删除，保持与 electron-builder 原有约定一致。
!macro customUnInstall
  StrCpy $0 "keep"

  ClearErrors
  FileOpen $1 "$TEMP\${MEMO_MARKER_FILE}" r
  ${IfNot} ${Errors}
    FileRead $1 $2
    FileClose $1
    Delete "$TEMP\${MEMO_MARKER_FILE}"
    ${If} $2 == "delete"
      StrCpy $0 "delete"
    ${EndIf}
  ${EndIf}

  ClearErrors
  ${GetParameters} $3
  ${GetOptions} $3 "--delete-app-data" $4
  ${IfNot} ${Errors}
    StrCpy $0 "delete"
  ${EndIf}

  ${If} $0 == "delete"
    ; electron 的 userData 固定走每用户目录，与安装模式无关；模板对 all-users 场景也切到 current。
    SetShellVarContext current
    ; 整体删除用户数据目录：数据库、attachments 图片、AI 密钥与全部浏览器缓存都在其下。
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    ; 更新器缓存的安装包副本（%LOCALAPPDATA%\<应用名>-updater，约一份安装包体积）。
    RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
    SetShellVarContext all
  ${EndIf}
!macroend

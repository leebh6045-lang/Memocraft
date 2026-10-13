; Memocraft 卸载选项页面与数据处理。
;
; 需求：卸载时由用户选择「仅移除程序」还是「连同本地数据一起删除」。默认保留数据。
;
; 为什么自己删数据、不用 electron-builder 自带的 $isDeleteAppData：
;   模板在 uninstaller.nsh 的 Section 内部（第 216 行）才 `Var /GLOBAL isDeleteAppData`，
;   而 customUnInstall 在第 157 行展开，早于该声明；引用它会得到「只报行号、不报原因」的
;   编译失败，提前声明又会与模板的声明冲突（variable already declared）。因此这里用本文件
;   自己的变量承接勾选结果，并自行删除，行为边界完全可见。
;   删除目标与模板一致：$APPDATA 下的应用数据目录（数据库、手记图片、AI 密钥与缓存）。
;
; 其他实现约束（每条都对应一次实际编译失败，改动前请保留）：
;   1. LogicLib 必须由本文件引入：electron-builder 的模板使用 ${If}/${IfNot}，但自身不引入。
;   2. 勾选结果保存在本文件顶层声明的变量里；页面函数内不要引用模板变量（见上）。
;   3. NSD_GetState 必须传两个参数（控件句柄、输出变量）。
;   4. 不定义 customRemoveFiles：模板在该宏存在时会跳过自带的文件与快捷方式删除逻辑
;      （uninstaller.nsh 第 161-163 行的 !ifmacrodef/!else），会导致程序本体删不掉。
;
; 执行顺序：customUnInstall 在卸载区段内、自带文件删除之前执行，因此这里的删除不会与
; 模板后续的删除冲突（模板仍会按自己的逻辑清理 $APPDATA，重复删除是幂等的）。

!echo "MEMO_INCLUDE_LOADED"

!include nsDialogs.nsh
!include LogicLib.nsh

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
    ${NSD_OnClick} $1 un.MemoDeleteDataOnClick

    ; 默认保留数据：勾选前保持 "0"。
    StrCpy $R9 "0"

    ${NSD_CreateLabel} 0 64u 100% 26u "不勾选：仅移除程序，知识库与缓存留在用户目录，重装后可继续使用。$\r$\n勾选：知识库一并永久删除，无法恢复。"

    nsDialogs::Show
  FunctionEnd

  Function un.MemoDeleteDataOnClick
    ${NSD_GetState} $1 $R9
  FunctionEnd

  Function un.MemoUninstallOptionsPageLeave
    ${NSD_GetState} $1 $R9
  FunctionEnd
!macroend

; 按勾选结果删除本地数据。未显示页面时（静默卸载、更新场景）状态保持 "0"，即保留数据；
; 命令行传 --delete-app-data 时同样执行删除，保持与 electron-builder 原有约定一致。
!macro customUnInstall
  StrCpy $0 $R9

  ClearErrors
  ${GetParameters} $1
  ${GetOptions} $1 "--delete-app-data" $2
  ${IfNot} ${Errors}
    StrCpy $0 "1"
  ${EndIf}

  ${If} $0 == ${BST_CHECKED}
    ; electron 的 userData 固定走每用户目录，模板对 all-users 安装也切到 current 上下文。
    SetShellVarContext current
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
    SetShellVarContext all
  ${EndIf}
!macroend

; Keep process checks scoped to the executable in this install directory.
; Tauri's default CheckIfAppIsRunning macro matches by image name alone.
!define LoliCodeProcessGuardPath "${__FILEDIR__}\lolicode-process-guard.ps1"

!macro LoliCodePrepareProcessGuard
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${LoliCodeProcessGuardPath}"
!macroend

!macro LoliCodeRunProcessGuard binaryName
  !define LoliCodeGuardId ${__LINE__}
  IfSilent lolicode_guard_silent_${LoliCodeGuardId} lolicode_guard_interactive_${LoliCodeGuardId}

  lolicode_guard_interactive_${LoliCodeGuardId}:
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\lolicode-process-guard.ps1" -InstallDirectory "$INSTDIR" -BinaryName "${binaryName}"' $0
    Goto lolicode_guard_done_${LoliCodeGuardId}

  lolicode_guard_silent_${LoliCodeGuardId}:
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "$PLUGINSDIR\lolicode-process-guard.ps1" -InstallDirectory "$INSTDIR" -BinaryName "${binaryName}" -Silent' $0

  lolicode_guard_done_${LoliCodeGuardId}:
  ${If} $0 != 0
    ${If} $0 == 1
      Abort "LoliCode is running in this folder. Close it and retry the installation."
    ${Else}
      Abort "LoliCode could not be closed safely. Close it manually and retry the installation."
    ${EndIf}
  ${EndIf}

  !undef LoliCodeGuardId
!macroend

; Tauri invokes this before its own process check and before replacing files.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro LoliCodePrepareProcessGuard

  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName == "tai-switch.exe"
    !insertmacro LoliCodeRunProcessGuard "$OldMainBinaryName"
  ${ElseIf} $OldMainBinaryName != "LoliCode.exe"
  ${AndIf} $OldMainBinaryName != ""
    ; Never let an unexpected registry value become a path to delete later.
    StrCpy $OldMainBinaryName ""
    ; Tauri reads this value again immediately before deleting the old binary.
    WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" ""
  ${EndIf}
!macroend

; The same scoped check applies to uninstall. Its process check runs after this hook.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro LoliCodePrepareProcessGuard
!macroend

; Replace Tauri's basename-only process check with a full-path check.
!macro /redef CheckIfAppIsRunning executableName productName
  !if "${executableName}" == "LoliCode.exe"
    !insertmacro LoliCodeRunProcessGuard "LoliCode.exe"
  !else
    !error "Unexpected process check target: ${executableName}"
  !endif
!macroend

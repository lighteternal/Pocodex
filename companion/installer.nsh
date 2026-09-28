!macro customUnInstall
  ${If} ${FileExists} "$APPDATA\Pocodex\startup.json"
    ${If} ${isUpdated}
      nsExec::ExecToStack /TIMEOUT=20000 '"$INSTDIR\resources\runtime\pocodex-core.exe" --startup --profile "$APPDATA\Pocodex" --configure pause'
    ${Else}
      nsExec::ExecToStack /TIMEOUT=20000 '"$INSTDIR\resources\runtime\pocodex-core.exe" --startup --profile "$APPDATA\Pocodex" --configure disable'
    ${EndIf}
    Pop $0
    Pop $1
    ${If} $0 != 0
      Abort "Could not stop Pocodex startup monitoring. Open Pocodex, disable automatic startup, then try again."
    ${EndIf}
    Sleep 2500
  ${EndIf}
  ; A real uninstall removes Pocodex's Claude Code hooks; an update keeps them.
  ${IfNot} ${isUpdated}
    ${If} ${FileExists} "$APPDATA\Pocodex\claude-connection.json"
      nsExec::ExecToStack /TIMEOUT=20000 '"$INSTDIR\resources\runtime\pocodex-hook\pocodex-hook.exe" claude-disconnect --profile "$APPDATA\Pocodex"'
      Pop $0
      Pop $1
    ${EndIf}
  ${EndIf}
!macroend

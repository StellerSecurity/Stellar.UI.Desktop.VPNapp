; First-party hooks. Never invoke cmd.exe/PowerShell, reset global firewall
; policy, download a driver, or remove another product's network adapter.
!macro STELLAR_FIXED_DIRECTORY
  StrCmp $INSTDIR "$PROGRAMFILES64\Stellar VPN" +3
    MessageBox MB_ICONSTOP "Install Stellar VPN in the default Program Files location."
    Abort
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro STELLAR_FIXED_DIRECTORY
  IfFileExists "$INSTDIR\stellar-vpn-service.exe" 0 stellar_preinstall_done
  ExecWait '"$INSTDIR\stellar-vpn-service.exe" --stop-for-update' $0
  StrCmp $0 0 stellar_preinstall_done
  MessageBox MB_ICONSTOP "Stellar VPN could not stop its network helper. Close the app and try again."
  Abort
  stellar_preinstall_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro STELLAR_FIXED_DIRECTORY
  MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Stellar VPN will install its administrator-managed network helper and reviewed, signed VPN network driver. The helper starts with Windows and is removed when you uninstall Stellar VPN." IDOK +2
  Abort
  ExecWait '"$INSTDIR\stellar-vpn-service.exe" --repair-install' $0
  StrCmp $0 0 stellar_postinstall_done
  MessageBox MB_ICONSTOP "The network helper could not start. Open Stellar VPN to repair the installation."
  SetErrorLevel 1
  stellar_postinstall_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro STELLAR_FIXED_DIRECTORY
  ExecWait '"$INSTDIR\stellar-vpn-service.exe" --uninstall-service' $0
  StrCmp $0 0 stellar_preuninstall_done
  MessageBox MB_ICONSTOP "Stellar VPN could not remove its network helper safely. Try again with administrator approval."
  Abort
  stellar_preuninstall_done:
!macroend

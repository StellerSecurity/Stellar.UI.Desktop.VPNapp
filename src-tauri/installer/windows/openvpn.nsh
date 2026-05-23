!macro NSIS_HOOK_POSTINSTALL
  SetRegView 64
  SetShellVarContext all

  DetailPrint "Stellar VPN: checking Windows VPN engine..."

  StrCpy $R7 ""
  StrCpy $R8 ""
  StrCpy $R9 ""

  IfFileExists "$PROGRAMFILES64\OpenVPN\bin\openvpn.exe" 0 +3
    StrCpy $R7 "$PROGRAMFILES64\OpenVPN\bin\openvpn.exe"
    Goto stellar_openvpn_done

  IfFileExists "$PROGRAMFILES\OpenVPN\bin\openvpn.exe" 0 +3
    StrCpy $R7 "$PROGRAMFILES\OpenVPN\bin\openvpn.exe"
    Goto stellar_openvpn_done

  IfFileExists "$PROGRAMFILES32\OpenVPN\bin\openvpn.exe" 0 +3
    StrCpy $R7 "$PROGRAMFILES32\OpenVPN\bin\openvpn.exe"
    Goto stellar_openvpn_done

  ReadRegStr $R7 HKLM "SOFTWARE\OpenVPN" "install_path"
  StrCmp $R7 "" 0 +2
    ReadRegStr $R7 HKLM "SOFTWARE\OpenVPN" "InstallPath"
  StrCmp $R7 "" 0 +2
    ReadRegStr $R7 HKLM "SOFTWARE\OpenVPN-GUI" "install_path"
  StrCmp $R7 "" 0 +2
    Goto stellar_openvpn_install
  IfFileExists "$R7\bin\openvpn.exe" 0 +3
    StrCpy $R7 "$R7\bin\openvpn.exe"
    Goto stellar_openvpn_done
  IfFileExists "$R7\openvpn.exe" 0 +3
    StrCpy $R7 "$R7\openvpn.exe"
    Goto stellar_openvpn_done

  stellar_openvpn_install:
    DetailPrint "Stellar VPN: locating bundled Windows VPN engine installer..."

    IfFileExists "$INSTDIR\resources\external\windows\OpenVPN-2.7.4-I001-amd64.msi" 0 +3
      StrCpy $R8 "$INSTDIR\resources\external\windows\OpenVPN-2.7.4-I001-amd64.msi"
      Goto stellar_openvpn_msi_found

    IfFileExists "$INSTDIR\external\windows\OpenVPN-2.7.4-I001-amd64.msi" 0 +3
      StrCpy $R8 "$INSTDIR\external\windows\OpenVPN-2.7.4-I001-amd64.msi"
      Goto stellar_openvpn_msi_found

    IfFileExists "$INSTDIR\resources\OpenVPN-2.7.4-I001-amd64.msi" 0 +3
      StrCpy $R8 "$INSTDIR\resources\OpenVPN-2.7.4-I001-amd64.msi"
      Goto stellar_openvpn_msi_found

    IfFileExists "$INSTDIR\OpenVPN-2.7.4-I001-amd64.msi" 0 +3
      StrCpy $R8 "$INSTDIR\OpenVPN-2.7.4-I001-amd64.msi"
      Goto stellar_openvpn_msi_found

    MessageBox MB_ICONSTOP "Stellar VPN could not find the bundled Windows VPN engine installer. Please contact Stellar support."
    Abort

  stellar_openvpn_msi_found:
    DetailPrint "Stellar VPN: installing Windows VPN engine from $R8..."
    DetailPrint "Stellar VPN: OpenVPN install log: $TEMP\stellar-openvpn-install.log"

    Delete "$TEMP\stellar-openvpn-install.log"
    ExecWait '"$SYSDIR\msiexec.exe" /i "$R8" /qn /norestart /L*v "$TEMP\stellar-openvpn-install.log"' $0
    DetailPrint "Stellar VPN: OpenVPN MSI exit code: $0"

    IntCmp $0 0 stellar_openvpn_verify 0 0
    IntCmp $0 3010 stellar_openvpn_verify 0 0
      MessageBox MB_ICONSTOP "Stellar VPN could not install the Windows VPN engine. Installer exit code: $0. Log: $TEMP\stellar-openvpn-install.log"
      Abort

  stellar_openvpn_verify:
    Sleep 3000

    StrCpy $R7 ""

    IfFileExists "$PROGRAMFILES64\OpenVPN\bin\openvpn.exe" 0 +3
      StrCpy $R7 "$PROGRAMFILES64\OpenVPN\bin\openvpn.exe"
      Goto stellar_openvpn_done

    IfFileExists "$PROGRAMFILES\OpenVPN\bin\openvpn.exe" 0 +3
      StrCpy $R7 "$PROGRAMFILES\OpenVPN\bin\openvpn.exe"
      Goto stellar_openvpn_done

    IfFileExists "$PROGRAMFILES32\OpenVPN\bin\openvpn.exe" 0 +3
      StrCpy $R7 "$PROGRAMFILES32\OpenVPN\bin\openvpn.exe"
      Goto stellar_openvpn_done

    ReadRegStr $R7 HKLM "SOFTWARE\OpenVPN" "install_path"
    StrCmp $R7 "" 0 +2
      ReadRegStr $R7 HKLM "SOFTWARE\OpenVPN" "InstallPath"
    StrCmp $R7 "" 0 +2
      ReadRegStr $R7 HKLM "SOFTWARE\OpenVPN-GUI" "install_path"
    StrCmp $R7 "" 0 +2
      Goto stellar_openvpn_missing_after_install
    IfFileExists "$R7\bin\openvpn.exe" 0 +3
      StrCpy $R7 "$R7\bin\openvpn.exe"
      Goto stellar_openvpn_done
    IfFileExists "$R7\openvpn.exe" 0 +3
      StrCpy $R7 "$R7\openvpn.exe"
      Goto stellar_openvpn_done

  stellar_openvpn_missing_after_install:
    MessageBox MB_ICONSTOP "Stellar VPN installed the Windows VPN engine, but openvpn.exe was not found. Please send this log to Stellar support: $TEMP\stellar-openvpn-install.log"
    Abort

  stellar_openvpn_done:
    DetailPrint "Stellar VPN: Windows VPN engine is installed: $R7"

  DetailPrint "Stellar VPN: locating bundled Windows helper service..."

  StrCpy $R9 ""

  IfFileExists "$INSTDIR\resources\bin\stellar-vpn-helper-windows.exe" 0 +3
    StrCpy $R9 "$INSTDIR\resources\bin\stellar-vpn-helper-windows.exe"
    Goto stellar_helper_found

  IfFileExists "$INSTDIR\bin\stellar-vpn-helper-windows.exe" 0 +3
    StrCpy $R9 "$INSTDIR\bin\stellar-vpn-helper-windows.exe"
    Goto stellar_helper_found

  IfFileExists "$INSTDIR\resources\stellar-vpn-helper-windows.exe" 0 +3
    StrCpy $R9 "$INSTDIR\resources\stellar-vpn-helper-windows.exe"
    Goto stellar_helper_found

  IfFileExists "$INSTDIR\stellar-vpn-helper-windows.exe" 0 +3
    StrCpy $R9 "$INSTDIR\stellar-vpn-helper-windows.exe"
    Goto stellar_helper_found

  MessageBox MB_ICONSTOP "Stellar VPN could not find the bundled Windows helper service. Please reinstall Stellar VPN."
  Abort

  stellar_helper_found:
    DetailPrint "Stellar VPN: installing privileged Windows helper service from $R9..."
    ExecWait '"$SYSDIR\sc.exe" stop StellarVpnHelper' $0
    ExecWait '"$SYSDIR\sc.exe" delete StellarVpnHelper' $0
    Sleep 1000

    ExecWait '"$SYSDIR\sc.exe" create StellarVpnHelper binPath= "\"$R9\"" start= auto DisplayName= "Stellar VPN Helper"' $0
    DetailPrint "Stellar VPN: helper service create exit code: $0"
    IntCmp $0 0 stellar_helper_describe 0 0
      MessageBox MB_ICONSTOP "Stellar VPN could not install the Windows helper service. Installer exit code: $0"
      Abort

  stellar_helper_describe:
    ExecWait '"$SYSDIR\sc.exe" description StellarVpnHelper "Privileged helper service for Stellar VPN Windows connections."' $0
    ExecWait '"$SYSDIR\sc.exe" start StellarVpnHelper' $0
    DetailPrint "Stellar VPN: helper service start exit code: $0"
    IntCmp $0 0 stellar_helper_done 0 0
      MessageBox MB_ICONSTOP "Stellar VPN could not start the Windows helper service. Installer exit code: $0"
      Abort

  stellar_helper_done:
    DetailPrint "Stellar VPN: Windows helper service is installed and running."
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  SetShellVarContext all
  DetailPrint "Stellar VPN: removing Windows helper service..."
  ExecWait '"$SYSDIR\sc.exe" stop StellarVpnHelper' $0
  ExecWait '"$SYSDIR\sc.exe" delete StellarVpnHelper' $0
!macroend

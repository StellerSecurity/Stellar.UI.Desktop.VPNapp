!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Stellar VPN: checking Windows VPN engine..."

  IfFileExists "$PROGRAMFILES64\OpenVPN\bin\openvpn.exe" stellar_openvpn_done
  IfFileExists "$PROGRAMFILES\OpenVPN\bin\openvpn.exe" stellar_openvpn_done

  DetailPrint "Stellar VPN: locating bundled Windows VPN engine installer..."

  StrCpy $R8 ""

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

  MessageBox MB_ICONSTOP "Stellar VPN could not find the bundled Windows VPN engine installer."
  Abort

  stellar_openvpn_msi_found:
    DetailPrint "Stellar VPN: installing Windows VPN engine from $R8..."
    ExecWait '"$SYSDIR\msiexec.exe" /i "$R8" /qn /norestart' $0

    IntCmp $0 0 stellar_openvpn_verify 0 0
      MessageBox MB_ICONSTOP "Stellar VPN could not install the Windows VPN engine. Installer exit code: $0"
      Abort

  stellar_openvpn_verify:
    IfFileExists "$PROGRAMFILES64\OpenVPN\bin\openvpn.exe" stellar_openvpn_done
    IfFileExists "$PROGRAMFILES\OpenVPN\bin\openvpn.exe" stellar_openvpn_done

    MessageBox MB_ICONSTOP "Stellar VPN installed the Windows VPN engine, but openvpn.exe was not found."
    Abort

  stellar_openvpn_done:
    DetailPrint "Stellar VPN: Windows VPN engine is installed."

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

  MessageBox MB_ICONSTOP "Stellar VPN could not find the bundled Windows helper service."
  Abort

  stellar_helper_found:
    DetailPrint "Stellar VPN: installing privileged Windows helper service from $R9..."
    ExecWait '"$SYSDIR\sc.exe" stop StellarVpnHelper' $0
    ExecWait '"$SYSDIR\sc.exe" delete StellarVpnHelper' $0
    Sleep 1000

    ExecWait '"$SYSDIR\sc.exe" create StellarVpnHelper binPath= "\"$R9\"" start= auto DisplayName= "Stellar VPN Helper"' $0
    IntCmp $0 0 stellar_helper_describe 0 0
      MessageBox MB_ICONSTOP "Stellar VPN could not install the Windows helper service. Installer exit code: $0"
      Abort

  stellar_helper_describe:
    ExecWait '"$SYSDIR\sc.exe" description StellarVpnHelper "Privileged helper service for Stellar VPN Windows connections."' $0
    ExecWait '"$SYSDIR\sc.exe" start StellarVpnHelper' $0
    IntCmp $0 0 stellar_helper_done 0 0
      MessageBox MB_ICONSTOP "Stellar VPN could not start the Windows helper service. Installer exit code: $0"
      Abort

  stellar_helper_done:
    DetailPrint "Stellar VPN: Windows helper service is installed and running."
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stellar VPN: removing Windows helper service..."
  ExecWait '"$SYSDIR\sc.exe" stop StellarVpnHelper' $0
  ExecWait '"$SYSDIR\sc.exe" delete StellarVpnHelper' $0
!macroend

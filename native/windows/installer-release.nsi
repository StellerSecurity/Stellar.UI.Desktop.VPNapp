Unicode true
RequestExecutionLevel admin

!ifndef STELLAR_STAGE
  !error "STELLAR_STAGE is required"
!endif
!ifndef STELLAR_OUTPUT
  !error "STELLAR_OUTPUT is required"
!endif
!ifndef STELLAR_ICON
  !error "STELLAR_ICON is required"
!endif
!ifndef STELLAR_HOOKS
  !error "STELLAR_HOOKS is required"
!endif

!include "MUI2.nsh"
!include "${STELLAR_HOOKS}"

Name "Stellar VPN"
OutFile "${STELLAR_OUTPUT}"
InstallDir "$PROGRAMFILES64\Stellar VPN"
InstallDirRegKey HKLM "Software\StellarSecurity\Stellar VPN" "InstallDir"
SetCompressor /SOLID lzma
SetCompressorDictSize 32
ShowInstDetails show
ShowUninstDetails show
BrandingText "Stellar Security"

VIProductVersion "0.5.3.0"
VIAddVersionKey /LANG=1033 "ProductName" "Stellar VPN"
VIAddVersionKey /LANG=1033 "ProductVersion" "0.5.3"
VIAddVersionKey /LANG=1033 "CompanyName" "Stellar Security"
VIAddVersionKey /LANG=1033 "FileDescription" "Stellar VPN Installer"
VIAddVersionKey /LANG=1033 "FileVersion" "0.5.3"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Stellar Security"

!define MUI_ICON "${STELLAR_ICON}"
!define MUI_UNICON "${STELLAR_ICON}"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Stellar VPN" SecMain
  SectionIn RO
  SetShellVarContext all
  !insertmacro NSIS_HOOK_PREINSTALL

  SetOutPath "$INSTDIR"
  File "${STELLAR_STAGE}\Stellar VPN.exe"
  File "${STELLAR_STAGE}\stellar-vpn-service.exe"
  SetOutPath "$INSTDIR\Runtime"
  File /r "${STELLAR_STAGE}\Runtime\*.*"

  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\StellarSecurity\Stellar VPN" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stellar VPN" "DisplayName" "Stellar VPN"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stellar VPN" "DisplayVersion" "0.5.3"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stellar VPN" "Publisher" "Stellar Security"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stellar VPN" "DisplayIcon" "$INSTDIR\Stellar VPN.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stellar VPN" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stellar VPN" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stellar VPN" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\Stellar VPN"
  CreateShortcut "$SMPROGRAMS\Stellar VPN\Stellar VPN.lnk" "$INSTDIR\Stellar VPN.exe"
  CreateShortcut "$DESKTOP\Stellar VPN.lnk" "$INSTDIR\Stellar VPN.exe"
  !insertmacro NSIS_HOOK_POSTINSTALL
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  !insertmacro NSIS_HOOK_PREUNINSTALL
  Delete "$DESKTOP\Stellar VPN.lnk"
  Delete "$SMPROGRAMS\Stellar VPN\Stellar VPN.lnk"
  RMDir "$SMPROGRAMS\Stellar VPN"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Stellar VPN"
  DeleteRegKey HKLM "Software\StellarSecurity\Stellar VPN"
  RMDir /r "$INSTDIR\Runtime"
  Delete "$INSTDIR\Stellar VPN.exe"
  Delete "$INSTDIR\stellar-vpn-service.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd

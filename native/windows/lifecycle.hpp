#pragma once
#include "common.hpp"
#include <setupapi.h>
#include <newdev.h>

namespace stellar {
inline constexpr GUID network_device_class = {0x4d36e972,0xe325,0x11ce,{0xbf,0xc1,0x08,0x00,0x2b,0xe1,0x03,0x18}};
inline constexpr wchar_t adapter_instance[] = L"ROOT\\STELLARVPNDESKTOP\\0000";
inline bool owned_adapter_instance(const std::wstring& value) {
    return value.size() == std::wstring(adapter_instance).size() && _wcsicmp(value.c_str(), adapter_instance) == 0;
}
inline bool adapter_guid_valid(const std::wstring& value) {
    if (value.size() != 38 || value.front() != L'{' || value.back() != L'}') return false;
    for (size_t i = 1; i < 37; ++i) {
        if (i == 9 || i == 14 || i == 19 || i == 24) { if (value[i] != L'-') return false; }
        else if (!((value[i] >= L'0' && value[i] <= L'9') || (value[i] >= L'a' && value[i] <= L'f') || (value[i] >= L'A' && value[i] <= L'F'))) return false;
    }
    return true;
}
struct adapter_device {
    HDEVINFO set = INVALID_HANDLE_VALUE;
    SP_DEVINFO_DATA data{};
    adapter_device() {
        set = SetupDiCreateDeviceInfoList(&network_device_class, nullptr); check(set != INVALID_HANDLE_VALUE);
        data.cbSize = sizeof(data);
    }
    adapter_device(const adapter_device&) = delete;
    adapter_device& operator=(const adapter_device&) = delete;
    ~adapter_device() { if (set != INVALID_HANDLE_VALUE) SetupDiDestroyDeviceInfoList(set); }
    bool open() {
        if (SetupDiOpenDeviceInfoW(set, adapter_instance, nullptr, 0, &data)) return true;
        auto error = GetLastError();
        check(error == ERROR_NO_SUCH_DEVINST || error == ERROR_NO_SUCH_DEVICE || error == ERROR_NOT_FOUND);
        return false;
    }
    void verify_owner() {
        wchar_t instance[512]{};
        check(SetupDiGetDeviceInstanceIdW(set, &data, instance, 512, nullptr));
        check(owned_adapter_instance(instance) && IsEqualGUID(data.ClassGuid, network_device_class));
        wchar_t hardware[256]{}; DWORD type = 0, size = 0;
        check(SetupDiGetDeviceRegistryPropertyW(set, &data, SPDRP_HARDWAREID, &type,
            reinterpret_cast<BYTE*>(hardware), sizeof(hardware), &size));
        // Exact hardware multi-string, not a friendly-name or vendor substring.
        check(type == REG_MULTI_SZ && size == sizeof(L"ovpn-dco\0")
            && memcmp(hardware, L"ovpn-dco\0", sizeof(L"ovpn-dco\0")) == 0);
    }
    std::wstring guid() {
        verify_owner();
        HKEY key = SetupDiOpenDevRegKey(set, &data, DICS_FLAG_GLOBAL, 0, DIREG_DRV, KEY_QUERY_VALUE);
        check(key != INVALID_HANDLE_VALUE);
        wchar_t value[64]{}; DWORD size = sizeof(value);
        auto result = RegGetValueW(key, nullptr, L"NetCfgInstanceId", RRF_RT_REG_SZ, nullptr, value, &size);
        RegCloseKey(key);
        check(result == ERROR_SUCCESS && size <= sizeof(value));
        std::wstring id(value); check(adapter_guid_valid(id)); return id;
    }
    void remove() {
        verify_owner();
        SP_REMOVEDEVICE_PARAMS parameters{};
        parameters.ClassInstallHeader.cbSize = sizeof(SP_CLASSINSTALL_HEADER);
        parameters.ClassInstallHeader.InstallFunction = DIF_REMOVE;
        parameters.Scope = DI_REMOVEDEVICE_GLOBAL;
        check(SetupDiSetClassInstallParamsW(set, &data, &parameters.ClassInstallHeader, sizeof(parameters)));
        check(SetupDiCallClassInstaller(DIF_REMOVE, set, &data));
    }
};
inline std::wstring installed_adapter_guid() {
    adapter_device device; check(device.open()); return device.guid();
}
inline void remove_owned_adapter() {
    adapter_device device; if (device.open()) device.remove();
    // Never delete the shared ovpn-dco driver package or enumerate/remove peers.
}
inline bool ensure_owned_adapter() {
    adapter_device device;
    if (!device.open()) {
        check(SetupDiCreateDeviceInfoW(device.set, adapter_instance, &network_device_class,
            L"Stellar VPN network adapter", nullptr, 0, &device.data));
        constexpr wchar_t hardware[] = L"ovpn-dco\0";
        check(SetupDiSetDeviceRegistryPropertyW(device.set, &device.data, SPDRP_HARDWAREID,
            reinterpret_cast<const BYTE*>(hardware), sizeof(hardware)));
        check(SetupDiCallClassInstaller(DIF_REGISTERDEVICE, device.set, &device.data));
    }
    device.verify_owner();
    BOOL reboot = FALSE;
    // Only bind a driver already staged and signature-checked by the installer.
    // Supplying NeedReboot prevents an automatic reboot prompt or restart.
    check(DiInstallDevice(nullptr, device.set, &device.data, nullptr, 0, &reboot));
    if (!reboot) device.guid();
    return reboot != FALSE;
}
struct service_owner {
    SC_HANDLE value = nullptr;
    explicit service_owner(SC_HANDLE v) : value(v) {}
    ~service_owner() { if (value) CloseServiceHandle(value); }
};
inline void require_administrator() {
    BOOL member = FALSE; local_memory administrators;
    check(ConvertStringSidToSidW(L"S-1-5-32-544", &administrators.value));
    check(CheckTokenMembership(nullptr, administrators.value, &member) && member);
    check(std::filesystem::path(module_path()) == install_root() / L"stellar-vpn-service.exe");
    verify_signature(module_path());
}
inline void verify_service(SC_HANDLE service) {
    DWORD size = 0; QueryServiceConfigW(service, nullptr, 0, &size); check(size && size <= 65536);
    std::vector<BYTE> data(size); auto* config = reinterpret_cast<QUERY_SERVICE_CONFIGW*>(data.data());
    check(QueryServiceConfigW(service, config, size, &size));
    auto expected = L"\"" + (install_root() / L"stellar-vpn-service.exe").wstring() + L"\"";
    check(_wcsicmp(config->lpBinaryPathName, expected.c_str()) == 0 && _wcsicmp(config->lpServiceStartName, L"LocalSystem") == 0
        && config->dwServiceType == SERVICE_WIN32_OWN_PROCESS);
}
inline bool service_needs_stop_control(DWORD state) {
    return state != SERVICE_STOPPED && state != SERVICE_STOP_PENDING;
}
inline void stop_service(SC_HANDLE service) {
    SERVICE_STATUS_PROCESS status{}; DWORD size = 0;
    check(QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, reinterpret_cast<BYTE*>(&status), sizeof(status), &size));
    if (status.dwCurrentState == SERVICE_STOPPED) return;
    SERVICE_STATUS previous{};
    // An update/uninstall can race an existing stop. Do not send another
    // control to a STOP_PENDING service: Windows can reject it as busy.
    if (service_needs_stop_control(status.dwCurrentState) && !ControlService(service, SERVICE_CONTROL_STOP, &previous)) {
        auto error = GetLastError();
        check(QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, reinterpret_cast<BYTE*>(&status), sizeof(status), &size));
        check(error == ERROR_SERVICE_NOT_ACTIVE || status.dwCurrentState == SERVICE_STOP_PENDING || status.dwCurrentState == SERVICE_STOPPED);
    }
    auto deadline = GetTickCount64() + 45000;
    do {
        check(QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, reinterpret_cast<BYTE*>(&status), sizeof(status), &size));
        if (status.dwCurrentState == SERVICE_STOPPED) return;
        check(GetTickCount64() < deadline); Sleep(100);
    } while (true);
}
// Called only by the visible, elevated first-party installer. No arbitrary
// service names, binary paths, accounts, arguments or recovery commands.
inline void install_service() {
    require_administrator();
    auto state = install_root() / L"State";
    local_memory descriptor;
    check(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", SDDL_REVISION_1, &descriptor.value, nullptr));
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor.value, FALSE};
    if (!CreateDirectoryW(state.c_str(), &attributes)) check(GetLastError() == ERROR_ALREADY_EXISTS);
    trusted_machine_path(state);
    service_owner manager(OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE)); check(manager.value);
    service_owner service(OpenServiceW(manager.value, service_name, SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | SERVICE_START | SERVICE_CHANGE_CONFIG | SERVICE_STOP | WRITE_DAC));
    if (!service.value) {
        check(GetLastError() == ERROR_SERVICE_DOES_NOT_EXIST);
        auto binary = L"\"" + (install_root() / L"stellar-vpn-service.exe").wstring() + L"\"";
        service.value = CreateServiceW(manager.value, service_name, L"Stellar VPN network helper",
            SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | SERVICE_START | SERVICE_CHANGE_CONFIG | SERVICE_STOP | WRITE_DAC,
            SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL, binary.c_str(), nullptr, nullptr, L"BFE\0\0", nullptr, nullptr);
        check(service.value);
    }
    verify_service(service.value);
    local_memory acl;
    check(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;CCLC;;;IU)", SDDL_REVISION_1, &acl.value, nullptr));
    check(SetServiceObjectSecurity(service.value, DACL_SECURITY_INFORMATION, acl.value));
    check(ChangeServiceConfigW(service.value, SERVICE_NO_CHANGE, SERVICE_AUTO_START, SERVICE_NO_CHANGE, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr));
    SC_ACTION actions[] = {{SC_ACTION_RESTART, 5000}, {SC_ACTION_RESTART, 15000}, {SC_ACTION_NONE, 0}};
    SERVICE_FAILURE_ACTIONSW failure{}; failure.dwResetPeriod = 86400; failure.cActions = 3; failure.lpsaActions = actions;
    check(ChangeServiceConfig2W(service.value, SERVICE_CONFIG_FAILURE_ACTIONS, &failure));
    if (!StartServiceW(service.value, 0, nullptr)) check(GetLastError() == ERROR_SERVICE_ALREADY_RUNNING);
}
inline bool provision_reviewed_driver() {
    require_administrator();
    // Inputs must first pass the exact runtime manifest and release review gate.
    // PnPUtil/Windows enforce driver signing; no test-signing or policy changes.
    auto inf = install_root() / L"Runtime" / L"ovpn-dco.inf";
    check(regular_no_links(inf)); trusted_machine_path(inf);
    verify_signature(install_root() / L"Runtime" / L"ovpn-dco.cat");
    wchar_t system[32768]{}; DWORD size = GetSystemDirectoryW(system, 32768); check(size && size < 32768);
    auto utility = std::filesystem::path(system) / L"pnputil.exe";
    auto command = L"\"" + utility.wstring() + L"\" /add-driver \"" + inf.wstring() + L"\" /install";
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION process{};
    check(CreateProcessW(utility.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
        nullptr, utility.parent_path().c_str(), &startup, &process));
    handle child(process.hProcess), thread(process.hThread);
    if (WaitForSingleObject(child, 45000) != WAIT_OBJECT_0) { TerminateProcess(child, 1); check(false); }
    DWORD exit = 1; check(GetExitCodeProcess(child, &exit));
    check(exit == ERROR_SUCCESS || exit == ERROR_SUCCESS_REBOOT_REQUIRED);
    return exit == ERROR_SUCCESS_REBOOT_REQUIRED;
}
inline void remove_service(bool remove) {
    require_administrator();
    service_owner manager(OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT)); check(manager.value);
    service_owner service(OpenServiceW(manager.value, service_name, SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | SERVICE_STOP | (remove ? DELETE : 0)));
    if (!service.value) { check(GetLastError() == ERROR_SERVICE_DOES_NOT_EXIST); return; }
    verify_service(service.value); stop_service(service.value);
    if (remove && !DeleteService(service.value)) check(GetLastError() == ERROR_SERVICE_MARKED_FOR_DELETE);
}
}

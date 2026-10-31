#pragma once
#include "common.hpp"

namespace stellar {
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
inline void stop_service(SC_HANDLE service) {
    SERVICE_STATUS_PROCESS status{}; DWORD size = 0;
    check(QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, reinterpret_cast<BYTE*>(&status), sizeof(status), &size));
    if (status.dwCurrentState == SERVICE_STOPPED) return;
    SERVICE_STATUS previous{};
    if (!ControlService(service, SERVICE_CONTROL_STOP, &previous)) check(GetLastError() == ERROR_SERVICE_NOT_ACTIVE);
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
inline void provision_reviewed_driver() {
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

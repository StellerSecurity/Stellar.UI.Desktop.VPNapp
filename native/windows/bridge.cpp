// First-party bridge to Windows SDK APIs. No package downloads, shell or scripts.
#include "common.hpp"
using namespace stellar;
struct service_handle {
    SC_HANDLE value;
    ~service_handle() { if (value) CloseServiceHandle(value); }
};
extern "C" int stellar_windows_exchange(const unsigned char* input, size_t length, unsigned char* output, size_t capacity, unsigned long timeout) noexcept {
    try {
        check(input && length && length <= 131400 && output && capacity >= 256 && timeout <= 40000);
        check(WaitNamedPipeW(pipe_name, 2000));
        handle pipe(CreateFileW(pipe_name, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
        check(pipe.value != INVALID_HANDLE_VALUE);
        ULONG pid = 0; check(GetNamedPipeServerProcessId(pipe, &pid));
        service_handle manager{OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT)}; check(manager.value != nullptr);
        service_handle service{OpenServiceW(manager.value, service_name, SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG)}; check(service.value != nullptr);
        SERVICE_STATUS_PROCESS status{}; DWORD needed = 0;
        check(QueryServiceStatusEx(service.value, SC_STATUS_PROCESS_INFO, reinterpret_cast<BYTE*>(&status), sizeof(status), &needed));
        check(status.dwCurrentState == SERVICE_RUNNING && status.dwProcessId == pid && pid != 0);
        QueryServiceConfigW(service.value, nullptr, 0, &needed); check(needed && needed < 65536);
        std::vector<BYTE> bytes(needed); auto* config = reinterpret_cast<QUERY_SERVICE_CONFIGW*>(bytes.data());
        check(QueryServiceConfigW(service.value, config, needed, &needed));
        auto helper = install_root() / L"stellar-vpn-service.exe";
        auto expected = L"\"" + helper.wstring() + L"\"";
        check(_wcsicmp(config->lpBinaryPathName, expected.c_str()) == 0 && _wcsicmp(config->lpServiceStartName, L"LocalSystem") == 0);
        trusted_machine_path(helper);
        std::string wire(reinterpret_cast<const char*>(input), length);
        try { send(pipe, wire); } catch (...) { wipe(wire); throw; } wipe(wire);
        std::string reply = line(pipe, 255, timeout);
        check(reply.size() + 1 <= capacity);
        std::copy(reply.begin(), reply.end(), output); output[reply.size()] = '\n';
        return static_cast<int>(reply.size() + 1);
    } catch (...) { return -1; }
}

extern "C" int stellar_windows_autostart(int enabled) noexcept {
    try {
        // Current executable only; no caller-supplied path or command line.
        auto exe = std::filesystem::path(module_path());
        if (exe != install_root() / L"Stellar VPN.exe") return 1; // Development runners never register startup.
        trusted_machine_path(exe);
        HKEY key = nullptr;
        check(RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0,
            nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr) == ERROR_SUCCESS);
        LSTATUS result;
        if (!enabled) { result = RegDeleteValueW(key, L"StellarVPNDesktop"); if (result == ERROR_FILE_NOT_FOUND) result = ERROR_SUCCESS; }
        else {
            auto value = L"\"" + exe.wstring() + L"\" --autostart";
            result = RegSetValueExW(key, L"StellarVPNDesktop", 0, REG_SZ,
                reinterpret_cast<const BYTE*>(value.c_str()), static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
        }
        RegCloseKey(key); check(result == ERROR_SUCCESS); return 1;
    } catch (...) { return 0; }
}

extern "C" int stellar_windows_network_stamp(uint64_t* output) noexcept {
    try {
        check(output != nullptr); ULONG size = 16384; std::vector<BYTE> bytes(size);
        ULONG result = GetAdaptersAddresses(AF_UNSPEC, GAA_FLAG_INCLUDE_GATEWAYS, nullptr,
            reinterpret_cast<IP_ADAPTER_ADDRESSES*>(bytes.data()), &size);
        if (result == ERROR_BUFFER_OVERFLOW) {
            check(size <= 1024 * 1024); bytes.resize(size);
            result = GetAdaptersAddresses(AF_UNSPEC, GAA_FLAG_INCLUDE_GATEWAYS, nullptr,
                reinterpret_cast<IP_ADAPTER_ADDRESSES*>(bytes.data()), &size);
        }
        check(result == NO_ERROR);
        std::vector<std::string> entries;
        for (auto* a = reinterpret_cast<IP_ADAPTER_ADDRESSES*>(bytes.data()); a; a = a->Next) {
            MIB_IF_ROW2 row{}; row.InterfaceLuid = a->Luid;
            if (GetIfEntry2(&row) != NO_ERROR || !row.InterfaceAndOperStatusFlags.HardwareInterface || a->OperStatus != IfOperStatusUp) continue;
            std::string entry = std::to_string(a->Luid.Value);
            auto append = [&](const SOCKET_ADDRESS& address) {
                std::array<char, INET6_ADDRSTRLEN> text{};
                if (address.lpSockaddr->sa_family == AF_INET) {
                    auto* v = reinterpret_cast<sockaddr_in*>(address.lpSockaddr);
                    if (InetNtopA(AF_INET, &v->sin_addr, text.data(), static_cast<DWORD>(text.size()))) entry += std::string("|") + text.data();
                } else if (address.lpSockaddr->sa_family == AF_INET6) {
                    auto* v = reinterpret_cast<sockaddr_in6*>(address.lpSockaddr);
                    if (InetNtopA(AF_INET6, &v->sin6_addr, text.data(), static_cast<DWORD>(text.size()))) entry += std::string("|") + text.data();
                }
            };
            for (auto* p = a->FirstUnicastAddress; p; p = p->Next) append(p->Address);
            for (auto* p = a->FirstGatewayAddress; p; p = p->Next) append(p->Address);
            entries.push_back(entry);
        }
        std::sort(entries.begin(), entries.end()); uint64_t hash = 14695981039346656037ull;
        for (const auto& e : entries) for (unsigned char c : e) { hash ^= c; hash *= 1099511628211ull; }
        *output = hash; return 1;
    } catch (...) { return 0; }
}

struct internet_handle {
    HINTERNET value;
    ~internet_handle() { if (value) WinHttpCloseHandle(value); }
};
extern "C" int stellar_windows_https(const wchar_t* url, size_t max, int (*consume)(const unsigned char*, size_t, void*), void* context) noexcept {
    try {
        check(url && consume && max <= 512ull * 1024 * 1024);
        URL_COMPONENTS parts{}; parts.dwStructSize = sizeof(parts); parts.dwHostNameLength = parts.dwUrlPathLength = parts.dwExtraInfoLength = static_cast<DWORD>(-1);
        check(WinHttpCrackUrl(url, 0, 0, &parts));
        check(parts.nScheme == INTERNET_SCHEME_HTTPS && parts.nPort == 443 && parts.dwExtraInfoLength == 0
            && std::wstring(parts.lpszHostName, parts.dwHostNameLength) == L"desktopreleasesassetsprod.stellarsecurity.com");
        std::wstring host(parts.lpszHostName, parts.dwHostNameLength), path(parts.lpszUrlPath, parts.dwUrlPathLength);
        check(path.rfind(L"/vpn/desktop-v2/", 0) == 0);
        internet_handle session{WinHttpOpen(L"StellarVPN/desktop-v2", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)};
        check(session.value != nullptr); check(WinHttpSetTimeouts(session.value, 5000, 5000, 5000, 5000));
        DWORD tls = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
        check(WinHttpSetOption(session.value, WINHTTP_OPTION_SECURE_PROTOCOLS, &tls, sizeof(tls)));
        internet_handle connection{WinHttpConnect(session.value, host.c_str(), 443, 0)}; check(connection.value != nullptr);
        internet_handle request{WinHttpOpenRequest(connection.value, L"GET", path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE)};
        check(request.value != nullptr);
        DWORD disabled = WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION;
        check(WinHttpSetOption(request.value, WINHTTP_OPTION_DISABLE_FEATURE, &disabled, sizeof(disabled)));
        check(WinHttpSendRequest(request.value, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0));
        check(WinHttpReceiveResponse(request.value, nullptr)); DWORD status = 0, size = sizeof(status);
        check(WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX));
        check(status == 200 || status == 204);
        std::array<unsigned char, 32768> buffer{}; size_t count = 0; auto deadline = GetTickCount64() + 125000;
        while (true) {
            DWORD read = 0; check(GetTickCount64() < deadline);
            check(WinHttpReadData(request.value, buffer.data(), static_cast<DWORD>(buffer.size()), &read));
            if (!read) break; count += read; check(count <= max && consume(buffer.data(), read, context));
        }
        return 1;
    } catch (...) { return 0; }
}

extern "C" int stellar_windows_launch_installer(const wchar_t* path) noexcept {
    try {
        check(path && regular_no_links(path));
        // Caller first verifies the pinned Minisign signature and signed version.
        // Windows separately owns UAC; never use a shell or unattended elevation.
        WINTRUST_FILE_INFO file{}; file.cbStruct = sizeof(file); file.pcwszFilePath = path;
        WINTRUST_DATA data{}; data.cbStruct = sizeof(data); data.dwUIChoice = WTD_UI_NONE;
        data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN; data.dwUnionChoice = WTD_CHOICE_FILE; data.pFile = &file;
        data.dwStateAction = WTD_STATEACTION_VERIFY;
        GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        LONG result = WinVerifyTrust(nullptr, &policy, &data);
        data.dwStateAction = WTD_STATEACTION_CLOSE; WinVerifyTrust(nullptr, &policy, &data); check(result == ERROR_SUCCESS);
        SHELLEXECUTEINFOW execute{}; execute.cbSize = sizeof(execute); execute.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI;
        execute.lpVerb = L"runas"; execute.lpFile = path; execute.nShow = SW_SHOWNORMAL;
        check(ShellExecuteExW(&execute)); if (execute.hProcess) CloseHandle(execute.hProcess); return 1;
    } catch (...) { return 0; }
}
// Read-only diagnosis. Detect the HOST, not the emulated application's architecture.
// This build ships an x64 driver policy only; x64 emulation cannot load it on ARM.
extern "C" int stellar_windows_setup_issue() noexcept {
    try {
        USHORT process = 0, native = 0;
        check(IsWow64Process2(GetCurrentProcess(), &process, &native));
        if (native != IMAGE_FILE_MACHINE_AMD64) return 2;
        auto helper = install_root() / L"stellar-vpn-service.exe";
        auto attributes = GetFileAttributesW(helper.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES) {
            auto error = GetLastError();
            return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? 1 : 3;
        }
        if (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) return 3;
        verify_signature(helper);
        return 0;
    } catch (...) { return 3; }
}
extern "C" int stellar_windows_repair() noexcept {
    try {
        check(stellar_windows_setup_issue() == 0);
        auto helper = install_root() / L"stellar-vpn-service.exe"; verify_signature(helper);
        SHELLEXECUTEINFOW execute{}; execute.cbSize = sizeof(execute); execute.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI;
        execute.lpVerb = L"runas"; execute.lpFile = helper.c_str(); execute.lpParameters = L"--repair-install"; execute.nShow = SW_SHOWNORMAL;
        check(ShellExecuteExW(&execute)); if (execute.hProcess) CloseHandle(execute.hProcess); return 1;
    } catch (...) { return 0; }
}
extern "C" intptr_t stellar_windows_instance() noexcept {
    try {
        HANDLE raw = nullptr; check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)); handle token(raw);
        auto sid = token_sid(token); auto name = L"Local\\StellarVPNDesktop." + sid;
        local_memory descriptor; auto sddl = L"D:P(A;;GA;;;SY)(A;;GA;;;" + sid + L")";
        check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor.value, nullptr));
        SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor.value, FALSE};
        handle instance(CreateMutexW(&attributes, FALSE, name.c_str())); check(instance.value != nullptr);
        if (GetLastError() == ERROR_ALREADY_EXISTS) return 0;
        return reinterpret_cast<intptr_t>(instance.release());
    } catch (...) { return -1; }
}
extern "C" void stellar_windows_close_instance(intptr_t instance) noexcept { if (instance > 0) CloseHandle(reinterpret_cast<HANDLE>(instance)); }

// Non-elevated, app-scoped legacy login migration. No registry/profile search.
// Paths are supplied only by native app_data_dir(), never by a webview command.
static std::vector<handle> legacy_directory(const std::filesystem::path& source) {
    check(source.is_absolute() && source.filename() == L".stellar-vpn.dat");
    std::vector<handle> parents; auto current = source.root_path();
    for (const auto& part : source.parent_path().relative_path()) {
        check(part != L".." && part != L"."); current /= part;
        handle guard(CreateFileW(current.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
            OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        check(guard.value != INVALID_HANDLE_VALUE); BY_HANDLE_FILE_INFORMATION info{};
        check(GetFileInformationByHandle(guard, &info) && (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
            && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)); parents.push_back(std::move(guard));
    }
    return parents;
}
static std::string legacy_bytes(HANDLE file) {
    BY_HANDLE_FILE_INFORMATION info{}; check(GetFileInformationByHandle(file, &info));
    check(!(info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))
        && info.nNumberOfLinks == 1 && info.nFileSizeHigh == 0 && info.nFileSizeLow <= 65536);
    std::string value(info.nFileSizeLow, '\0'); DWORD read = 0;
    if (!value.empty()) check(ReadFile(file, value.data(), static_cast<DWORD>(value.size()), &read, nullptr) && read == value.size());
    return value;
}
extern "C" int stellar_windows_legacy_read(const wchar_t* path, unsigned char* output, size_t capacity) noexcept {
    std::string value;
    try {
        check(path && output && capacity == 65536); auto parents = legacy_directory(path);
        handle file(CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (file.value == INVALID_HANDLE_VALUE) { check(GetLastError() == ERROR_FILE_NOT_FOUND); return 0; }
        value = legacy_bytes(file); check(!value.empty()); std::copy(value.begin(), value.end(), output);
        auto count = static_cast<int>(value.size()); wipe(value); return count;
    } catch (...) { wipe(value); return -1; }
}
extern "C" int stellar_windows_legacy_replace(const wchar_t* path, const unsigned char* old, size_t old_size,
    const unsigned char* replacement, size_t size) noexcept {
    std::filesystem::path temporary; std::string previous;
    try {
        check(path && old && replacement && old_size && old_size <= 65536 && size && size <= 65536);
        auto parents = legacy_directory(path);
        handle source(CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        check(source.value != INVALID_HANDLE_VALUE); previous = legacy_bytes(source);
        check(previous.size() == old_size && std::equal(previous.begin(), previous.end(), reinterpret_cast<const char*>(old))); wipe(previous);
        BY_HANDLE_FILE_INFORMATION before{}; check(GetFileInformationByHandle(source, &before));
        HANDLE raw = nullptr; check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)); handle token(raw);
        local_memory descriptor; auto sddl = L"D:P(A;;FA;;;SY)(A;;FA;;;" + token_sid(token) + L")";
        check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor.value, nullptr));
        SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor.value, FALSE}; auto nonce = random_hex();
        temporary = std::filesystem::path(path).parent_path() / (L".stellar-migration-" + std::wstring(nonce.begin(), nonce.end()));
        {
            handle file(CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, &attributes, CREATE_NEW, FILE_FLAG_WRITE_THROUGH, nullptr));
            check(file.value != INVALID_HANDLE_VALUE); DWORD written = 0;
            check(WriteFile(file, replacement, static_cast<DWORD>(size), &written, nullptr) && written == size && FlushFileBuffers(file));
        }
        handle current(CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        BY_HANDLE_FILE_INFORMATION after{}; check(current.value != INVALID_HANDLE_VALUE && GetFileInformationByHandle(current, &after));
        check(before.dwVolumeSerialNumber == after.dwVolumeSerialNumber && before.nFileIndexHigh == after.nFileIndexHigh && before.nFileIndexLow == after.nFileIndexLow
            && after.nNumberOfLinks == 1 && !(after.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT));
        check(ReplaceFileW(path, temporary.c_str(), nullptr, 0, nullptr, nullptr)); temporary.clear(); return 1;
    } catch (...) { wipe(previous); if (!temporary.empty()) DeleteFileW(temporary.c_str()); return 0; }
}

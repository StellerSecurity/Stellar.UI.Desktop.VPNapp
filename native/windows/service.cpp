// Privileged first-party OpenVPN broker. No caller-selected paths/commands/plugins.
#include "firewall.hpp"
#include "lifecycle.hpp"
#include <set>
using namespace stellar;
struct secret_guard { std::string& value; ~secret_guard() { wipe(value); } };
struct secret_fields_guard { std::vector<std::string>& values; ~secret_fields_guard() { for (auto& value : values) wipe(value); } };
static std::atomic<bool> stopping{false};
static std::mutex state_mutex, operation_mutex;
static std::condition_variable state_changed;
static SERVICE_STATUS_HANDLE status_handle = nullptr;
static HANDLE stop_event = nullptr;
static std::unique_ptr<firewall> protection;
static bool firewall_verified = false;
static std::atomic<unsigned> workers{0};
struct tunnel_state {
    uint64_t generation = 0, connected_at = 0, received = 0, sent = 0, luid = 0;
    bool connected = false, protected_mode = false;
    std::string server;
    HANDLE job = nullptr;
    std::vector<endpoint> endpoints;
} tunnel;
static uint64_t now() { return static_cast<uint64_t>(std::chrono::system_clock::to_time_t(std::chrono::system_clock::now())); }
static void stop_tunnel_locked() {
    ++tunnel.generation;
    if (tunnel.job) { HANDLE job = tunnel.job; tunnel.job = nullptr; BOOL stopped = TerminateJobObject(job, 0); CloseHandle(job); check(stopped); }
    tunnel.connected = false; tunnel.connected_at = tunnel.received = tunnel.sent = tunnel.luid = 0;
    protection->apply(tunnel.protected_mode, tunnel.endpoints);
    state_changed.notify_all();
}
static std::string snapshot_locked() {
    if (tunnel.connected) return "CONNECTED " + tunnel.server + " " + std::to_string(tunnel.connected_at) + " " + std::to_string(tunnel.received) + " " + std::to_string(tunnel.sent) + "\n";
    return tunnel.protected_mode ? "BLOCKED\n" : "DISCONNECTED\n";
}
static std::vector<endpoint> validate_config(const std::string& config) {
    check(!config.empty() && config.size() <= 131072);
    std::set<std::string> seen, blocks; std::vector<endpoint> endpoints; std::string tag, line, protocol;
    std::istringstream input(config);
    while (std::getline(input, line)) {
        check(std::all_of(line.begin(), line.end(), [](unsigned char c) { return (c >= 32 && c < 127) || c == '\r' || c == '\t'; }));
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (!tag.empty()) {
            if (line == "</" + tag + ">") { tag.clear(); continue; }
            check(line.find_first_of("<>") == std::string::npos); continue;
        }
        if (line.empty() || line[0] == '#' || line[0] == ';') continue;
        if (line[0] == '<') {
            check(line.size() >= 3 && line.back() == '>'); tag = line.substr(1, line.size() - 2);
            check((tag == "ca" || tag == "cert" || tag == "key" || tag == "tls-auth" || tag == "tls-crypt") && blocks.insert(tag).second); continue;
        }
        std::istringstream words(line); std::vector<std::string> fields; std::string word;
        while (words >> word) fields.push_back(word);
        check(!fields.empty()); const auto& key = fields[0];
        if (key != "remote") check(seen.insert(key).second);
        if (fields.size() == 1) check(key == "client" || key == "nobind" || key == "persist-key" || key == "persist-tun" || key == "auth-user-pass" || key == "auth-nocache" || key == "block-ipv6");
        else if (fields.size() == 2) {
            const auto& v = fields[1];
            bool ok = (key == "dev" && v == "tun") || (key == "remote-cert-tls" && v == "server") || (key == "auth" && v == "SHA256")
                || (key == "cipher" && v == "AES-256-GCM") || (key == "key-direction" && v == "1") || (key == "resolv-retry" && v == "infinite")
                || (key == "script-security" && v == "1") || (key == "allow-compression" && v == "no") || (key == "auth-retry" && v == "none");
            if (key == "proto") { ok = v == "udp" || v == "udp4" || v == "tcp-client" || v == "tcp4-client"; protocol = v; }
            if (key == "verb") ok = number(v, 3) <= 3;
            if (key == "hand-window") ok = number(v, 120) > 0;
            check(ok);
        } else if (fields.size() == 3 && key == "remote") {
            IN_ADDR address{}; check(InetPtonA(AF_INET, fields[1].c_str(), &address) == 1);
            auto ip = ntohl(address.s_addr); auto port = number(fields[2], 65535);
            check(port && ip && (ip >> 24) != 127 && (ip >> 24) < 224 && endpoints.size() < 16);
            endpoints.push_back({ip, static_cast<uint16_t>(port), 0});
        } else check(false);
    }
    check(tag.empty() && !endpoints.empty());
    for (auto key : {"client", "dev", "proto", "remote-cert-tls", "auth-user-pass", "auth-nocache", "script-security", "allow-compression", "auth-retry"}) check(seen.count(key) == 1);
    for (auto block : {"ca", "cert", "key"}) check(blocks.count(block) == 1);
    check(!blocks.count("tls-auth") || (seen.count("key-direction") && !blocks.count("tls-crypt")));
    for (auto& e : endpoints) e.protocol = protocol.rfind("udp", 0) == 0 ? IPPROTO_UDP : IPPROTO_TCP;
    return endpoints;
}
static void verify_runtime() {
    auto root = install_root() / L"Runtime"; trusted_machine_path(root);
    auto manifest = root / L"runtime.sha256"; check(regular_no_links(manifest)); trusted_machine_path(manifest);
    std::ifstream input(manifest); std::string hash, name; std::set<std::wstring> files;
    while (input >> hash >> name) {
        check(files.size() < 128 && hash.size() == 64 && std::all_of(hash.begin(), hash.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }));
        check(!name.empty() && name.size() <= 128 && name != "." && name != ".." && name.find("..") == std::string::npos
            && std::all_of(name.begin(), name.end(), [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_'; }));
        std::wstring wide(name.begin(), name.end()); check(files.insert(wide).second);
        auto path = root / wide; check(regular_no_links(path)); trusted_machine_path(path); check(sha256(path) == hash);
    }
    check(input.eof() && files.count(L"openvpn.exe") && files.count(L"ovpn-dco.inf") && files.count(L"ovpn-dco.cat") && files.count(L"ovpn-dco.sys"));
    for (const auto& entry : std::filesystem::directory_iterator(root)) {
        check(regular_no_links(entry.path()));
        check(entry.path().filename() == L"runtime.sha256" || files.count(entry.path().filename().wstring()));
    }
    verify_signature(root / L"openvpn.exe");
}
struct private_session {
    std::filesystem::path directory;
    private_session() {
        auto root = install_root() / L"State"; trusted_machine_path(root);
        auto random = random_hex(); directory = root / std::wstring(random.begin(), random.end());
        local_memory descriptor; check(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;OICI;FA;;;SY)", SDDL_REVISION_1, &descriptor.value, nullptr));
        SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor.value, FALSE};
        check(CreateDirectoryW(directory.c_str(), &attributes));
    }
    void write(const wchar_t* name, std::string value) {
        secret_guard clear{value};
        auto path = directory / name;
        handle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_WRITE_THROUGH, nullptr));
        check(file.value != INVALID_HANDLE_VALUE); DWORD written = 0;
        check(WriteFile(file, value.data(), static_cast<DWORD>(value.size()), &written, nullptr) && written == value.size()); check(FlushFileBuffers(file));
    }
    ~private_session() { for (auto name : {L"client.ovpn", L"management.pass"}) DeleteFileW((directory / name).c_str()); RemoveDirectoryW(directory.c_str()); }
};
static void clean_orphaned_sessions() {
    auto root = install_root() / L"State"; trusted_machine_path(root);
    for (const auto& entry : std::filesystem::directory_iterator(root)) {
        auto name = entry.path().filename().wstring();
        if (name.size() != 64 || !std::all_of(name.begin(), name.end(), [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); })) continue;
        trusted_machine_path(entry.path());
        // Exact first-party session files only, never a recursive directory wipe.
        for (auto filename : {L"client.ovpn", L"management.pass"}) {
            auto file = entry.path() / filename;
            if (GetFileAttributesW(file.c_str()) != INVALID_FILE_ATTRIBUTES) {
                check(regular_no_links(file)); trusted_machine_path(file); check(DeleteFileW(file.c_str()));
            }
        }
        RemoveDirectoryW(entry.path().c_str()); // Preserve any unrelated contents.
    }
}
static uint64_t tunnel_interface(const std::string& address) {
    IN_ADDR wanted{}; check(InetPtonA(AF_INET, address.c_str(), &wanted) == 1 && wanted.s_addr != 0);
    ULONG size = 16384; std::vector<BYTE> bytes(size);
    auto result = GetAdaptersAddresses(AF_INET, 0, nullptr, reinterpret_cast<IP_ADAPTER_ADDRESSES*>(bytes.data()), &size);
    if (result == ERROR_BUFFER_OVERFLOW) { check(size <= 1024 * 1024); bytes.resize(size); result = GetAdaptersAddresses(AF_INET, 0, nullptr, reinterpret_cast<IP_ADAPTER_ADDRESSES*>(bytes.data()), &size); }
    check(result == NO_ERROR);
    for (auto* a = reinterpret_cast<IP_ADAPTER_ADDRESSES*>(bytes.data()); a; a = a->Next) {
        MIB_IF_ROW2 row{}; row.InterfaceLuid = a->Luid;
        if (GetIfEntry2(&row) != NO_ERROR || row.InterfaceAndOperStatusFlags.HardwareInterface || a->IfType == IF_TYPE_SOFTWARE_LOOPBACK || a->OperStatus != IfOperStatusUp) continue;
        for (auto* p = a->FirstUnicastAddress; p; p = p->Next) if (p->Address.lpSockaddr->sa_family == AF_INET
            && reinterpret_cast<sockaddr_in*>(p->Address.lpSockaddr)->sin_addr.s_addr == wanted.s_addr) {
            bool dns = a->FirstDnsServerAddress != nullptr; check(dns);
            // Refuse a false Connected state unless the VPN owns an Internet route.
            SOCKADDR_INET destination{}; destination.si_family = AF_INET; InetPtonW(AF_INET, L"192.0.2.1", &destination.Ipv4.sin_addr);
            MIB_IPFORWARD_ROW2 route{}; SOCKADDR_INET source{};
            check(GetBestRoute2(nullptr, 0, nullptr, &destination, 0, &route, &source) == NO_ERROR && route.InterfaceLuid.Value == a->Luid.Value);
            return a->Luid.Value;
        }
    }
    throw std::runtime_error("Tunnel interface unavailable");
}
static bool listener_is_child(uint16_t port, DWORD pid) {
    DWORD size = 0; GetExtendedTcpTable(nullptr, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
    if (!size || size > 4 * 1024 * 1024) return false; std::vector<BYTE> data(size);
    if (GetExtendedTcpTable(data.data(), &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0) != NO_ERROR) return false;
    auto* table = reinterpret_cast<MIB_TCPTABLE_OWNER_PID*>(data.data());
    for (DWORD i = 0; i < table->dwNumEntries; ++i) { auto& r = table->table[i]; if (r.dwOwningPid == pid && ntohs(static_cast<u_short>(r.dwLocalPort)) == port && r.dwLocalAddr == htonl(INADDR_LOOPBACK)) return true; }
    return false;
}
static void socket_send(SOCKET socket, std::string text) {
    secret_guard clear{text};
    size_t at = 0; while (at < text.size()) { int n = send(socket, text.data() + at, static_cast<int>(text.size() - at), 0); check(n > 0); at += n; }
}
static void monitor(uint64_t generation, std::string server, uint64_t expiry, std::string username, std::string password,
    std::string config, uint64_t budget) noexcept {
    SOCKET socket = INVALID_SOCKET; std::string management_password;
    try {
        private_session session; session.write(L"client.ovpn", config); wipe(config);
        management_password = random_hex(); session.write(L"management.pass", management_password + "\n");
        SOCKET reservation = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); check(reservation != INVALID_SOCKET);
        sockaddr_in local{}; local.sin_family = AF_INET; local.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (bind(reservation, reinterpret_cast<sockaddr*>(&local), sizeof(local)) != 0) { closesocket(reservation); check(false); }
        int address_size = sizeof(local); check(getsockname(reservation, reinterpret_cast<sockaddr*>(&local), &address_size) == 0);
        uint16_t port = ntohs(local.sin_port); closesocket(reservation);
        auto executable = install_root() / L"Runtime" / L"openvpn.exe";
        std::wstring command = L"\"" + executable.wstring() + L"\" --config \"" + (session.directory / L"client.ovpn").wstring()
            + L"\" --management 127.0.0.1 " + std::to_wstring(port) + L" \"" + (session.directory / L"management.pass").wstring()
            + L"\" --management-query-passwords --management-hold --management-forget-disconnect --management-signal --windows-driver ovpn-dco --block-outside-dns --log NUL";
        handle job(CreateJobObjectW(nullptr, nullptr)); check(job.value != nullptr);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)));
        wchar_t system[32768]{}; check(GetWindowsDirectoryW(system, 32768));
        std::wstring environment = L"SystemRoot=" + std::wstring(system); environment += L'\0'; environment += L"PATH=" + std::wstring(system) + L"\\System32"; environment += L'\0'; environment += L'\0';
        STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION process{};
        check(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE,
            CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, environment.data(), executable.parent_path().c_str(), &startup, &process));
        handle child(process.hProcess), child_thread(process.hThread);
        if (!AssignProcessToJobObject(job, child)) { TerminateProcess(child, 1); check(false); }
        { std::lock_guard lock(state_mutex); if (tunnel.generation != generation) return;
            HANDLE duplicate = nullptr; check(DuplicateHandle(GetCurrentProcess(), job, GetCurrentProcess(), &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)); tunnel.job = duplicate; }
        check(ResumeThread(child_thread) != static_cast<DWORD>(-1));
        auto deadline = GetTickCount64() + budget;
        auto current_time = now(); check(expiry > current_time);
        auto session_deadline = GetTickCount64() + (expiry - current_time) * 1000;
        while (!listener_is_child(port, process.dwProcessId)) {
            check(GetTickCount64() < deadline && WaitForSingleObject(child, 0) == WAIT_TIMEOUT && !stopping.load()); Sleep(20);
        }
        socket = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); check(socket != INVALID_SOCKET);
        DWORD timeout = 500; setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout));
        setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout));
        check(connect(socket, reinterpret_cast<sockaddr*>(&local), sizeof(local)) == 0);
        std::string pending; bool authenticated = false, released = false, connected = false;
        while (!stopping.load() && now() < expiry && GetTickCount64() < session_deadline && WaitForSingleObject(child, 0) == WAIT_TIMEOUT) {
            { std::lock_guard lock(state_mutex); if (tunnel.generation != generation) break; }
            check(connected || GetTickCount64() < deadline);
            std::array<char, 1024> buffer{}; int n = recv(socket, buffer.data(), static_cast<int>(buffer.size()), 0);
            if (n == SOCKET_ERROR && WSAGetLastError() == WSAETIMEDOUT) continue;
            check(n > 0); pending.append(buffer.data(), n); check(pending.size() <= 16384);
            if (!authenticated && pending.find("ENTER PASSWORD:") != std::string::npos) { socket_send(socket, management_password + "\n"); wipe(management_password); authenticated = true; }
            size_t end;
            while ((end = pending.find('\n')) != std::string::npos) {
                auto text = pending.substr(0, end); pending.erase(0, end + 1); if (!text.empty() && text.back() == '\r') text.pop_back();
                if (text.find("SUCCESS: password is correct") != std::string::npos && !released) { socket_send(socket, "state on\nbytecount 1\nhold release\n"); released = true; }
                if (text == ">PASSWORD:Need 'Auth' username/password") socket_send(socket, "username \"Auth\" \"" + username + "\"\npassword \"Auth\" \"" + password + "\"\n");
                if (text.rfind(">PASSWORD:Verification Failed", 0) == 0) check(false);
                if (text.rfind(">STATE:", 0) == 0) {
                    std::vector<std::string> fields; std::istringstream input(text); std::string part; while (std::getline(input, part, ',')) fields.push_back(part);
                    bool success = fields.size() >= 4 && fields[1] == "CONNECTED" && fields[2] == "SUCCESS";
                    uint64_t luid = success ? tunnel_interface(fields[3]) : 0;
                    std::lock_guard lock(state_mutex); if (tunnel.generation != generation) break;
                    protection->apply(tunnel.protected_mode, tunnel.endpoints, luid, true);
                    bool was_connected = connected; tunnel.connected = connected = success; tunnel.luid = luid;
                    if (success && !tunnel.connected_at) tunnel.connected_at = now();
                    if (!success && was_connected) deadline = GetTickCount64() + 30000;
                    state_changed.notify_all();
                }
                if (text.rfind(">BYTECOUNT:", 0) == 0) {
                    auto comma = text.find(','); if (comma != std::string::npos) {
                        auto received = number(text.substr(11, comma - 11), UINT64_MAX), sent = number(text.substr(comma + 1), UINT64_MAX);
                        std::lock_guard lock(state_mutex); if (tunnel.generation == generation) { tunnel.received = received; tunnel.sent = sent; }
                    }
                }
            }
        }
        { std::lock_guard lock(state_mutex); if (tunnel.generation == generation) stop_tunnel_locked(); }
    } catch (...) {
        try { std::lock_guard lock(state_mutex); if (tunnel.generation == generation) stop_tunnel_locked(); } catch (...) {}
    }
    if (socket != INVALID_SOCKET) closesocket(socket);
    wipe(username); wipe(password); wipe(config); wipe(management_password);
}
static void request(HANDLE pipe) {
    auto header = line(pipe, 256);
    secret_guard clear_header{header};
    // Identification-level impersonation is used only to compare the caller SID.
    check(ImpersonateNamedPipeClient(pipe)); HANDLE raw_token = nullptr;
    BOOL opened = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &raw_token);
    std::wstring sid; try { check(opened); handle token(raw_token); sid = token_sid(token); } catch (...) { RevertToSelf(); throw; }
    check(RevertToSelf()); check(sid == console_sid());
    if (header == "CAPABILITIES") { send(pipe, firewall_verified ? "CAPABILITIES 3 kill-switch live-kill-switch\n" : "CAPABILITIES 3\n"); return; }
    if (header == "STATUS") { std::lock_guard lock(state_mutex); send(pipe, snapshot_locked()); return; }
    if (header == "DISCONNECT" || header == "EXPIRE") {
        std::lock_guard lock(state_mutex); stop_tunnel_locked();
        if (header == "DISCONNECT") { protection->apply(false, {}); tunnel.protected_mode = false; }
        send(pipe, snapshot_locked()); return;
    }
    if (header == "PROTECT 0" || header == "PROTECT 1") {
        std::unique_lock operation(operation_mutex, std::try_to_lock); check(operation.owns_lock());
        bool enabled = header == "PROTECT 1"; check(!enabled || firewall_verified);
        std::lock_guard lock(state_mutex); protection->apply(enabled, tunnel.endpoints, tunnel.luid, tunnel.job != nullptr); tunnel.protected_mode = enabled;
        send(pipe, enabled ? "PROTECTED 1\n" : "PROTECTED 0\n"); return;
    }
    std::istringstream input(header); std::vector<std::string> fields; std::string part; while (input >> part) fields.push_back(part);
    secret_fields_guard clear_fields{fields}; secret_guard clear_part{part};
    check(fields.size() == 8 && fields[0] == "CONNECT" && server_id(fields[1]));
    auto hex = [](const std::string& s) { return std::all_of(s.begin(), s.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }); };
    check(fields[2].size() == 22 && fields[2].rfind("stvpn_", 0) == 0 && hex(fields[2].substr(6)) && fields[3].size() == 32 && hex(fields[3]));
    auto expiry = number(fields[4], UINT64_MAX), size = number(fields[5], 131072), protect = number(fields[6], 1), budget = number(fields[7], 30000);
    check(expiry > now() && expiry - now() <= 7 * 86400 && size && budget && (!protect || firewall_verified));
    std::string config(static_cast<size_t>(size), '\0');
    secret_guard clear_config{config};
    size_t at = 0; auto read_deadline = GetTickCount64() + 3000;
    while (at < size) { at += transfer(pipe, false, config.data() + at, static_cast<DWORD>(size - at), remaining(read_deadline)); }
    auto endpoints = validate_config(config); verify_runtime();
    std::unique_lock operation(operation_mutex, std::try_to_lock); check(operation.owns_lock()); uint64_t generation;
    {
        std::lock_guard lock(state_mutex); stop_tunnel_locked(); protection->apply(protect != 0, endpoints, 0, true);
        tunnel.protected_mode = protect != 0; tunnel.endpoints = endpoints; tunnel.server = fields[1]; generation = tunnel.generation;
    }
    std::thread(monitor, generation, fields[1], expiry, std::move(fields[2]), std::move(fields[3]), std::move(config), budget).detach();
    wipe(header);
    std::unique_lock lock(state_mutex);
    bool ready = state_changed.wait_for(lock, std::chrono::milliseconds(budget), [&] { return tunnel.generation != generation || tunnel.connected || stopping.load(); });
    if (ready && tunnel.generation == generation && tunnel.connected) send(pipe, snapshot_locked());
    else { if (tunnel.generation == generation) stop_tunnel_locked(); send(pipe, "ERROR timeout\n"); }
}
static DWORD WINAPI control(DWORD code, DWORD, void*, void*) {
    if (code == SERVICE_CONTROL_STOP || code == SERVICE_CONTROL_SHUTDOWN) { stopping = true; SetEvent(stop_event); state_changed.notify_all(); }
    return NO_ERROR;
}
static void status(DWORD state, DWORD error = 0) {
    SERVICE_STATUS s{}; s.dwServiceType = SERVICE_WIN32_OWN_PROCESS; s.dwCurrentState = state; s.dwWin32ExitCode = error;
    s.dwControlsAccepted = state == SERVICE_RUNNING ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN : 0;
    SetServiceStatus(status_handle, &s);
}
static handle create_pipe(bool first) {
    local_memory descriptor;
    // SYSTEM and interactive users can open the endpoint; every request additionally
    // checks the current console user's exact SID before dispatching any operation.
    check(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;SY)(A;;GRGW;;;IU)", SDDL_REVISION_1, &descriptor.value, nullptr));
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor.value, FALSE};
    handle pipe(CreateNamedPipeW(pipe_name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 16, 4096, 4096, 3000, &attributes));
    check(pipe.value != INVALID_HANDLE_VALUE); return pipe;
}
static void WINAPI service_main(DWORD, LPWSTR*) {
    status_handle = RegisterServiceCtrlHandlerExW(service_name, control, nullptr); if (!status_handle) return;
    status(SERVICE_START_PENDING); handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); stop_event = event;
    try {
        WSADATA sockets{}; check(WSAStartup(MAKEWORD(2,2), &sockets) == 0); trusted_machine_path(module_path()); verify_runtime(); clean_orphaned_sessions();
        protection = std::make_unique<firewall>(); tunnel.protected_mode = protection->armed();
        if (!tunnel.protected_mode) protection->apply(false, {});
        firewall_verified = protection->self_test();
        handle pipe = create_pipe(true); status(SERVICE_RUNNING);
        while (!stopping.load()) {
            if (workers.load() >= 14) { WaitForSingleObject(stop_event, 50); continue; }
            handle ready(CreateEventW(nullptr, TRUE, FALSE, nullptr)); OVERLAPPED ov{}; ov.hEvent = ready;
            BOOL connected = ConnectNamedPipe(pipe, &ov); DWORD error = connected ? ERROR_SUCCESS : GetLastError();
            if (error == ERROR_PIPE_CONNECTED) SetEvent(ready);
            else check(connected || error == ERROR_IO_PENDING);
            HANDLE events[] = {ready, stop_event};
            DWORD waited = WaitForMultipleObjects(2, events, FALSE, INFINITE);
            if (waited != WAIT_OBJECT_0) { CancelIoEx(pipe, &ov); WaitForSingleObject(ready, INFINITE); break; }
            // Keep a server handle alive continuously so an unprivileged process
            // cannot squat the endpoint between requests. STATUS/cancel stay usable
            // while another worker waits for CONNECT.
            handle next = create_pipe(false); HANDLE accepted = pipe.release(); pipe = std::move(next); ++workers;
            std::thread([accepted] {
                handle connection(accepted);
                try { request(connection); } catch (...) { try { send(connection, "ERROR unavailable\n"); } catch (...) {} }
                DisconnectNamedPipe(connection); --workers;
            }).detach();
        }
        { std::lock_guard lock(state_mutex); stop_tunnel_locked(); }
        auto deadline = GetTickCount64() + 40000;
        while (workers.load() && GetTickCount64() < deadline) Sleep(20);
        status(SERVICE_STOPPED);
    } catch (...) { status(SERVICE_STOPPED, ERROR_SERVICE_SPECIFIC_ERROR); }
}
int wmain(int argc, wchar_t** argv) {
    if (argc == 2 && std::wstring(argv[1]) == L"--repair-install") {
        try { require_administrator(); verify_runtime(); provision_reviewed_driver(); install_service(); return 0; } catch (...) { return 1; }
    }
    if (argc == 2 && std::wstring(argv[1]) == L"--stop-for-update") {
        try { remove_service(false); return 0; } catch (...) { return 1; }
    }
    if (argc == 2 && std::wstring(argv[1]) == L"--uninstall-service") {
        try { remove_service(true); firewall f; f.uninstall(); clean_orphaned_sessions(); return 0; } catch (...) { return 1; }
    }
    // Fixed installer-only cleanup command; caller must already be elevated.
    if (argc == 2 && std::wstring(argv[1]) == L"--uninstall-cleanup") {
        try {
            require_administrator();
            firewall f; f.apply(false, {}); return 0;
        } catch (...) { return 1; }
    }
    if (argc != 1) return 1;
    SERVICE_TABLE_ENTRYW table[] = {{const_cast<LPWSTR>(service_name), service_main},{nullptr,nullptr}};
    return StartServiceCtrlDispatcherW(table) ? 0 : 1;
}

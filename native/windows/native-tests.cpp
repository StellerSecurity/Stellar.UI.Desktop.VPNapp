// Real Windows API tests using only synthetic data in a private temporary folder.
// Never starts a service, installs a driver, changes firewall/routes or contacts a host.
#define wmain stellar_service_entry_not_called
#include "service.cpp"
#undef wmain
#include "bridge.cpp"
#include <iostream>
#include <functional>

static unsigned passed = 0;
static void expect(bool value, const char* name) {
    if (!value) throw std::runtime_error(name);
    ++passed;
}
static void rejects(const std::function<void()>& operation, const char* name) {
    bool rejected = false;
    try { operation(); } catch (...) { rejected = true; }
    expect(rejected, name);
}
static std::string configuration(const std::string& protocol = "udp") {
    return "client\ndev tun\nproto " + protocol + "\nremote 192.0.2.10 1194\nremote-cert-tls server\n"
        "auth-user-pass\nauth-nocache\nscript-security 1\nallow-compression no\nauth-retry none\n"
        "<ca>\nSYNTHETIC\n</ca>\n<cert>\nSYNTHETIC\n</cert>\n<key>\nSYNTHETIC\n</key>\n";
}
struct fixture {
    std::filesystem::path directory, file, hardlink;
    fixture() {
        wchar_t temporary[32768]{};
        auto count = GetTempPathW(32768, temporary); check(count && count < 32768);
        auto suffix = random_hex();
        directory = std::filesystem::path(temporary) / (L"stellar-native-test-" + std::wstring(suffix.begin(), suffix.end()));
        check(CreateDirectoryW(directory.c_str(), nullptr));
        file = directory / L".stellar-vpn.dat"; hardlink = directory / L"synthetic-hardlink";
    }
    ~fixture() { DeleteFileW(hardlink.c_str()); DeleteFileW(file.c_str()); RemoveDirectoryW(directory.c_str()); }
    void write(const std::string& value) {
        std::ofstream output(file, std::ios::binary | std::ios::trunc); check(output.good());
        output.write(value.data(), static_cast<std::streamsize>(value.size())); output.close(); check(output.good());
    }
};
static void parser_tests() {
    for (const auto& protocol : {"udp", "udp4", "tcp-client", "tcp4-client"}) {
        auto endpoints = validate_config(configuration(protocol));
        expect(endpoints.size() == 1 && endpoints[0].address == 0xc000020a && endpoints[0].port == 1194,
            "validated endpoint differs from requested endpoint");
        expect(endpoints[0].protocol == (std::string(protocol).rfind("udp", 0) == 0 ? IPPROTO_UDP : IPPROTO_TCP), "protocol mismatch");
    }
    for (const auto& directive : {"up evil.exe", "down evil.exe", "plugin evil.dll", "config another.ovpn", "script-security 2",
        "management 0.0.0.0 7505", "auth-user-pass credentials.txt", "log output.log", "daemon", "setenv OPENSSL_CONF evil",
        "http-proxy localhost 1234", "pkcs11-providers evil.dll", "proto udp", "<connection>", "remote localhost 1194",
        "remote 127.0.0.1 1194", "remote 224.0.0.1 1194", "remote 0.0.0.0 1194", "remote ::1 1194", "remote 192.0.2.10 0",
        "remote 192.0.2.10 65536", "remote 192.0.2.10 18446744073709551616", "<key>\nSECOND\n</key>"}) {
        rejects([&] { validate_config(configuration() + directive + "\n"); }, "unsafe directive accepted");
    }
    rejects([] { validate_config(""); }, "empty config accepted");
    rejects([] { validate_config(std::string(131073, 'x')); }, "oversized config accepted");
    rejects([] { validate_config(configuration() + "verb 1\nverb 2\n"); }, "duplicate setting accepted");
    rejects([] { validate_config(configuration() + "<tls-auth>\nSYNTHETIC\n</tls-auth>\n"); }, "tls-auth without direction accepted");
    auto control = configuration(); control.push_back('\0');
    rejects([&] { validate_config(control); }, "embedded NUL accepted");
    auto too_many = configuration(); for (unsigned i = 0; i < 16; ++i) too_many += "remote 192.0.2.11 443\n";
    rejects([&] { validate_config(too_many); }, "unbounded remote list accepted");
    expect(server_id("ch-1") && !server_id("CH-1") && !server_id("ch-1\nDISCONNECT") && !server_id("../ch-1"), "server ID validation failed");
    expect(number("18446744073709551615", UINT64_MAX) == UINT64_MAX, "maximum uint64 rejected");
    for (const auto& invalid : {"", "-1", "+1", "1 2", "18446744073709551616"})
        rejects([&] { number(invalid, UINT64_MAX); }, "invalid number accepted");
    rejects([] { remaining(GetTickCount64()); }, "expired deadline did not fail closed");
}
static void migration_tests() {
    fixture data;
    std::vector<unsigned char> bytes(65536);
    expect(stellar_windows_legacy_read(data.file.c_str(), bytes.data(), bytes.size()) == 0, "missing synthetic legacy file is not empty");
    const std::string old = "{\"synthetic-token\":\"old\"}", next = "{\"synthetic-token\":\"new\"}";
    data.write(old);
    auto read = stellar_windows_legacy_read(data.file.c_str(), bytes.data(), bytes.size());
    expect(read == static_cast<int>(old.size()) && std::equal(old.begin(), old.end(), bytes.begin()), "synthetic legacy read failed");
    const auto replace = [&](const std::string& expected) {
        return stellar_windows_legacy_replace(data.file.c_str(), reinterpret_cast<const unsigned char*>(expected.data()), expected.size(),
            reinterpret_cast<const unsigned char*>(next.data()), next.size());
    };
    expect(replace("stale-value") == 0, "stale migration overwrote token file");
    expect(replace(old) == 1, "atomic synthetic migration failed");
    read = stellar_windows_legacy_read(data.file.c_str(), bytes.data(), bytes.size());
    expect(read == static_cast<int>(next.size()) && std::equal(next.begin(), next.end(), bytes.begin()), "migrated synthetic contents differ");
    expect(CreateHardLinkW(data.hardlink.c_str(), data.file.c_str(), nullptr), "synthetic hardlink creation failed");
    expect(stellar_windows_legacy_read(data.file.c_str(), bytes.data(), bytes.size()) == -1, "hardlinked token file accepted");
    expect(replace(next) == 0, "hardlinked token file overwritten");
    check(DeleteFileW(data.hardlink.c_str()));
    data.write(std::string(65537, 'x'));
    expect(stellar_windows_legacy_read(data.file.c_str(), bytes.data(), bytes.size()) == -1, "oversized token file accepted");
    expect(stellar_windows_legacy_read(L"relative\\.stellar-vpn.dat", bytes.data(), bytes.size()) == -1, "relative token path accepted");
    expect(stellar_windows_legacy_read(data.file.c_str(), bytes.data(), 64) == -1, "undersized output buffer accepted");
    data.write("abc");
    expect(sha256(data.file) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "native SHA256 mismatch");
}
static void bridge_tests() {
    expect(!service_needs_stop_control(SERVICE_STOPPED), "stopped helper requested another stop");
    expect(!service_needs_stop_control(SERVICE_STOP_PENDING), "stopping helper requested a duplicate stop");
    expect(service_needs_stop_control(SERVICE_RUNNING), "running helper skipped stop control");
    expect(service_needs_stop_control(SERVICE_PAUSED), "paused helper skipped stop control");
    unsigned char bytes[256]{};
    expect(stellar_windows_exchange(nullptr, 0, bytes, sizeof(bytes), 100) == -1, "invalid IPC input accepted");
    expect(stellar_windows_network_stamp(nullptr) == 0, "invalid network stamp output accepted");
    expect(stellar_windows_launch_installer(nullptr) == 0, "null installer path accepted");
    expect(stellar_windows_https(nullptr, 0, nullptr, nullptr) == 0, "null download input accepted");
    // No hostname reaches WinHTTP: callback and URL checks reject before connection.
    auto consume = [](const unsigned char*, size_t, void*) -> int { return 1; };
    for (const auto* url : {L"http://example.invalid/vpn/desktop-v2/file", L"https://example.invalid/vpn/desktop-v2/file",
        L"https://desktopreleasesassetsprod.stellarsecurity.com:444/vpn/desktop-v2/file",
        L"https://desktopreleasesassetsprod.stellarsecurity.com/other/file"})
        expect(stellar_windows_https(url, 1024, consume, nullptr) == 0, "non-allowlisted release URL accepted");
    auto instance = stellar_windows_instance(); expect(instance > 0, "native single-instance mutex creation failed");
    auto duplicate = stellar_windows_instance(); stellar_windows_close_instance(instance);
    expect(duplicate == 0, "duplicate process lock accepted");
    auto again = stellar_windows_instance(); expect(again > 0, "process lock not released"); stellar_windows_close_instance(again);
    expect(stellar_windows_autostart(0) == 1 && stellar_windows_autostart(1) == 1, "development runner did not skip autostart registration");
}
int main() {
    try {
        parser_tests(); migration_tests(); bridge_tests();
        std::cout << "{\"suite\":\"windows-native-synthetic\",\"assertionsPassed\":" << passed
            << ",\"serviceInstalled\":false,\"firewallChanged\":false,\"externalRequests\":false}" << std::endl;
        return 0;
    } catch (const std::exception& error) { std::cerr << "Native synthetic test failed: " << error.what() << std::endl; return 1; }
}

#pragma once
#ifndef _WIN32
#error Windows SDK required
#endif
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <wtsapi32.h>
#include <wintrust.h>
#include <softpub.h>
#include <shlobj.h>
#include <iphlpapi.h>
#include <netioapi.h>
#include <winhttp.h>
#include <fwpmu.h>
#include <bcrypt.h>
#include <rpc.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace stellar {
inline constexpr wchar_t service_name[] = L"StellarVPNDesktop";
inline constexpr wchar_t pipe_name[] = LR"(\\.\pipe\StellarVPN.Desktop.v1)";
inline void check(bool ok) { if (!ok) throw std::runtime_error("Windows operation unavailable"); }
struct handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    explicit handle(HANDLE h = INVALID_HANDLE_VALUE) : value(h) {}
    handle(const handle&) = delete;
    handle& operator=(const handle&) = delete;
    handle(handle&& h) noexcept : value(h.value) { h.value = INVALID_HANDLE_VALUE; }
    handle& operator=(handle&& h) noexcept { if (this != &h) { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = h.value; h.value = INVALID_HANDLE_VALUE; } return *this; }
    HANDLE release() { HANDLE h = value; value = INVALID_HANDLE_VALUE; return h; }
    ~handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    operator HANDLE() const { return value; }
};
struct local_memory {
    void* value = nullptr;
    ~local_memory() { if (value) LocalFree(value); }
};
inline std::wstring module_path() {
    std::wstring value(32768, L'\0');
    DWORD n = GetModuleFileNameW(nullptr, value.data(), static_cast<DWORD>(value.size()));
    check(n && n < value.size()); value.resize(n); return value;
}
inline std::filesystem::path install_root() {
    PWSTR p = nullptr;
    check(SUCCEEDED(SHGetKnownFolderPath(FOLDERID_ProgramFiles, KF_FLAG_DEFAULT, nullptr, &p)));
    std::filesystem::path root = std::filesystem::path(p) / L"Stellar VPN"; CoTaskMemFree(p); return root;
}
inline bool regular_no_links(const std::filesystem::path& p) {
    DWORD a = GetFileAttributesW(p.c_str());
    return a != INVALID_FILE_ATTRIBUTES && !(a & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY));
}
inline void trusted_machine_path(const std::filesystem::path& p) {
    // Every directory from Program Files down must reject unprivileged writes.
    auto root = install_root(); auto candidate = std::filesystem::absolute(p).lexically_normal();
    auto relative = candidate.lexically_relative(root);
    check(!relative.empty() && *relative.begin() != L"..");
    auto current = root;
    std::vector<std::filesystem::path> paths{current};
    for (const auto& part : relative) { current /= part; paths.push_back(current); }
    local_memory system, administrators, installer;
    check(ConvertStringSidToSidW(L"S-1-5-18", &system.value));
    check(ConvertStringSidToSidW(L"S-1-5-32-544", &administrators.value));
    check(ConvertStringSidToSidW(L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", &installer.value));
    for (const auto& path : paths) {
        DWORD attributes = GetFileAttributesW(path.c_str());
        check(attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT));
        PACL dacl = nullptr; PSID owner = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
        check(GetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &dacl, nullptr, &descriptor) == ERROR_SUCCESS);
        local_memory owned; owned.value = descriptor;
        auto trusted = [&](PSID sid) { return EqualSid(sid, system.value) || EqualSid(sid, administrators.value) || EqualSid(sid, installer.value); };
        check(dacl != nullptr && trusted(owner));
        for (DWORD i = 0; i < dacl->AceCount; ++i) {
            void* raw = nullptr; check(GetAce(dacl, i, &raw)); auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
            if (ace->Header.AceFlags & INHERIT_ONLY_ACE) continue;
            // Unknown conditional/object allow ACEs cannot be safely interpreted
            // as ordinary denies. Reject rather than trusting an incomplete ACL.
            check(ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE || ace->Header.AceType == ACCESS_DENIED_ACE_TYPE);
            if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE) continue;
            PSID sid = &ace->SidStart;
            check(trusted(sid) || !(ace->Mask & (GENERIC_WRITE | GENERIC_ALL | FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | DELETE | WRITE_DAC | WRITE_OWNER)));
        }
    }
}
inline void verify_signature(const std::filesystem::path& path) {
    check(regular_no_links(path)); trusted_machine_path(path);
    WINTRUST_FILE_INFO file{}; file.cbStruct = sizeof(file); file.pcwszFilePath = path.c_str();
    WINTRUST_DATA data{}; data.cbStruct = sizeof(data); data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN; data.dwUnionChoice = WTD_CHOICE_FILE;
    data.pFile = &file; data.dwStateAction = WTD_STATEACTION_VERIFY;
    data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT;
    GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    LONG result = WinVerifyTrust(nullptr, &policy, &data);
    data.dwStateAction = WTD_STATEACTION_CLOSE; WinVerifyTrust(nullptr, &policy, &data);
    check(result == ERROR_SUCCESS);
}
inline std::wstring token_sid(HANDLE token) {
    DWORD size = 0; GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    check(size && size < 65536); std::vector<unsigned char> bytes(size);
    check(GetTokenInformation(token, TokenUser, bytes.data(), size, &size));
    LPWSTR text = nullptr; check(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid, &text));
    std::wstring result(text); LocalFree(text); return result;
}
inline std::wstring console_sid() {
    DWORD session = WTSGetActiveConsoleSessionId(); check(session != 0xffffffff);
    HANDLE token = nullptr; check(WTSQueryUserToken(session, &token)); handle owned(token); return token_sid(token);
}
inline DWORD transfer(HANDLE pipe, bool write, void* buffer, DWORD size, DWORD timeout) {
    handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); check(event.value != nullptr);
    OVERLAPPED ov{}; ov.hEvent = event; DWORD count = 0;
    BOOL ok = write ? WriteFile(pipe, buffer, size, &count, &ov) : ReadFile(pipe, buffer, size, &count, &ov);
    if (!ok && GetLastError() == ERROR_IO_PENDING) {
        if (WaitForSingleObject(event, timeout) != WAIT_OBJECT_0) {
            CancelIoEx(pipe, &ov); WaitForSingleObject(event, INFINITE); throw std::runtime_error("Pipe timeout");
        }
        ok = GetOverlappedResult(pipe, &ov, &count, FALSE);
    }
    check(ok && count); return count;
}
inline DWORD remaining(ULONGLONG deadline) {
    auto current = GetTickCount64(); check(current < deadline);
    return static_cast<DWORD>(std::min<ULONGLONG>(deadline - current, MAXDWORD));
}
inline void send(HANDLE pipe, const std::string& text, DWORD timeout = 3000) {
    size_t offset = 0;
    while (offset < text.size()) offset += transfer(pipe, true, const_cast<char*>(text.data() + offset), static_cast<DWORD>(text.size() - offset), timeout);
}
inline std::string line(HANDLE pipe, size_t limit, DWORD timeout = 3000) {
    std::string value; auto deadline = GetTickCount64() + timeout;
    while (value.size() <= limit) { char c; transfer(pipe, false, &c, 1, remaining(deadline)); if (c == '\n') return value; check(c >= 32 && c < 127); value += c; }
    throw std::runtime_error("Request too large");
}
inline bool server_id(const std::string& s) {
    return !s.empty() && s.size() <= 64 && std::all_of(s.begin(), s.end(), [](char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'; });
}
inline uint64_t number(const std::string& s, uint64_t maximum) {
    check(!s.empty() && s.size() <= 20 && std::all_of(s.begin(), s.end(), [](char c) { return c >= '0' && c <= '9'; }));
    uint64_t n = 0;
    for (char c : s) { check(n <= (maximum - static_cast<unsigned>(c - '0')) / 10); n = n * 10 + c - '0'; }
    check(n <= maximum); return n;
}
inline void wipe(std::string& s) { if (!s.empty()) SecureZeroMemory(s.data(), s.size()); s.clear(); }
inline std::string random_hex() {
    std::array<unsigned char, 32> bytes{}; check(BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0);
    const char* digits = "0123456789abcdef"; std::string result;
    for (auto b : bytes) { result += digits[b >> 4]; result += digits[b & 15]; } SecureZeroMemory(bytes.data(), bytes.size()); return result;
}
inline std::string sha256(const std::filesystem::path& path) {
    BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
    check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0);
    try {
        check(BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) == 0);
        std::ifstream input(path, std::ios::binary); check(input.good()); std::array<char, 32768> buffer{};
        while (input) { input.read(buffer.data(), buffer.size()); auto count = input.gcount(); if (count) check(BCryptHashData(hash, reinterpret_cast<PUCHAR>(buffer.data()), static_cast<ULONG>(count), 0) == 0); }
        check(input.eof()); std::array<unsigned char, 32> digest{};
        check(BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) == 0);
        BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0);
        std::string result; const char* digits = "0123456789abcdef"; for (auto b : digest) { result += digits[b >> 4]; result += digits[b & 15]; } return result;
    } catch (...) { if (hash) BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0); throw; }
}
}

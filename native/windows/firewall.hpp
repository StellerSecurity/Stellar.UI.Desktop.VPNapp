#pragma once
#include "common.hpp"

namespace stellar {
inline const GUID provider_key = {0x54979a90,0x9474,0x4f74,{0xb4,0x81,0x68,0xb1,0x23,0x45,0x7c,0x51}};
inline const GUID sublayer_key = {0xad188538,0x92be,0x4c9f,{0x89,0xbd,0x60,0x85,0x1b,0xde,0xc6,0x42}};
struct endpoint { uint32_t address; uint16_t port; uint8_t protocol; };
class firewall {
    HANDLE engine_ = nullptr;
    void erase_filters() {
        FWPM_FILTER_ENUM_TEMPLATE0 query{}; query.providerKey = const_cast<GUID*>(&provider_key);
        HANDLE enumeration = nullptr; check(FwpmFilterCreateEnumHandle0(engine_, &query, &enumeration) == ERROR_SUCCESS);
        try {
            while (true) {
                FWPM_FILTER0** filters = nullptr; UINT32 count = 0;
                check(FwpmFilterEnum0(engine_, enumeration, 256, &filters, &count) == ERROR_SUCCESS);
                std::vector<UINT64> ids;
                for (UINT32 i = 0; i < count; ++i) ids.push_back(filters[i]->filterId);
                FwpmFreeMemory0(reinterpret_cast<void**>(&filters));
                for (auto id : ids) check(FwpmFilterDeleteById0(engine_, id) == ERROR_SUCCESS);
                if (count < 256) break;
            }
        } catch (...) { FwpmFilterDestroyEnumHandle0(engine_, enumeration); throw; }
        FwpmFilterDestroyEnumHandle0(engine_, enumeration);
    }
    static void add(HANDLE engine, const GUID& layer, FWP_ACTION_TYPE action, uint8_t weight,
        std::vector<FWPM_FILTER_CONDITION0> conditions, bool persistent = true) {
        FWPM_FILTER0 filter{}; auto uuid = UuidCreate(&filter.filterKey); check(uuid == RPC_S_OK || uuid == RPC_S_UUID_LOCAL_ONLY);
        filter.displayData.name = const_cast<wchar_t*>(L"Stellar VPN network protection");
        filter.providerKey = const_cast<GUID*>(&provider_key); filter.subLayerKey = sublayer_key;
        filter.layerKey = layer; filter.action.type = action;
        // Soft permits preserve other firewall providers' blocking decisions.
        filter.weight.type = FWP_UINT8; filter.weight.uint8 = weight;
        filter.flags = persistent ? FWPM_FILTER_FLAG_PERSISTENT : 0;
        filter.numFilterConditions = static_cast<UINT32>(conditions.size()); filter.filterCondition = conditions.data();
        check(FwpmFilterAdd0(engine, &filter, nullptr, nullptr) == ERROR_SUCCESS);
    }
    static FWPM_FILTER_CONDITION0 condition(const GUID& key, FWP_DATA_TYPE type) {
        FWPM_FILTER_CONDITION0 c{}; c.fieldKey = key; c.matchType = FWP_MATCH_EQUAL; c.conditionValue.type = type; return c;
    }
public:
    firewall() {
        check(FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, nullptr, &engine_) == ERROR_SUCCESS);
        FWPM_PROVIDER0 p{}; p.providerKey = provider_key; p.flags = FWPM_PROVIDER_FLAG_PERSISTENT;
        p.displayData.name = const_cast<wchar_t*>(L"Stellar VPN");
        auto r = FwpmProviderAdd0(engine_, &p, nullptr); check(r == ERROR_SUCCESS || r == FWP_E_ALREADY_EXISTS);
        FWPM_SUBLAYER0 s{}; s.subLayerKey = sublayer_key; s.flags = FWPM_SUBLAYER_FLAG_PERSISTENT;
        s.providerKey = const_cast<GUID*>(&provider_key); s.displayData.name = p.displayData.name; s.weight = 0x7000;
        r = FwpmSubLayerAdd0(engine_, &s, nullptr); check(r == ERROR_SUCCESS || r == FWP_E_ALREADY_EXISTS);
    }
    ~firewall() { if (engine_) FwpmEngineClose0(engine_); } // Intentionally does NOT disarm on crash/service stop.
    void uninstall() {
        apply(false, {});
        auto result = FwpmSubLayerDeleteByKey0(engine_, &sublayer_key);
        check(result == ERROR_SUCCESS || result == FWP_E_SUBLAYER_NOT_FOUND);
        result = FwpmProviderDeleteByKey0(engine_, &provider_key);
        check(result == ERROR_SUCCESS || result == FWP_E_PROVIDER_NOT_FOUND);
    }
    bool armed() {
        FWPM_FILTER_ENUM_TEMPLATE0 query{}; query.providerKey = const_cast<GUID*>(&provider_key);
        HANDLE enumeration = nullptr; check(FwpmFilterCreateEnumHandle0(engine_, &query, &enumeration) == ERROR_SUCCESS);
        FWPM_FILTER0** filters = nullptr; UINT32 count = 0;
        auto result = FwpmFilterEnum0(engine_, enumeration, 256, &filters, &count); bool protected_mode = false;
        for (UINT32 i = 0; i < count; ++i) {
            if (IsEqualGUID(filters[i]->layerKey, FWPM_LAYER_ALE_AUTH_CONNECT_V4) && filters[i]->action.type == FWP_ACTION_BLOCK) protected_mode = true;
        }
        FwpmFreeMemory0(reinterpret_cast<void**>(&filters)); FwpmFilterDestroyEnumHandle0(engine_, enumeration);
        check(result == ERROR_SUCCESS && count < 256); return protected_mode;
    }
    void apply(bool enabled, const std::vector<endpoint>& endpoints, uint64_t tunnel_luid = 0, bool ipv6_only = false) {
        check(endpoints.size() <= 16);
        check(FwpmTransactionBegin0(engine_, 0) == ERROR_SUCCESS);
        FWP_BYTE_BLOB* app = nullptr;
        try {
            erase_filters();
            if (enabled || ipv6_only) {
                auto exe = install_root() / L"Runtime" / L"openvpn.exe";
                check(FwpmGetAppIdFromFileName0(exe.c_str(), &app) == ERROR_SUCCESS);
                const GUID layers[] = {FWPM_LAYER_ALE_AUTH_CONNECT_V4, FWPM_LAYER_ALE_AUTH_CONNECT_V6,
                    FWPM_LAYER_OUTBOUND_TRANSPORT_V4, FWPM_LAYER_OUTBOUND_TRANSPORT_V6};
                for (size_t i = 0; i < 4; ++i) {
                    if (!enabled && i % 2 == 0) continue;
                    add(engine_, layers[i], FWP_ACTION_BLOCK, 1, {});
                    auto loopback = condition(FWPM_CONDITION_FLAGS, FWP_UINT32);
                    loopback.matchType = FWP_MATCH_FLAGS_ALL_SET; loopback.conditionValue.uint32 = FWP_CONDITION_FLAG_IS_LOOPBACK;
                    add(engine_, layers[i], FWP_ACTION_PERMIT, 10, {loopback});
                    if (tunnel_luid) {
                        auto c = condition(FWPM_CONDITION_IP_LOCAL_INTERFACE, FWP_UINT64); c.conditionValue.uint64 = &tunnel_luid;
                        add(engine_, layers[i], FWP_ACTION_PERMIT, 20, {c});
                    }
                    if (i % 2 != 0) continue; // Current restricted config accepts IPv4 literals only.
                    for (const auto& e : endpoints) {
                        auto address = condition(FWPM_CONDITION_IP_REMOTE_ADDRESS, FWP_UINT32); address.conditionValue.uint32 = e.address;
                        auto port = condition(FWPM_CONDITION_IP_REMOTE_PORT, FWP_UINT16); port.conditionValue.uint16 = e.port;
                        auto protocol = condition(FWPM_CONDITION_IP_PROTOCOL, FWP_UINT8); protocol.conditionValue.uint8 = e.protocol;
                        std::vector<FWPM_FILTER_CONDITION0> conditions{address, port, protocol};
                        if (i == 0) { auto id = condition(FWPM_CONDITION_ALE_APP_ID, FWP_BYTE_BLOB_TYPE); id.conditionValue.byteBlob = app; conditions.push_back(id); }
                        add(engine_, layers[i], FWP_ACTION_PERMIT, 30, conditions);
                    }
                }
            }
            check(FwpmTransactionCommit0(engine_) == ERROR_SUCCESS);
        } catch (...) { FwpmTransactionAbort0(engine_); if (app) FwpmFreeMemory0(reinterpret_cast<void**>(&app)); throw; }
        if (app) FwpmFreeMemory0(reinterpret_cast<void**>(&app));
    }
    bool self_test() {
        // Private loopback probes only. No external host, DNS or user's sockets.
        // Dynamic test filters disappear automatically on any failure or service crash.
        for (int family : {AF_INET, AF_INET6}) {
            SOCKET receiver = socket(family, SOCK_DGRAM, IPPROTO_UDP), sender = socket(family, SOCK_DGRAM, IPPROTO_UDP);
            if (receiver == INVALID_SOCKET || sender == INVALID_SOCKET) { if (receiver != INVALID_SOCKET) closesocket(receiver); if (sender != INVALID_SOCKET) closesocket(sender); return false; }
            HANDLE test = nullptr; FWP_BYTE_BLOB* application = nullptr; bool passed = false;
            try {
                sockaddr_storage address{}; int size;
                if (family == AF_INET) { auto* a = reinterpret_cast<sockaddr_in*>(&address); a->sin_family = AF_INET; a->sin_addr.s_addr = htonl(INADDR_LOOPBACK); size = sizeof(*a); }
                else { auto* a = reinterpret_cast<sockaddr_in6*>(&address); a->sin6_family = AF_INET6; a->sin6_addr = in6addr_loopback; size = sizeof(*a); }
                check(bind(receiver, reinterpret_cast<sockaddr*>(&address), size) == 0);
                check(getsockname(receiver, reinterpret_cast<sockaddr*>(&address), &size) == 0);
                DWORD timeout = 250; check(setsockopt(receiver, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout)) == 0);
                char buffer[16]{};
                // A blocked probe is meaningful only if the same loopback path
                // works before and after the temporary filter.
                check(sendto(sender, "before", 6, 0, reinterpret_cast<sockaddr*>(&address), size) == 6);
                check(recv(receiver, buffer, sizeof(buffer), 0) == 6);
                closesocket(sender); sender = socket(family, SOCK_DGRAM, IPPROTO_UDP); check(sender != INVALID_SOCKET);
                FWPM_SESSION0 session{}; session.flags = FWPM_SESSION_FLAG_DYNAMIC;
                check(FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, &session, &test) == ERROR_SUCCESS);
                auto port = condition(FWPM_CONDITION_IP_REMOTE_PORT, FWP_UINT16);
                port.conditionValue.uint16 = ntohs(family == AF_INET ? reinterpret_cast<sockaddr_in*>(&address)->sin_port : reinterpret_cast<sockaddr_in6*>(&address)->sin6_port);
                auto protocol = condition(FWPM_CONDITION_IP_PROTOCOL, FWP_UINT8); protocol.conditionValue.uint8 = IPPROTO_UDP;
                auto loopback = condition(FWPM_CONDITION_FLAGS, FWP_UINT32); loopback.matchType = FWP_MATCH_FLAGS_ALL_SET; loopback.conditionValue.uint32 = FWP_CONDITION_FLAG_IS_LOOPBACK;
                check(FwpmGetAppIdFromFileName0(module_path().c_str(), &application) == ERROR_SUCCESS);
                auto app = condition(FWPM_CONDITION_ALE_APP_ID, FWP_BYTE_BLOB_TYPE); app.conditionValue.byteBlob = application;
                add(test, family == AF_INET ? FWPM_LAYER_ALE_AUTH_CONNECT_V4 : FWPM_LAYER_ALE_AUTH_CONNECT_V6, FWP_ACTION_BLOCK, 255, {port, protocol, loopback, app}, false);
                int sent = sendto(sender, "Stellar", 7, 0, reinterpret_cast<sockaddr*>(&address), size);
                int send_error = sent == SOCKET_ERROR ? WSAGetLastError() : 0;
                int received = recv(receiver, buffer, sizeof(buffer), 0); int receive_error = WSAGetLastError();
                check(received == SOCKET_ERROR && receive_error == WSAETIMEDOUT && (sent == 7 || send_error == WSAEACCES));
                FwpmEngineClose0(test); test = nullptr;
                closesocket(sender); sender = socket(family, SOCK_DGRAM, IPPROTO_UDP); check(sender != INVALID_SOCKET);
                check(sendto(sender, "after", 5, 0, reinterpret_cast<sockaddr*>(&address), size) == 5);
                check(recv(receiver, buffer, sizeof(buffer), 0) == 5); passed = true;
            } catch (...) { passed = false; }
            if (application) FwpmFreeMemory0(reinterpret_cast<void**>(&application));
            if (test) FwpmEngineClose0(test); closesocket(receiver); closesocket(sender);
            if (!passed) return false;
        }
        return true;
    }
};
}

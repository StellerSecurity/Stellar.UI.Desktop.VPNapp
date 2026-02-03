import React, { useMemo, useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import {
  fetchServerList,
  type VpnServer,
  setSelectedServer,
  getSelectedServer,
} from "../../services/api";
import { invoke } from "@tauri-apps/api/core";

type ServerItem = {
  id: string;
  name: string;
  config_url?: string;
  protocols?: string[];
};

type City = {
  name: string;
  servers: ServerItem[];
};

type Country = {
  id: string;
  name: string;
  countryCode?: string; // ISO like "CH"
  cities: City[];
};

const LS_MANUAL_DISABLED = "vpn_manual_disabled";

// --- Server list cache (stale-while-revalidate) ---
const SERVER_CACHE_KEY = "stellar_vpn_servers_cache_v1";

// “Fresh” window: use cache instantly and still refresh in background
const SERVER_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days (kept for readability)

// “Max stale” fallback: if network fails, still allow old list (offline mode)
const SERVER_CACHE_MAX_STALE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

type ServerCachePayload = {
  ts: number;
  servers: VpnServer[];
};

function readServerCache(): ServerCachePayload | null {
  try {
    const raw = window.localStorage.getItem(SERVER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ServerCachePayload;
    if (!parsed || typeof parsed.ts !== "number" || !Array.isArray(parsed.servers)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeServerCache(servers: VpnServer[]) {
  try {
    const payload: ServerCachePayload = { ts: Date.now(), servers };
    window.localStorage.setItem(SERVER_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function serversRoughlyEqual(a: VpnServer[], b: VpnServer[]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;

  // Cheap-ish comparison: ids + config_url
  for (let i = 0; i < a.length; i++) {
    const A = a[i] as any;
    const B = b[i] as any;
    if ((A?.id ?? "") !== (B?.id ?? "")) return false;
    if ((A?.config_url ?? "") !== (B?.config_url ?? "")) return false;
  }
  return true;
}

function transformServerList(servers: VpnServer[]): Country[] {
  const countriesMap = new Map<string, Country>();

  servers.forEach((server) => {
    const nameParts = server.name.split("–").map((s) => s.trim());
    const countryName = nameParts[0] || server.country;
    const cityName = nameParts[1] || "Unknown";
    const countryId = countryName.toLowerCase().replace(/\s+/g, "-");

    let country = countriesMap.get(countryId);
    if (!country) {
      country = {
        id: countryId,
        name: countryName,
        countryCode: server.country || undefined,
        cities: [],
      };
      countriesMap.set(countryId, country);
    } else if (!country.countryCode && server.country) {
      country.countryCode = server.country;
    }

    let city = country.cities.find((c) => c.name === cityName);
    if (!city) {
      city = { name: cityName, servers: [] };
      country.cities.push(city);
    }

    city.servers.push({
      id: server.id,
      name: server.name,
      config_url: server.config_url,
      protocols: server.protocols,
    });
  });

  return Array.from(countriesMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

const SkeletonRow: React.FC<{ className?: string }> = ({ className = "" }) => (
    <div className={`relative overflow-hidden rounded-2xl bg-[#EAEAF0] ${className}`}>
      <div className="absolute inset-0 -translate-x-[120%] bg-gradient-to-r from-transparent via-white/70 to-transparent animate-shimmer" />
    </div>
);

const flagSrcForCountry = (code?: string) => {
  if (!code) return "/icons/flag.svg";
  return `/flags/${code.toLowerCase()}.svg`;
};

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const looksLikeUrl = (s: string) => /^https?:\/\//i.test(s.trim());

export const ChangeLocation: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const [expandedCountry, setExpandedCountry] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState("");
  const [countriesData, setCountriesData] = useState<Country[]>([]);
  const [rawServers, setRawServers] = useState<VpnServer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectingServerId, setSelectingServerId] = useState<string | null>(null);
  const FASTEST_ID = "__fastest__";

  // Remember what user selected (for UI highlight + open correct country)
  const [selectedServerName, setSelectedServerName] = useState<string | null>(null);
  const [selectedServerConfig, setSelectedServerConfig] = useState<string | null>(null);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);

  const countryRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const serverRefs = useRef<Record<string, HTMLLIElement | null>>({});

  // Re-run auto-open every time you enter this route
  const didAutoOpenRef = useRef(false);
  useEffect(() => {
    didAutoOpenRef.current = false;
  }, [location.key]);

  const backToDashboardAndFocusMap = useCallback(
      (countryCode?: string | null, connectNow?: boolean) => {
        navigate("/dashboard", {
          state: {
            focusCountryCode: (countryCode || "").trim().toUpperCase() || null,
            connectNow: !!connectNow,
          },
        });
      },
      [navigate]
  );

  const ensureLocalConfig = useCallback(async (cfg: string): Promise<string> => {
    const trimmed = (cfg || "").trim();
    if (!trimmed) throw new Error("Missing config URL");

    if (!looksLikeUrl(trimmed)) return trimmed;
    if (!isTauri()) return trimmed;

    const ks = await invoke<boolean>("vpn_kill_switch_enabled").catch(() => false);
    if (!ks) return trimmed;

    const st = await invoke<string>("vpn_status").catch(() => "unknown");
    if (st !== "connected") {
      throw new Error(
          "Kill switch er slået til, og VPN er ikke forbundet. Du kan kun skifte server mens VPN er forbundet (så vi kan hente config via tunnelen), ellers skal du slå kill switch fra midlertidigt."
      );
    }

    // Tauri expects camelCase argument name
    const localPath = await invoke<string>("vpn_prefetch_config", { configPath: trimmed });

    if (!localPath || !localPath.trim()) throw new Error("Prefetch returned empty path");
    return localPath.trim();
  }, []);

  const findCountryIdForSelected = useCallback(
      (transformed: Country[], opts: { selectedId?: string | null; selectedName?: string | null }) => {
        const q = (searchParams.get("country") || "").trim().toLowerCase();
        if (q) {
          const match = transformed.find((c) => (c.countryCode || "").toLowerCase() === q);
          if (match) return match.id;
        }

        const sid = (opts.selectedId || "").trim();
        if (sid) {
          for (const c of transformed) {
            for (const city of c.cities) {
              for (const srv of city.servers) {
                if ((srv.id || "").trim() === sid) return c.id;
              }
            }
          }
        }

        const sn = (opts.selectedName || "").trim();
        if (sn) {
          for (const c of transformed) {
            for (const city of c.cities) {
              for (const srv of city.servers) {
                if ((srv.name || "").trim() === sn) return c.id;
              }
            }
          }
        }

        return transformed.length > 0 ? transformed[0].id : null;
      },
      [searchParams]
  );

  useEffect(() => {
    let mounted = true;

    const loadSelected = async () => {
      try {
        const selected = await getSelectedServer();

        const name =
            typeof (selected as any)?.name === "string"
                ? (selected as any).name
                : typeof (selected as any)?.serverName === "string"
                    ? (selected as any).serverName
                    : typeof (selected as any)?.server_name === "string"
                        ? (selected as any).server_name
                        : null;

        const cfg =
            typeof (selected as any)?.config_url === "string"
                ? (selected as any).config_url
                : typeof (selected as any)?.configUrl === "string"
                    ? (selected as any).configUrl
                    : typeof (selected as any)?.config_path === "string"
                        ? (selected as any).config_path
                        : null;

        const sid =
            typeof (selected as any)?.serverId === "string"
                ? (selected as any).serverId
                : typeof (selected as any)?.server_id === "string"
                    ? (selected as any).server_id
                    : null;

        if (!mounted) return;

        setSelectedServerName(name ? String(name).trim() : null);
        setSelectedServerConfig(cfg ? String(cfg).trim() : null);
        setSelectedServerId(sid ? String(sid).trim() : null);
      } catch {
        // ignore
      }
    };

    const hydrateFromCache = () => {
      const cached = readServerCache();
      if (!cached) return false;

      const age = Date.now() - cached.ts;
      if (age > SERVER_CACHE_MAX_STALE_MS) return false;

      const transformed = transformServerList(cached.servers);
      if (!mounted) return true;

      setRawServers(cached.servers);
      setCountriesData(transformed);
      setError(null);
      setIsLoading(false);

      return true;
    };

    const backgroundRefresh = async () => {
      const cached = readServerCache();
      const hadCache = !!cached && Date.now() - cached.ts <= SERVER_CACHE_MAX_STALE_MS;
      if (hadCache) setIsRefreshing(true);

      try {
        const servers = await fetchServerList();

        if (!mounted) return;

        if (!servers || servers.length === 0) {
          if (!hadCache) {
            setError("No servers available");
            setCountriesData([]);
            setRawServers([]);
          }
          return;
        }

        const prev = readServerCache()?.servers ?? [];
        if (!serversRoughlyEqual(prev, servers)) {
          writeServerCache(servers);
        }

        setRawServers(servers);
        const transformed = transformServerList(servers);
        setCountriesData(transformed);
        setError(null);
      } catch (err) {
        console.error("Server list refresh failed:", err);

        if (!mounted) return;

        const cached2 = readServerCache();
        const canFallback = !!cached2 && Date.now() - cached2.ts <= SERVER_CACHE_MAX_STALE_MS;

        if (!canFallback) {
          setError("Failed to load server list");
          setCountriesData([]);
          setRawServers([]);
        }
      } finally {
        if (!mounted) return;
        setIsLoading(false);
        setIsRefreshing(false);
      }
    };

    (async () => {
      // Load selection first so we can auto-open/scroll correctly
      await loadSelected();

      const hasCache = hydrateFromCache();
      void backgroundRefresh();

      if (!hasCache) setIsLoading(true);
    })();

    return () => {
      mounted = false;
    };
  }, [location.key]); // important: re-run on every route entry

  // Auto-open + auto-scroll every time you enter ChangeLocation
  useEffect(() => {
    if (didAutoOpenRef.current) return;
    if (isLoading) return;
    if (error) return;
    if (!countriesData || countriesData.length === 0) return;

    const openId = findCountryIdForSelected(countriesData, {
      selectedId: selectedServerId,
      selectedName: selectedServerName,
    });

    if (!openId) return;

    didAutoOpenRef.current = true;
    setExpandedCountry(openId);

    window.setTimeout(() => {
      const container = countryRefs.current[openId];
      if (container && typeof container.scrollIntoView === "function") {
        container.scrollIntoView({ behavior: "smooth", block: "start" });
      }

      const sid = (selectedServerId || "").trim();
      if (sid) {
        const row = serverRefs.current[sid];
        if (row && typeof row.scrollIntoView === "function") {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }, 140);
  }, [
    isLoading,
    error,
    countriesData,
    selectedServerId,
    selectedServerName,
    findCountryIdForSelected,
    location.key,
  ]);

  const normalizedSearch = searchTerm.trim().toLowerCase();

  const filteredCountries = useMemo(() => {
    if (normalizedSearch.length === 0) return countriesData;
    return countriesData.filter((country) => country.name.toLowerCase().includes(normalizedSearch));
  }, [countriesData, normalizedSearch]);

  const toggleCountry = (countryId: string) => {
    setExpandedCountry((prev) => (prev === countryId ? "" : countryId));
  };

  const pickRandomServer = (): VpnServer | null => {
    const candidates = rawServers.filter((s) => (s.config_url || "").trim().length > 0);
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  };

  const handleFastestClick = async () => {
    if (selectingServerId !== null) return;
    if (isLoading || error) return;

    const s = pickRandomServer();
    if (!s || !s.config_url) {
      alert("No server available for Fastest.");
      return;
    }

    setSelectingServerId(FASTEST_ID);

    try {
      const cfgToStore = await ensureLocalConfig(s.config_url);

      try {
        window.localStorage.setItem(LS_MANUAL_DISABLED, "0");
      } catch {
        // ignore
      }

      await setSelectedServer(s.name, cfgToStore, (s.country || "").toLowerCase() || undefined, s.id);

      // Keep UI remembering selection
      setSelectedServerName(s.name);
      setSelectedServerConfig(cfgToStore);
      setSelectedServerId(s.id);

      backToDashboardAndFocusMap(s.country || null, true);
    } catch (e: any) {
      console.error("Fastest select failed:", e);
      const msg = typeof e === "string" ? e : e?.message ? String(e.message) : "Unknown error";
      alert("Could not select fastest server.\n\n" + msg);
      navigate("/dashboard");
    } finally {
      setSelectingServerId(null);
    }
  };

  return (
      <AuthShell title="Change Location" onBack={() => navigate("/dashboard")}>
        <div className="flex flex-col h-full min-h-0">
          <div className="mb-4 relative px-0">
            <div className="absolute left-5 top-1/2 -translate-y-1/2 flex items-center justify-center pointer-events-none z-10">
              <img src="/icons/search.svg" alt="Search" className="w-5 h-5" />
            </div>
            <input
                placeholder="Search for country"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full rounded-[54px] bg-inputBg h-[42px] pl-12 pr-6 outline-none focus:outline-none focus:ring-0 text-textDark placeholder:text-[#62626A] text-[14px]"
            />
          </div>

          <div className="flex-1 min-h-0 overflow-auto text-sm rounded-2xl custom-scrollbar bg-white">
            {isLoading && (
                <div className="p-6" role="status" aria-busy="true">
                  <div className="flex items-center gap-3">
                    <div className="w-6 h-6 rounded-full border-2 border-[#0B0C19]/15 border-t-[#0B0C19] animate-spin" />
                    <div className="flex flex-col">
                      <span className="text-[13px] font-semibold text-[#0B0C19]">Loading servers</span>
                      <span className="text-[11px] text-[#62626A]">Fetching locations…</span>
                    </div>
                  </div>

                  <div className="mt-5">
                    <SkeletonRow className="h-[52px]" />
                  </div>

                  <div className="mt-4 space-y-3">
                    <SkeletonRow className="h-[56px]" />
                    <SkeletonRow className="h-[56px]" />
                    <SkeletonRow className="h-[56px]" />
                    <SkeletonRow className="h-[56px]" />
                  </div>
                </div>
            )}

            {!isLoading && (
                <div className="px-8 pt-4 pb-2 flex items-center justify-between">
                  <div className="text-[11px] text-[#62626A]">{isRefreshing ? "Updating server list…" : ""}</div>
                  {isRefreshing && (
                      <div className="w-4 h-4 rounded-full border-2 border-[#62626A]/20 border-t-[#62626A] animate-spin" />
                  )}
                </div>
            )}

            {!isLoading && error && <div className="p-8 text-center text-red-500">{error}</div>}

            {!isLoading && !error && filteredCountries.length === 0 && (
                <div className="p-8 text-center text-[#62626A]">No servers found</div>
            )}

            {!isLoading && !error && (
                <>
                  <button
                      type="button"
                      onClick={handleFastestClick}
                      disabled={selectingServerId !== null}
                      className={[
                        "w-full rounded-2xl py-3 px-8 flex items-center justify-between",
                        "transition-all duration-200",
                        "hover:bg-[#F6F6FD] hover:shadow-sm hover:-translate-y-[1px]",
                        "active:translate-y-0 active:scale-[0.995]",
                        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-none disabled:hover:translate-y-0",
                      ].join(" ")}
                  >
                    <div className="text-[14px] flex items-center gap-3 text-[#0B0C19]">
                      <img src="/icons/world-check.svg" alt="World Check" className="w-[22px] h-[22px]" />
                      <span>Fastest</span>

                      {selectingServerId === FASTEST_ID && (
                          <span className="ml-2 inline-flex items-center gap-2 text-[11px] text-[#62626A]">
                      <span className="w-3 h-3 rounded-full border-2 border-[#62626A]/20 border-t-[#62626A] animate-spin" />
                      Selecting…
                    </span>
                      )}
                    </div>

                    <img src="/icons/right-arrow.svg" alt="Arrow" className="w-5 h-4" />
                  </button>

                  {filteredCountries.map((country) => {
                    const isOpen = expandedCountry === country.id;

                    return (
                        <div
                            key={country.id}
                            ref={(el) => {
                              countryRefs.current[country.id] = el;
                            }}
                            className={["transition-colors duration-200", isOpen ? "bg-[#F6F6FD]" : ""].join(" ")}
                        >
                          <button
                              type="button"
                              onClick={() => toggleCountry(country.id)}
                              disabled={selectingServerId !== null}
                              className={[
                                "w-full text-[#0B0C19] py-4 px-8 flex items-center justify-between text-left",
                                "transition-all duration-200",
                                "hover:bg-[#F0F0FB]",
                                "active:scale-[0.995]",
                                "disabled:opacity-60 disabled:cursor-not-allowed",
                              ].join(" ")}
                          >
                            <div className="flex items-center gap-3">
                              <img
                                  src={flagSrcForCountry(country.countryCode)}
                                  onError={(e) => {
                                    (e.currentTarget as HTMLImageElement).src = "/icons/flag.svg";
                                  }}
                                  alt={`${country.name} flag`}
                                  className={[
                                    "w-6 h-6 rounded-full",
                                    "transition-transform duration-200",
                                    isOpen ? "scale-[1.05]" : "scale-100",
                                  ].join(" ")}
                              />
                              <span className={["text-[13px] transition-all duration-200", isOpen ? "font-semibold" : "font-normal"].join(" ")}>
                          {country.name}
                        </span>
                            </div>

                            <div className={["transition-transform duration-300", isOpen ? "rotate-180" : "rotate-0"].join(" ")}>
                              <img src="/icons/back.svg" alt="Arrow" className="w-4 h-5" />
                            </div>
                          </button>

                          <div
                              className={[
                                "grid transition-all duration-300 ease-in-out",
                                isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                              ].join(" ")}
                          >
                            <div className="overflow-hidden">
                              <div className="bg-[#F6F6FD] px-16 pb-2">
                                {country.cities.map((city, cityIndex) => (
                                    <div key={cityIndex}>
                                      <div className="font-semibold text-[#0B0C19] text-[12px] py-4 flex items-center gap-2">
                                        <div className="w-2 h-2 rounded-full bg-[#00B252]" />
                                        <span>{city.name}</span>
                                      </div>

                                      <ul className="text-[#0B0C19] text-[12px] pl-6">
                                        {city.servers.map((server) => {
                                          const disabled =
                                              !server.config_url || (selectingServerId !== null && selectingServerId !== server.id);

                                          const isSelectingRow = selectingServerId === server.id;

                                          // Highlight selected server (prefer stable id)
                                          const isSelected =
                                              (!!selectedServerId && selectedServerId.trim() === (server.id || "").trim()) ||
                                              (!!selectedServerName && selectedServerName.trim() === (server.name || "").trim()) ||
                                              (!!selectedServerConfig &&
                                                  !!server.config_url &&
                                                  selectedServerConfig.trim() === server.config_url.trim());

                                          return (
                                              <li
                                                  ref={(el) => {
                                                    serverRefs.current[server.id] = el;
                                                  }}
                                                  key={server.id}
                                                  className={[
                                                    "py-4 flex items-center gap-2",
                                                    "transition-all duration-200",
                                                    disabled
                                                        ? "opacity-50 cursor-not-allowed"
                                                        : "cursor-pointer hover:translate-x-[2px] hover:opacity-100",
                                                    !disabled ? "active:scale-[0.995]" : "",
                                                  ].join(" ")}
                                                  onClick={async () => {
                                                    if (disabled) return;
                                                    if (!server.config_url) return;

                                                    setSelectingServerId(server.id);

                                                    try {
                                                      const cfgToStore = await ensureLocalConfig(server.config_url);

                                                      try {
                                                        window.localStorage.setItem(LS_MANUAL_DISABLED, "0");
                                                      } catch {
                                                        // ignore
                                                      }

                                                      await setSelectedServer(
                                                          server.name,
                                                          cfgToStore,
                                                          country.countryCode ? country.countryCode.toLowerCase() : undefined,
                                                          server.id
                                                      );

                                                      setSelectedServerName(server.name);
                                                      setSelectedServerConfig(cfgToStore);
                                                      setSelectedServerId(server.id);

                                                      backToDashboardAndFocusMap(country.countryCode || null, true);
                                                    } catch (e: any) {
                                                      console.error("Failed to select server:", e);

                                                      const msg =
                                                          typeof e === "string" ? e : e?.message ? String(e.message) : "Unknown error";

                                                      alert("Could not select server.\n\n" + msg);
                                                      navigate("/dashboard");
                                                    } finally {
                                                      setSelectingServerId(null);
                                                    }
                                                  }}
                                              >
                                                <div className="w-2 h-2 rounded-full bg-[#00B252]" />

                                                <span className="ml-1">{server.name}</span>

                                                {isSelected && (
                                                    <span className="ml-2 text-[11px] font-semibold text-[#2761FC]">Selected</span>
                                                )}

                                                {isSelectingRow && (
                                                    <span className="ml-2 inline-flex items-center gap-2 text-[11px] text-[#62626A]">
                                          <span className="w-3 h-3 rounded-full border-2 border-[#62626A]/20 border-t-[#62626A] animate-spin" />
                                          Selecting…
                                        </span>
                                                )}
                                              </li>
                                          );
                                        })}
                                      </ul>
                                    </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                    );
                  })}
                </>
            )}
          </div>
        </div>
      </AuthShell>
  );
};

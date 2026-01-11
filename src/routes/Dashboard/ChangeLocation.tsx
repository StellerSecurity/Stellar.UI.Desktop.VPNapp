import React, { useMemo, useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import {
  fetchServerList,
  type VpnServer,
  setSelectedServer,
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

const isTauri = () =>
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// TEMP TEST CREDS (do NOT ship this)
const DEFAULT_OVPN_USERNAME = "stvpn_eu_test_1";
const DEFAULT_OVPN_PASSWORD = "testpassword";

const LS_MANUAL_DISABLED = "vpn_manual_disabled";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const flagSrcForCountry = (code?: string) => {
  if (!code) return "/icons/flag.svg";
  return `/flags/${code.toLowerCase()}.svg`;
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms
    );
    p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        }
    );
  });
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

  return Array.from(countriesMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
  );
}

const SkeletonRow: React.FC<{ className?: string }> = ({ className = "" }) => (
    <div className={`relative overflow-hidden rounded-2xl bg-[#EAEAF0] ${className}`}>
      <div className="absolute inset-0 -translate-x-[120%] bg-gradient-to-r from-transparent via-white/70 to-transparent animate-shimmer" />
    </div>
);

export const ChangeLocation: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [expandedCountry, setExpandedCountry] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState("");
  const [countriesData, setCountriesData] = useState<Country[]>([]);
  const [rawServers, setRawServers] = useState<VpnServer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [connectingServerId, setConnectingServerId] = useState<string | null>(null);
  const FASTEST_ID = "__fastest__";

  const countryRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const backToDashboardAndFocusMap = useCallback((countryCode?: string | null) => {
    navigate("/dashboard", {
      state: {
        focusCountryCode: (countryCode || "").trim().toUpperCase() || null,
      },
    });
  }, [navigate]);

  useEffect(() => {
    const loadServers = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const servers = await fetchServerList();
        if (!servers || servers.length === 0) {
          setError("No servers available");
          setCountriesData([]);
          setRawServers([]);
          return;
        }

        setRawServers(servers);
        const transformed = transformServerList(servers);
        setCountriesData(transformed);

        if (transformed.length > 0) setExpandedCountry(transformed[0].id);

        const q = (searchParams.get("country") || "").trim().toLowerCase();
        if (q) {
          const match = transformed.find(
              (c) => (c.countryCode || "").toLowerCase() === q
          );
          if (match) setExpandedCountry(match.id);
        }
      } catch (err) {
        console.error("Error loading server list:", err);
        setError("Failed to load server list");
        setCountriesData([]);
        setRawServers([]);
      } finally {
        setIsLoading(false);
      }
    };

    loadServers();
  }, [searchParams]);

  useEffect(() => {
    if (!expandedCountry) return;
    const el = countryRefs.current[expandedCountry];
    if (!el) return;

    const t = window.setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);

    return () => clearTimeout(t);
  }, [expandedCountry]);

  const normalizedSearch = searchTerm.trim().toLowerCase();

  const filteredCountries = useMemo(() => {
    if (normalizedSearch.length === 0) return countriesData;
    return countriesData.filter((country) =>
        country.name.toLowerCase().includes(normalizedSearch)
    );
  }, [countriesData, normalizedSearch]);

  const toggleCountry = (countryId: string) => {
    setExpandedCountry((prev) => (prev === countryId ? "" : countryId));
  };

  const connectToSelectedServer = async (configUrl: string) => {
    if (!isTauri()) return;

    try {
      window.localStorage.setItem(LS_MANUAL_DISABLED, "0");
    } catch {}

    const backendStatus = await invoke<string>("vpn_status").catch(() => "disconnected");
    if (backendStatus === "connected" || backendStatus === "connecting") {
      await invoke("vpn_disconnect").catch(() => {});
      await sleep(250);
    }

    await withTimeout(
        invoke("vpn_connect", {
          configPath: configUrl,
          username: DEFAULT_OVPN_USERNAME,
          password: DEFAULT_OVPN_PASSWORD,
        }),
        10_000,
        "VPN connect"
    );
  };

  const pickRandomServer = (): VpnServer | null => {
    const candidates = rawServers.filter((s) => (s.config_url || "").trim().length > 0);
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  };

  const handleFastestClick = async () => {
    if (connectingServerId !== null) return;
    if (isLoading || error) return;

    const s = pickRandomServer();
    if (!s || !s.config_url) {
      alert("No server available for Fastest.");
      return;
    }

    setConnectingServerId(FASTEST_ID);

    try {
      const cfg = s.config_url;
      await setSelectedServer(
          s.name,
          cfg,
          (s.country || "").toLowerCase() || undefined
      );

      await connectToSelectedServer(cfg);
      backToDashboardAndFocusMap(s.country || null);
    } catch (e: any) {
      console.error("Fastest connect failed:", e);
      await invoke("vpn_disconnect").catch(() => {});

      const msg =
          typeof e === "string" ? e : e?.message ? String(e.message) : "Unknown error";

      alert("Fastest server connect failed.\n\n" + msg);
      navigate("/dashboard");
    } finally {
      setConnectingServerId(null);
    }
  };

  return (
      <AuthShell title="Change Location" onBack={() => navigate("/dashboard")}>
        {/* IMPORTANT: fill available height and control scroll locally */}
        <div className="h-full min-h-0 flex flex-col">
          {/* Search (non-scroll) */}
          <div className="shrink-0 mb-4 relative px-0">
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

          {/* List area (THIS is the only scroll container) */}
          <div className="flex-1 min-h-0 overflow-y-auto text-sm rounded-2xl custom-scrollbar bg-white">
            {isLoading && (
                <div className="p-6" role="status" aria-busy="true">
                  <div className="flex items-center gap-3">
                    <div className="w-6 h-6 rounded-full border-2 border-[#0B0C19]/15 border-t-[#0B0C19] animate-spin" />
                    <div className="flex flex-col">
                  <span className="text-[13px] font-semibold text-[#0B0C19]">
                    Loading servers
                  </span>
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

            {!isLoading && error && (
                <div className="p-8 text-center text-red-500">{error}</div>
            )}

            {!isLoading && !error && filteredCountries.length === 0 && (
                <div className="p-8 text-center text-[#62626A]">No servers found</div>
            )}

            {!isLoading && !error && (
                <>
                  <button
                      type="button"
                      onClick={handleFastestClick}
                      disabled={connectingServerId !== null}
                      className={[
                        "w-full rounded-2xl py-3 px-8 flex items-center justify-between",
                        "transition-all duration-200",
                        "hover:bg-[#F6F6FD] hover:shadow-sm hover:-translate-y-[1px]",
                        "active:translate-y-0 active:scale-[0.995]",
                        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-none disabled:hover:translate-y-0",
                      ].join(" ")}
                  >
                    <div className="text-[14px] flex items-center gap-3 text-[#0B0C19]">
                      <img
                          src="/icons/world-check.svg"
                          alt="World Check"
                          className="w-[22px] h-[22px]"
                      />
                      <span>Fastest</span>

                      {connectingServerId === FASTEST_ID && (
                          <span className="ml-2 inline-flex items-center gap-2 text-[11px] text-[#62626A]">
                      <span className="w-3 h-3 rounded-full border-2 border-[#62626A]/20 border-t-[#62626A] animate-spin" />
                      Connecting…
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
                            className={[
                              "transition-colors duration-200",
                              isOpen ? "bg-[#F6F6FD]" : "",
                            ].join(" ")}
                        >
                          <button
                              type="button"
                              onClick={() => toggleCountry(country.id)}
                              disabled={connectingServerId !== null}
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
                              <span
                                  className={[
                                    "text-[13px] transition-all duration-200",
                                    isOpen ? "font-semibold" : "font-normal",
                                  ].join(" ")}
                              >
                          {country.name}
                        </span>
                            </div>

                            <div
                                className={[
                                  "transition-transform duration-300",
                                  isOpen ? "rotate-180" : "rotate-0",
                                ].join(" ")}
                            >
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
                                              !server.config_url ||
                                              (connectingServerId !== null &&
                                                  connectingServerId !== server.id);

                                          const isConnectingRow = connectingServerId === server.id;

                                          return (
                                              <li
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

                                                    const cfg = server.config_url;
                                                    setConnectingServerId(server.id);

                                                    try {
                                                      await setSelectedServer(
                                                          server.name,
                                                          cfg,
                                                          country.countryCode
                                                              ? country.countryCode.toLowerCase()
                                                              : undefined
                                                      );

                                                      await connectToSelectedServer(cfg);
                                                      backToDashboardAndFocusMap(country.countryCode || null);
                                                    } catch (e: any) {
                                                      console.error("Failed to connect on selection:", e);
                                                      await invoke("vpn_disconnect").catch(() => {});

                                                      const msg =
                                                          typeof e === "string"
                                                              ? e
                                                              : e?.message
                                                                  ? String(e.message)
                                                                  : "Unknown error";

                                                      alert("Could not start VPN.\n\n" + msg);
                                                      navigate("/dashboard");
                                                    } finally {
                                                      setConnectingServerId(null);
                                                    }
                                                  }}
                                              >
                                                <div className="w-2 h-2 rounded-full bg-[#00B252]" />
                                                <span className="ml-1">{server.name}</span>

                                                {isConnectingRow && (
                                                    <span className="ml-2 inline-flex items-center gap-2 text-[11px] text-[#62626A]">
                                          <span className="w-3 h-3 rounded-full border-2 border-[#62626A]/20 border-t-[#62626A] animate-spin" />
                                          Connecting…
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

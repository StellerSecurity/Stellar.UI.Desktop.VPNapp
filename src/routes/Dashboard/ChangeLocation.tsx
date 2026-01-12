import React, { useMemo, useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { fetchServerList, type VpnServer, setSelectedServer } from "../../services/api";

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

// Same key your Dashboard uses (prevents auto-reconnect logic fighting you)
const LS_MANUAL_DISABLED = "vpn_manual_disabled";

/**
 * Transform flat server list into nested Country -> City -> Server structure
 */
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

/** Sexy skeleton row (shimmer) */
const SkeletonRow: React.FC<{ className?: string }> = ({ className = "" }) => (
    <div className={`relative overflow-hidden rounded-2xl bg-[#EAEAF0] ${className}`}>
      <div className="absolute inset-0 -translate-x-[120%] bg-gradient-to-r from-transparent via-white/70 to-transparent animate-shimmer" />
    </div>
);

const flagSrcForCountry = (code?: string) => {
  if (!code) return "/icons/flag.svg";
  return `/flags/${code.toLowerCase()}.svg`;
};

export const ChangeLocation: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [expandedCountry, setExpandedCountry] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState("");
  const [countriesData, setCountriesData] = useState<Country[]>([]);
  const [rawServers, setRawServers] = useState<VpnServer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI feedback only (we are NOT connecting from here anymore)
  const [selectingServerId, setSelectingServerId] = useState<string | null>(null);
  const FASTEST_ID = "__fastest__";

  // countryId -> ref (for smooth scroll when opening from ?country=CH)
  const countryRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const backToDashboardAndFocusMap = useCallback(
      (countryCode?: string | null, connectNow?: boolean) => {
        navigate("/dashboard", {
          state: {
            focusCountryCode: (countryCode || "").trim().toUpperCase() || null,
            connectNow: !!connectNow, // Dashboard is the only place that actually connects
          },
        });
      },
      [navigate]
  );

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

        // Default open
        if (transformed.length > 0) setExpandedCountry(transformed[0].id);

        // If we came with ?country=CH (from dashboard map click), open it
        const q = (searchParams.get("country") || "").trim().toLowerCase();
        if (q) {
          const match = transformed.find((c) => (c.countryCode || "").toLowerCase() === q);
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
      const cfg = s.config_url;

      // Allow dashboard connect flow (manual action)
      try {
        window.localStorage.setItem(LS_MANUAL_DISABLED, "0");
      } catch {
        // ignore
      }

      await setSelectedServer(s.name, cfg, (s.country || "").toLowerCase() || undefined);

      // Go back and let Dashboard connect (single source of truth)
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
        {/* IMPORTANT: make only the list scroll, not the whole window */}
        <div className="flex flex-col h-full min-h-0">
          {/* Search */}
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

          {/* Scroll area */}
          <div className="flex-1 min-h-0 overflow-auto text-sm rounded-2xl custom-scrollbar bg-white">
            {/* Loading */}
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

            {/* Error */}
            {!isLoading && error && <div className="p-8 text-center text-red-500">{error}</div>}

            {/* Empty */}
            {!isLoading && !error && filteredCountries.length === 0 && (
                <div className="p-8 text-center text-[#62626A]">No servers found</div>
            )}

            {/* Content */}
            {!isLoading && !error && (
                <>
                  {/* Fastest */}
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

                  {/* Countries */}
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
                          {/* Country row */}
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
                              <span
                                  className={[
                                    "text-[13px] transition-all duration-200",
                                    isOpen ? "font-semibold" : "font-normal",
                                  ].join(" ")}
                              >
                          {country.name}
                        </span>
                            </div>

                            <div className={["transition-transform duration-300", isOpen ? "rotate-180" : "rotate-0"].join(" ")}>
                              <img src="/icons/back.svg" alt="Arrow" className="w-4 h-5" />
                            </div>
                          </button>

                          {/* Expand content with animation */}
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
                                              (selectingServerId !== null && selectingServerId !== server.id);

                                          const isSelectingRow = selectingServerId === server.id;

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
                                                    setSelectingServerId(server.id);

                                                    try {
                                                      // Allow dashboard connect flow (manual action)
                                                      try {
                                                        window.localStorage.setItem(LS_MANUAL_DISABLED, "0");
                                                      } catch {
                                                        // ignore
                                                      }

                                                      await setSelectedServer(
                                                          server.name,
                                                          cfg,
                                                          country.countryCode ? country.countryCode.toLowerCase() : undefined
                                                      );

                                                      // Go back and let Dashboard connect (single source of truth)
                                                      backToDashboardAndFocusMap(country.countryCode || null, true);
                                                    } catch (e: any) {
                                                      console.error("Failed to select server:", e);

                                                      const msg =
                                                          typeof e === "string"
                                                              ? e
                                                              : e?.message
                                                                  ? String(e.message)
                                                                  : "Unknown error";

                                                      alert("Could not select server.\n\n" + msg);
                                                      navigate("/dashboard");
                                                    } finally {
                                                      setSelectingServerId(null);
                                                    }
                                                  }}
                                              >
                                                <div className="w-2 h-2 rounded-full bg-[#00B252]" />
                                                <span className="ml-1">{server.name}</span>

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

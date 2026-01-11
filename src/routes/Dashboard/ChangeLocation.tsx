import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import { fetchServerList, type VpnServer, setSelectedServer } from "../../services/api";
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
  countryCode?: string; // ISO code like "CH"
  cities: City[];
};

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// TEMP TEST CREDS (do NOT ship this)
const DEFAULT_OVPN_USERNAME = "stvpn_eu_test_1";
const DEFAULT_OVPN_PASSWORD = "testpassword";

// Same key your Dashboard uses (prevents auto-reconnect logic fighting you)
const LS_MANUAL_DISABLED = "vpn_manual_disabled";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const flagSrcForCountry = (code?: string) => {
  if (!code) return "/icons/flag.svg";
  return `/flags/${code.toLowerCase()}.svg`;
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
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

/**
 * Transform flat server list from API into nested Country -> City -> Server structure
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
    } else {
      if (!country.countryCode && server.country) {
        country.countryCode = server.country;
      }
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

export const ChangeLocation: React.FC = () => {
  const navigate = useNavigate();
  const [expandedCountry, setExpandedCountry] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState("");
  const [countriesData, setCountriesData] = useState<Country[]>([]);
  const [rawServers, setRawServers] = useState<VpnServer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [connectingServerId, setConnectingServerId] = useState<string | null>(null);
  const FASTEST_ID = "__fastest__";

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
  }, []);

  const toggleCountry = (countryId: string) => {
    setExpandedCountry(expandedCountry === countryId ? "" : countryId);
  };

  const normalizedSearch = searchTerm.trim().toLowerCase();
  const filteredCountries =
      normalizedSearch.length === 0
          ? countriesData
          : countriesData.filter((country) => country.name.toLowerCase().includes(normalizedSearch));

  const connectToSelectedServer = async (configUrl: string) => {
    if (!isTauri()) return;

    // Manual action: ensure Dashboard won't block it
    try {
      window.localStorage.setItem(LS_MANUAL_DISABLED, "0");
    } catch {
      // ignore
    }

    // If VPN is running, disconnect first
    const backendStatus = await invoke<string>("vpn_status").catch(() => "disconnected");
    if (backendStatus === "connected" || backendStatus === "connecting") {
      await invoke("vpn_disconnect").catch(() => {});
      await sleep(250);
    }

    // Connect with timeout to avoid “stuck connecting”
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
    const i = Math.floor(Math.random() * candidates.length);
    return candidates[i];
  };

  const handleFastestClick = async () => {
    if (connectingServerId !== null) return;
    if (isLoading || error) return;

    const s = pickRandomServer();
    if (!s) {
      alert("No server available for Fastest.");
      return;
    }

    setConnectingServerId(FASTEST_ID);

    try {
      await setSelectedServer(s.name, s.config_url, (s.country || "").toLowerCase() || undefined);
      await connectToSelectedServer(s.config_url);
      navigate("/dashboard");
    } catch (e: any) {
      console.error("Fastest connect failed:", e);
      await invoke("vpn_disconnect").catch(() => {});

      const msg = typeof e === "string" ? e : e?.message ? String(e.message) : "Unknown error";
      alert("Fastest server connect failed.\n\n" + msg);
      navigate("/dashboard");
    } finally {
      setConnectingServerId(null);
    }
  };

  return (
      <AuthShell title="Change Location" onBack={() => navigate("/dashboard")}>
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

        <div className="overflow-auto text-sm rounded-2xl custom-scrollbar bg-white">
          {isLoading && <div className="p-8 text-center text-[#62626A]">Loading servers...</div>}
          {error && <div className="p-8 text-center text-red-500">{error}</div>}
          {!isLoading && !error && filteredCountries.length === 0 && (
              <div className="p-8 text-center text-[#62626A]">No servers found</div>
          )}

          {/* Fastest (clickable) */}
          <button
              type="button"
              onClick={handleFastestClick}
              disabled={isLoading || !!error || connectingServerId !== null}
              className="w-full rounded-2xl py-3 px-8 flex items-center justify-between hover:bg-[#F6F6FD] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="text-[14px] flex items-center gap-3 text-[#0B0C19]">
              <img src="/icons/world-check.svg" alt="World Check" className="w-[22px] h-[22px]" />
              <span>Fastest</span>
              {connectingServerId === FASTEST_ID && (
                  <span className="ml-2 text-[11px] text-[#62626A]">Connecting...</span>
              )}
            </div>

            <img src="/icons/right-arrow.svg" alt="Arrow" className="w-5 h-4" />
          </button>

          {!isLoading &&
              !error &&
              filteredCountries.map((country) => (
                  <div key={country.id} className={expandedCountry === country.id ? "bg-[#F6F6FD]" : ""}>
                    <button
                        type="button"
                        onClick={() => toggleCountry(country.id)}
                        className="w-full text-[#0B0C19] py-4 px-8 flex items-center justify-between text-left"
                        disabled={connectingServerId !== null}
                    >
                      <div className="flex items-center gap-3">
                        <img
                            src={flagSrcForCountry(country.countryCode)}
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).src = "/icons/flag.svg";
                            }}
                            alt={`${country.name} flag`}
                            className="w-6 h-6 rounded-full"
                        />
                        <span
                            className={`text-[13px] ${expandedCountry === country.id ? "font-semibold" : "font-normal"}`}
                        >
                    {country.name}
                  </span>
                      </div>

                      <div className={`backk-arrow transition-transform ${expandedCountry === country.id ? "rotate-180" : ""}`}>
                        <img src="/icons/back.svg" alt="Arrow" className="w-4 h-5" />
                      </div>
                    </button>

                    {expandedCountry === country.id && (
                        <div className="bg-[#F6F6FD] px-16">
                          {country.cities.map((city, cityIndex) => (
                              <div key={cityIndex}>
                                <div className="font-semibold text-[#0B0C19] text-[12px] py-4 flex items-center gap-2">
                                  <div className="w-2 h-2 rounded-full bg-[#00B252]"></div>
                                  <span>{city.name}</span>
                                </div>

                                <ul className="text-[#0B0C19] text-[12px] pl-6">
                                  {city.servers.map((server) => {
                                    const disabled =
                                        !server.config_url ||
                                        (connectingServerId !== null && connectingServerId !== server.id);

                                    return (
                                        <li
                                            key={server.id}
                                            className={`py-4 flex items-center gap-2 transition-opacity ${
                                                disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:opacity-80"
                                            }`}
                                            onClick={async () => {
                                              if (disabled) return;
                                              if (!server.config_url) return;

                                              setConnectingServerId(server.id);

                                              try {
                                                await setSelectedServer(
                                                    server.name,
                                                    server.config_url,
                                                    country.countryCode ? country.countryCode.toLowerCase() : undefined
                                                );

                                                await connectToSelectedServer(server.config_url);
                                                navigate("/dashboard");
                                              } catch (e: any) {
                                                console.error("Failed to connect on selection:", e);
                                                await invoke("vpn_disconnect").catch(() => {});

                                                const msg =
                                                    typeof e === "string"
                                                        ? e
                                                        : e?.message
                                                            ? String(e.message)
                                                            : "Unknown error";

                                                if (
                                                    msg.includes("Operation not permitted") ||
                                                    msg.includes("CAP_NET_ADMIN") ||
                                                    msg.includes("Kill switch needs root")
                                                ) {
                                                  alert(
                                                      "Could not start VPN because kill switch needs root/CAP_NET_ADMIN.\n\nRun the app with sudo or grant capabilities (dev helper)."
                                                  );
                                                } else if (msg.includes("timed out")) {
                                                  alert("VPN connect timed out.\n\nCheck backend logs and OpenVPN process output.");
                                                } else {
                                                  alert("Could not start VPN on the selected server.\n\n" + msg);
                                                }

                                                navigate("/dashboard");
                                              } finally {
                                                setConnectingServerId(null);
                                              }
                                            }}
                                        >
                                          <div className="w-2 h-2 rounded-full bg-[#00B252]"></div>
                                          <span className="ml-1">{server.name}</span>
                                          {connectingServerId === server.id && (
                                              <span className="ml-2 text-[11px] text-[#62626A]">Connecting...</span>
                                          )}
                                        </li>
                                    );
                                  })}
                                </ul>
                              </div>
                          ))}
                        </div>
                    )}
                  </div>
              ))}
        </div>
      </AuthShell>
  );
};

import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";
import {
  fetchServerList,
  type VpnServer,
  setSelectedServer,
} from "../../services/api";

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
  cities: City[];
};

/**
 * Transform flat server list from API into nested Country -> City -> Server structure
 */
function transformServerList(servers: VpnServer[]): Country[] {
  // Map to store countries
  const countriesMap = new Map<string, Country>();

  servers.forEach((server) => {
    // Parse name format: "Switzerland – Zurich" or "USA – New York"
    const nameParts = server.name.split("–").map((s) => s.trim());
    const countryName = nameParts[0] || server.country;
    const cityName = nameParts[1] || "Unknown";

    // Create country ID from country name (lowercase, replace spaces with hyphens)
    const countryId = countryName.toLowerCase().replace(/\s+/g, "-");

    // Get or create country
    let country = countriesMap.get(countryId);
    if (!country) {
      country = {
        id: countryId,
        name: countryName,
        cities: [],
      };
      countriesMap.set(countryId, country);
    }

    // Find or create city
    let city = country.cities.find((c) => c.name === cityName);
    if (!city) {
      city = {
        name: cityName,
        servers: [],
      };
      country.cities.push(city);
    }

    // Add server to city
    city.servers.push({
      id: server.id,
      name: server.name,
      config_url: server.config_url,
      protocols: server.protocols,
    });
  });

  // Convert map to array and sort
  return Array.from(countriesMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

export const ChangeLocation: React.FC = () => {
  const navigate = useNavigate();
  const [expandedCountry, setExpandedCountry] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState("");
  const [countriesData, setCountriesData] = useState<Country[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch server list from API
  useEffect(() => {
    const loadServers = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const servers = await fetchServerList();

        if (!servers || servers.length === 0) {
          setError("No servers available");
          setCountriesData([]);
          return;
        }

        const transformed = transformServerList(servers);
        setCountriesData(transformed);

        // Auto-expand first country if available
        if (transformed.length > 0) {
          setExpandedCountry(transformed[0].id);
        }
      } catch (err) {
        console.error("Error loading server list:", err);
        setError("Failed to load server list");
        setCountriesData([]);
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
      : countriesData.filter((country) =>
          country.name.toLowerCase().includes(normalizedSearch)
        );

  return (
    <AuthShell title="Change Location" onBack={() => navigate("/dashboard")}>
      <div className="mb-4 relative px-0">
        <img
          src="/icons/search.svg"
          alt="Search"
          className="absolute left-5 top-1/2 -translate-y-1/2 w-[18px] h-[18px] pointer-events-none"
        />
        <input
          placeholder="Search for country"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full rounded-[54px] bg-inputBg h-[52px] pl-12 pr-6 outline-none focus:outline-none focus:ring-0 text-textDark placeholder:text-[#62626A] text-[14px]"
        />
      </div>
      <div className="overflow-auto text-sm rounded-2xl custom-scrollbar bg-white">
        {isLoading && (
          <div className="p-8 text-center text-[#62626A]">
            Loading servers...
          </div>
        )}
        {error && <div className="p-8 text-center text-red-500">{error}</div>}
        {!isLoading && !error && filteredCountries.length === 0 && (
          <div className="p-8 text-center text-[#62626A]">No servers found</div>
        )}
        <div className="rounded-2xl py-3 px-8">
          <div className="text-[14px] flex items-center gap-3 text-[#0B0C19]">
            <img
              src="/icons/world-check.svg"
              alt="World Check"
              className="w-[22px] h-[22px] font-regular"
            />
            <span>Fastest</span>
          </div>
        </div>
        {!isLoading &&
          !error &&
          filteredCountries.map((country) => (
            <div
              key={country.id}
              className={expandedCountry === country.id ? "bg-[#F6F6FD]" : ""}
            >
              <button
                type="button"
                onClick={() => toggleCountry(country.id)}
                className={`w-full text-[#0B0C19] py-4 px-8 flex items-center justify-between text-left ${
                  expandedCountry === country.id ? "" : ""
                }`}
              >
                <div className="flex items-center gap-3">
                  <img
                    src="/icons/flag.svg"
                    alt="Flag"
                    className="w-6 h-6 rounded-full"
                  />
                  <span
                    className={
                      expandedCountry === country.id ? "font-semibold" : ""
                    }
                  >
                    {country.name}
                  </span>
                </div>
                <img
                  src="/icons/back.svg"
                  alt="Arrow"
                  className={`w-2 h-3 transition-transform ${
                    expandedCountry === country.id ? "rotate-90" : "-rotate-90"
                  }`}
                />
              </button>
              {expandedCountry === country.id && (
                <div className="bg-[#F6F6FD] px-16">
                  {country.cities.map((city, cityIndex) => (
                    <div key={cityIndex}>
                      <div className="font-semibold text-[#0B0C19] text-[14px] py-4 flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-[#00B252]"></div>
                        <span>{city.name}</span>
                      </div>
                      <ul className="text-[#0B0C19] text-sm pl-6">
                        {city.servers.map((server) => (
                          <li
                            key={server.id}
                            className="py-4 flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
                            onClick={async () => {
                              if (server.config_url) {
                                await setSelectedServer(
                                  server.name,
                                  server.config_url
                                );
                                navigate("/dashboard");
                              }
                            }}
                          >
                            <div className="w-2 h-2 rounded-full bg-[#00B252]"></div>
                            <span className="ml-1">{server.name}</span>
                          </li>
                        ))}
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

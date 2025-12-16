import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AuthShell } from "../../components/layout/AuthShell";

type ServerItem = {
  id: string;
  name: string;
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

const countriesData: Country[] = [
  {
    id: "switzerland",
    name: "Switzerland",
    cities: [
      {
        name: "Zurich",
        servers: [
          { id: "1", name: "se-mm-01235" },
          { id: "2", name: "se-mm-01236" },
          { id: "3", name: "se-mm-01237" },
        ],
      },
    ],
  },
  {
    id: "germany",
    name: "Germany",
    cities: [
      {
        name: "Berlin",
        servers: [
          { id: "4", name: "de-ber-001" },
          { id: "5", name: "de-ber-002" },
        ],
      },
      {
        name: "Frankfurt",
        servers: [
          { id: "6", name: "de-fra-001" },
          { id: "7", name: "de-fra-002" },
        ],
      },
    ],
  },
  {
    id: "france",
    name: "France",
    cities: [
      {
        name: "Paris",
        servers: [
          { id: "8", name: "fr-par-001" },
          { id: "9", name: "fr-par-002" },
        ],
      },
    ],
  },
  {
    id: "united-kingdom",
    name: "United Kingdom",
    cities: [
      {
        name: "London",
        servers: [
          { id: "10", name: "uk-lon-001" },
          { id: "11", name: "uk-lon-002" },
          { id: "12", name: "uk-lon-003" },
        ],
      },
      {
        name: "Manchester",
        servers: [{ id: "13", name: "uk-man-001" }],
      },
    ],
  },
  {
    id: "united-states",
    name: "United States",
    cities: [
      {
        name: "New York",
        servers: [
          { id: "14", name: "us-nyc-001" },
          { id: "15", name: "us-nyc-002" },
        ],
      },
      {
        name: "Los Angeles",
        servers: [
          { id: "16", name: "us-lax-001" },
          { id: "17", name: "us-lax-002" },
        ],
      },
      {
        name: "Chicago",
        servers: [{ id: "18", name: "us-chi-001" }],
      },
    ],
  },
  {
    id: "japan",
    name: "Japan",
    cities: [
      {
        name: "Tokyo",
        servers: [
          { id: "19", name: "jp-tyo-001" },
          { id: "20", name: "jp-tyo-002" },
        ],
      },
      {
        name: "Osaka",
        servers: [{ id: "21", name: "jp-osk-001" }],
      },
    ],
  },
  {
    id: "canada",
    name: "Canada",
    cities: [
      {
        name: "Toronto",
        servers: [
          { id: "22", name: "ca-tor-001" },
          { id: "23", name: "ca-tor-002" },
        ],
      },
      {
        name: "Vancouver",
        servers: [{ id: "24", name: "ca-van-001" }],
      },
    ],
  },
  {
    id: "australia",
    name: "Australia",
    cities: [
      {
        name: "Sydney",
        servers: [
          { id: "25", name: "au-syd-001" },
          { id: "26", name: "au-syd-002" },
        ],
      },
      {
        name: "Melbourne",
        servers: [{ id: "27", name: "au-mel-001" }],
      },
    ],
  },
  {
    id: "netherlands",
    name: "Netherlands",
    cities: [
      {
        name: "Amsterdam",
        servers: [
          { id: "28", name: "nl-ams-001" },
          { id: "29", name: "nl-ams-002" },
        ],
      },
    ],
  },
  {
    id: "spain",
    name: "Spain",
    cities: [
      {
        name: "Madrid",
        servers: [{ id: "30", name: "es-mad-001" }],
      },
      {
        name: "Barcelona",
        servers: [
          { id: "31", name: "es-bcn-001" },
          { id: "32", name: "es-bcn-002" },
        ],
      },
    ],
  },
];

export const ChangeLocation: React.FC = () => {
  const navigate = useNavigate();
  const [expandedCountry, setExpandedCountry] = useState<string>("switzerland");
  const [searchTerm, setSearchTerm] = useState("");

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
        {filteredCountries.map((country) => (
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
                          className="py-4 flex items-center gap-2"
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

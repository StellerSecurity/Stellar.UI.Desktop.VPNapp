import type { Server } from './Server.ts';

export const SERVER_REGIONS = ['Europe', 'Asia', 'Africa', 'North America', 'South America', 'Oceania', 'Other locations'] as const;
export type ServerRegion = typeof SERVER_REGIONS[number];
const countries: readonly [ServerRegion, string][] = [
  ['Europe', 'AL AD AT AX BY BE BA BG HR CZ DK EE FO FI FR DE GI GR GG VA HU IS IE IM IT JE XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO SM RS SK SI ES SJ SE CH UA GB'],
  ['Asia', 'AF AM AZ BH BD BT BN KH CN CY GE HK IN ID IR IQ IL JP JO KZ KW KG LA LB MO MY MV MN MM NP KP OM PK PS PH QA SA SG KR LK SY TW TJ TH TL TM AE UZ VN YE'],
  ['Africa', 'DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW'],
  ['North America', 'AI AG AW BS BB BZ BM BQ CA KY CR CU CW DM DO SV GL GD GP GT HT HN JM MQ MX MS NI PA PR BL KN LC MF PM VC SX TT TC US VG VI'],
  ['South America', 'AR BO BR CL CO EC FK GF GY PY PE SR UY VE'],
  ['Oceania', 'AS AU CX CC CK FJ PF GU KI MH FM NR NC NZ NU NF MP PW PG PN WS SB TK TO TV UM VU WF'],
];
/** Transcontinental countries follow the actual VPN location, not a duplicated country row. */
export function serverRegion(server: Server): ServerRegion {
  if (server.countryCode === 'RU') return server.lon < 60 ? 'Europe' : 'Asia';
  if (server.countryCode === 'TR') return server.lon < 29 ? 'Europe' : 'Asia';
  return countries.find(([, codes]) => codes.split(' ').includes(server.countryCode))?.[0] ?? 'Other locations';
}
/** Preserve the caller's locale-aware ordering, omit empty groups, never discard unknown countries. */
export function groupServers(servers: readonly Server[]): { region: ServerRegion; servers: Server[] }[] {
  return SERVER_REGIONS.map(region => ({ region, servers: servers.filter(server => serverRegion(server) === region) }))
    .filter(group => group.servers.length > 0);
}

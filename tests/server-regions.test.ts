import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeServers, filterServers } from '../src/features/locations/domain/Server.ts';
import { groupServers, serverRegion } from '../src/features/locations/domain/ServerRegions.ts';
const servers = normalizeServers(JSON.parse(readFileSync(new URL('../assets/servers.json', import.meta.url), 'utf8')));
test('every bundled location appears exactly once in one of the six continent groups', () => {
  const groups = groupServers(filterServers(servers, '', null));
  assert.equal(groups.length, 6);
  assert.ok(!groups.some(group => group.region === 'Other locations'));
  const ids = groups.flatMap(group => group.servers.map(server => server.id));
  assert.equal(new Set(ids).size, servers.length); assert.equal(ids.length, servers.length);
  for (const group of groups) assert.deepEqual(group.servers, filterServers(group.servers, '', null));
  assert.equal(serverRegion(servers.find(server => server.id === 'no-1')!), 'Europe');
  assert.equal(serverRegion(servers.find(server => server.id === 'eg-1')!), 'Africa');
  assert.equal(serverRegion(servers.find(server => server.id === 'mx-1')!), 'North America');
  assert.equal(serverRegion(servers.find(server => server.id === 'tr-1')!), 'Europe');
});
test('search and favorites retain grouping without empty sections; unknown countries are never lost', () => {
  const favorites = groupServers(filterServers(servers, '', ['dk-1', 'jp-1']));
  assert.deepEqual(favorites.map(group => group.region), ['Europe', 'Asia']);
  assert.equal(groupServers(filterServers(servers, 'Sydney', null))[0].region, 'Oceania');
  assert.deepEqual(groupServers([]), []);
  const unknown = { ...servers[0], id: 'unknown-1', countryCode: 'ZZ' };
  assert.deepEqual(groupServers([unknown]), [{ region: 'Other locations', servers: [unknown] }]);
});

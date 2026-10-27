import raw from '../../../assets/servers.json';
import { normalizeServers, type ServerRepository } from '../../features/locations/domain/Server';
export class BundledServerRepository implements ServerRepository {
  async list() { return normalizeServers(raw); }
}

import { HttpServerRepository, type CatalogStorage } from './StagingServerRepository.ts';
export class ProductionServerRepository extends HttpServerRepository {
  constructor(request?: typeof fetch, storage?: CatalogStorage) { super(request, storage, 'production'); }
}

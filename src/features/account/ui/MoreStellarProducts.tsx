import { useApp } from '../../../app/AppProvider';
import { useTranslation } from '../../../shared/i18n/I18n';
import { stellarProducts } from '../domain/StellarProducts';

export function MoreStellarProducts() {
  const app = useApp(), t = useTranslation();
  return <section className="more-stellar-products" aria-labelledby="stellar-products-title">
    <h3 id="stellar-products-title">{t('More Stellar products')}</h3>
    <div>{stellarProducts.map(product => <a key={product.name} href={product.url} target="_blank" rel="noopener noreferrer"
      aria-label={`${product.name} — ${t('Opens in your browser')}`} onClick={event => { event.preventDefault(); app.openExternal(product.url); }}>
      <span>{product.name}</span><span aria-hidden="true">↗</span>
    </a>)}</div>
  </section>;
}

import { useTranslation } from '../i18n/I18n';
export function Loading({ label = 'Loading' }: { label?: string }) {
  const t = useTranslation();
  return <><span className="status-loader" aria-hidden="true" /><span className="sr-only">{t(label)}</span></>;
}

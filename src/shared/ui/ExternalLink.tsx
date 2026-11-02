import { useTranslation } from '../i18n/I18n';
import type { ReactNode } from 'react';
import { useApp } from '../../app/AppProvider';
export function ExternalLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const t = useTranslation();
  const app = useApp();
  return <a href={href} className={className} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); app.openExternal(href); }}>{t(children)}</a>;
}

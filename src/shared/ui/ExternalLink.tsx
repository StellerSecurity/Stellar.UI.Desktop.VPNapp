import type { ReactNode } from 'react';
import { useApp } from '../../app/AppProvider';
export function ExternalLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const app = useApp();
  return <a href={href} className={className} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); app.openExternal(href); }}>{children}</a>;
}

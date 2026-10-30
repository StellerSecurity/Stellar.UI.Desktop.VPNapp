// Static artwork is bundled by Vite. Never load a flag from the network in-app.
const files = import.meta.glob<string>('../../../assets/flags/*.png', { eager: true, query: '?url', import: 'default' });
const flags = Object.fromEntries(Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -4).toUpperCase(), url]));
export function CountryFlag({ code, className = '' }: { code: string; className?: string }) {
  const normalized = /^[a-z]{2}$/i.test(code) ? code.toUpperCase() : '';
  const source = flags[normalized];
  return <span className={className} aria-hidden="true">{source
    ? <img src={source} alt="" draggable={false} />
    : <span className="flag-code-fallback">{normalized || '—'}</span>}</span>;
}

import { useTranslation } from '../../../shared/i18n/I18n';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../../app/AppProvider';
import { Icon } from '../../../shared/ui/Icon';
import { languages as supportedLanguages, searchLanguages } from '../../../shared/i18n/languages';
const languages = supportedLanguages.map(language => [language.name, language.flag]);
export function LanguageSelector() {
  const app = useApp();
  return <LanguagePicker value={app.snapshot?.settings.language || 'English'} disabled={app.settingsPending} onChange={name => {
    if (app.snapshot) app.saveSettings({ ...app.snapshot.settings, language: name });
    app.notify('Language preference saved');
  }} />;
}
export function LanguagePicker({ value, onChange, disabled = false }: { value: string; onChange: (name: string) => void; disabled?: boolean }) {
  const t = useTranslation();
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false), [closing, setClosing] = useState(false);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const filtered = searchLanguages(query, name => t(name));
  function show() { clearTimeout(timer.current); setQuery(''); setClosing(false); setOpen(true); }
  function choose(name: string) {
    onChange(name); close(true);
  }
  function close(focus = false) {
    setClosing(true); clearTimeout(timer.current);
    timer.current = setTimeout(() => { setOpen(false); setClosing(false); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160);
    if (focus) trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    const listener = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', listener);
    search.current?.focus();
    root.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    return () => document.removeEventListener('pointerdown', listener);
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <div ref={root} className="selector" id="language-selector" onBlur={event => {
    // A null target is not evidence that focus moved outside. On WebKit a
    // pointer choice can blur the input without focusing the option first.
    // Outside pointer presses are handled separately, before this blur event.
    if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close();
  }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); return; }
    const inSearch = event.target === search.current;
    if (inSearch && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (filtered[0]) choose(filtered[0].name); return; }
    if (inSearch && ['Home', 'End'].includes(event.key)) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!open) { show(); return; }
    const options = [...root.current!.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowUp' && index === 0) { search.current?.focus(); return; }
    if (index < 0 && ['ArrowDown', 'ArrowUp'].includes(event.key)) { options[event.key === 'ArrowDown' ? 0 : options.length - 1]?.focus(); return; }
    options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
  }}>
    <button ref={trigger} id="language-trigger" disabled={disabled} className="selector-trigger" type="button" aria-label={t(`Language: ${value}`)} aria-haspopup="listbox" aria-controls="language-options" aria-expanded={open && !closing} onClick={() => { if (open && !closing) close(); else show(); }}><span>{t(value)}</span><span aria-hidden="true">{t(languages.find(([name]) => name === value)?.[1])}</span><i><Icon name="chevron" /></i></button>
    {open && <div className={`selector-popover language-popover ${closing ? 'is-closing' : ''}`} inert={closing}>
      <label className="language-search"><Icon name="search" /><input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search languages')} aria-label={t('Search languages')} aria-controls="language-options" autoComplete="off" spellCheck={false} /></label>
      <div id="language-options" className="language-options" role="listbox" aria-label={t('Language')}>{filtered.map(({ name, flag }) => <button type="button" key={name} role="option" aria-selected={name === value} onMouseDown={event => {
        // WebKit may blur the search field without focusing the clicked button.
        // Keep focus until click commits the choice, before blur makes it inert.
        // Do not select on pointerdown: touch users must still be able to scroll.
        event.preventDefault();
      }} onClick={() => choose(name)}><span>{t(name)}</span><small aria-hidden="true">{flag}</small></button>)}</div>
      {!filtered.length && <p className="language-empty" role="status">{t('No languages found')}</p>}
    </div>}
  </div>;
}

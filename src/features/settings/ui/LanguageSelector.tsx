import { useTranslation } from '../../../shared/i18n/I18n';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../../app/AppProvider';
import { Icon } from '../../../shared/ui/Icon';
import { languages as supportedLanguages } from '../../../shared/i18n/languages';
const languages = supportedLanguages.map(language => [language.name, language.flag]);
export function LanguageSelector() {
  const t = useTranslation();
  const app = useApp(), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false), [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const value = app.snapshot?.settings.language || 'English';
  function close(focus = false) {
    setClosing(true); clearTimeout(timer.current);
    timer.current = setTimeout(() => { setOpen(false); setClosing(false); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160);
    if (focus) trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    const listener = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', listener);
    root.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    return () => document.removeEventListener('pointerdown', listener);
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <div ref={root} className="selector" id="language-selector" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!open) { clearTimeout(timer.current); setClosing(false); setOpen(true); return; }
    const options = [...root.current!.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
  }}>
    <button ref={trigger} id="language-trigger" className="selector-trigger" type="button" aria-label={t(`Language: ${value}`)} aria-haspopup="listbox" aria-controls="language-options" aria-expanded={open && !closing} onClick={() => { if (open && !closing) close(); else { clearTimeout(timer.current); setClosing(false); setOpen(true); } }}><span>{t(value)}</span><span aria-hidden="true">{t(languages.find(([name]) => name === value)?.[1])}</span><i><Icon name="chevron" /></i></button>
    {t(open && <div id="language-options" className={`selector-popover ${closing ? 'is-closing' : ''}`} role="listbox" aria-label={t("Language")}>{t(languages.map(([name, flag]) => <button key={name} role="option" aria-selected={name === value} onClick={() => { if (app.snapshot) app.saveSettings({ ...app.snapshot.settings, language: name }); close(true); app.notify('Language preference saved'); }}><span>{t(name)}</span><small>{t(flag)}</small></button>))}</div>)}
  </div>;
}

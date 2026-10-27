import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
export function Dialog({ id, title, className = '', onClose, children }: { id: string; title: string; className?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [closing, setClosing] = useState(false), outside = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  function close() {
    if (closing) return;
    setClosing(true);
    timer.current = setTimeout(onClose, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160);
  }
  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => { clearTimeout(timer.current); if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); };
  }, []);
  function isOutside(x: number, y: number) { const box = ref.current!.getBoundingClientRect(); return x < box.left || x > box.right || y < box.top || y > box.bottom; }
  return <dialog ref={ref} id={`${id}-dialog`} className={`feature-dialog ${className} ${closing ? 'is-closing' : ''}`} aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); close(); }} onPointerDown={event => { outside.current = isOutside(event.clientX, event.clientY); }} onClick={event => {
    if (outside.current && isOutside(event.clientX, event.clientY)) close();
    if (event.target instanceof Element && event.target.closest('.close-dialog, .close-dialog-text')) close();
  }}><div className="dialog-header"><div><h2 id={`${id}-title`}>{title}</h2></div><button className="close-dialog" aria-label={`Close ${title}`}><Icon name="close" /></button></div>{children}</dialog>;
}

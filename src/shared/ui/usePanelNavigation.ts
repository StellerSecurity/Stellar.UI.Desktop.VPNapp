import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';

/** Native shared-element snapshots stay inside the webview, never on disk. */
export function usePanelNavigation<T>(current: T, commit: (next: T) => void) {
  const desired = useRef(current);
  const running = useRef<ViewTransition | null>(null);
  // A dialog close or snapshot refresh must not overwrite a queued destination.
  useEffect(() => { if (!running.current) desired.current = current; }, [current]);
  useEffect(() => () => running.current?.skipTransition(), []);
  return (next: T) => {
    if (next === desired.current) return;
    const crossesMap = (desired.current === 'connection') !== (next === 'connection');
    desired.current = next;
    running.current?.skipTransition();
    if (!crossesMap || matchMedia('(prefers-reduced-motion: reduce)').matches || !document.startViewTransition) {
      commit(next); return;
    }
    const transition = document.startViewTransition(() => {
      // Rapid navigation can supersede a queued snapshot before its callback.
      if (desired.current === next) flushSync(() => commit(next));
    });
    running.current = transition;
    void transition.finished.then(() => {
      if (running.current === transition) running.current = null;
    }, () => {});
  };
}

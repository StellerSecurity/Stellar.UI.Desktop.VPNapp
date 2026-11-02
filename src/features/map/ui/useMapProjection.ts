import { useLayoutEffect, useRef, useState } from 'react';

/** Keep one camera transition alive; a new intent reverses it instead of queuing. */
export function useMapProjection(globe: boolean) {
  const [displayed, setDisplayed] = useState(globe);
  const [phase, setPhase] = useState<'stable' | 'out' | 'in'>('stable');
  const [fromGlobe, setFromGlobe] = useState(globe);
  const target = useRef(globe); target.current = globe;
  useLayoutEffect(() => {
    if (globe === displayed && phase === 'stable') return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { setDisplayed(globe); setPhase('stable'); return; }
    if (phase === 'stable') setFromGlobe(displayed);
    setPhase(globe ? 'in' : 'out');
  }, [globe]);
  const complete = (result: boolean) => { if (result === target.current) { setDisplayed(result); setPhase('stable'); } };
  return { displayed, phase, fromGlobe, complete };
}

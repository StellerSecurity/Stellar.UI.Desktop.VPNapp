export const primaryViews = ['connection', 'settings', 'account'] as const;
export type PrimaryView = typeof primaryViews[number];

export function primaryViewForKey(current: PrimaryView, key: string): PrimaryView | null {
  const index = primaryViews.indexOf(current);
  if (key === 'Home') return primaryViews[0];
  if (key === 'End') return primaryViews[primaryViews.length - 1];
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  return primaryViews[(index + (key === 'ArrowRight' ? 1 : -1) + primaryViews.length) % primaryViews.length];
}

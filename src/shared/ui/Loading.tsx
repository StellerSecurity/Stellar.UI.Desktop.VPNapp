export function Loading({ label = 'Loading' }: { label?: string }) {
  return <><span className="status-loader" aria-hidden="true" /><span className="sr-only">{label}</span></>;
}

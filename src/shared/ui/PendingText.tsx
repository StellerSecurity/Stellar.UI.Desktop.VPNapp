import { useTranslation } from '../i18n/I18n';
/** Android-style 0–3 dots, with reserved space so the label never shifts. */
export function PendingText({ label }: { label: string }) {
  const t = useTranslation();
  return <span className="pending-text"><span className="sr-only">{t(label)}</span><span aria-hidden="true">{t(label)}<span className="pending-dots"><i>.</i><i>.</i><i>.</i></span></span></span>;
}

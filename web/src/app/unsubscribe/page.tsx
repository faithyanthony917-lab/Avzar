import { UnsubscribeClient } from '@/components/app/UnsubscribeClient';

export const metadata = { title: 'Stop messages · Avzar', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default function UnsubscribePage() {
  return <UnsubscribeClient />;
}

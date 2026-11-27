import type { Metadata } from 'next';
import { PaymentsView } from './PaymentsView';

export const metadata: Metadata = { title: 'Payments · Platform admin' };

export default function Page() {
  return <PaymentsView />;
}

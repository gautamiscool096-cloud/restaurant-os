import type { Metadata } from 'next';
import { PlansView } from './PlansView';

export const metadata: Metadata = { title: 'Plans · Platform admin' };

export default function Page() {
  return <PlansView />;
}

import type { Metadata } from 'next';
import { ActivityView } from './ActivityView';

export const metadata: Metadata = { title: 'Activity · Platform admin' };

export default function Page() {
  return <ActivityView />;
}

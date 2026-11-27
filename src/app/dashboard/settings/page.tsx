import type { Metadata } from 'next';
import { requireRole } from '@/lib/require-role';
import { SettingsForm } from './SettingsForm';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  await requireRole('owner', 'manager');
  return <SettingsForm />;
}

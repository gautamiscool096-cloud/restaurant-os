import type { Metadata } from 'next';
import { RestaurantsList } from './RestaurantsList';

export const metadata: Metadata = { title: 'Restaurants · Platform admin' };

export default function AdminHome() {
  return <RestaurantsList />;
}

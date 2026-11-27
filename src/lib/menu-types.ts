export type MenuItem = {
  id: string;
  name: string;
  description: string | null;
  price_minor: number;
  photo_url: string | null;
  is_veg: boolean;
  spice_level: 0 | 1 | 2 | 3;
  is_available: boolean;
};

export type PublicMenu = {
  restaurant: {
    slug: string;
    name: string;
    logo_url: string | null;
    brand_primary_color: string;
    brand_accent_color: string;
    currency: string;
    cuisine_type: string | null;
    address: string | null;
  };
  settings: {
    tax_percent: number;
    service_charge_percent: number;
    prices_include_tax: boolean;
    accepts_cash: boolean;
    accepts_online: boolean;
  };
  categories: { id: string; name: string; items: MenuItem[] }[];
};

export type OrderStatus = 'pending' | 'approved' | 'rejected' | 'preparing' | 'ready' | 'served' | 'cancelled';

export type SessionOrder = {
  order_id: string;
  order_number: number;
  status: OrderStatus;
  total_minor: number;
  is_paid: boolean;
  created_at: string;
  items: { name: string; quantity: number; unit_price_minor: number; status: string; special_instructions: string | null }[];
};

export const storageKeys = (slug: string, table: string) => ({
  cart: `ros:cart:${slug}:${table}`,
  session: `ros:session:${slug}:${table}`,
  reviewed: `ros:reviewed:${slug}:${table}`,
});

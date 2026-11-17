export const picoStarsMinimum = 1;
export const picoStarsMaximum = 10_000;

export interface PicoStarInvoice {
  id: string;
  url: string;
}

export interface PicoStarInvoiceStatus {
  amount: number;
  status: 'pending' | 'expired' | 'paid' | 'refunded';
  canCancel: boolean;
}

export interface PicoStarReceipt {
  id: string;
  amount: number;
  status: 'paid' | 'refunded';
}

export interface PicoStarInvoiceOverview {
  id: string | null;
  enabled: boolean;
  termsUrl: string | null;
  lastPayment: PicoStarReceipt | null;
}

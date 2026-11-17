export const picoStarsMinimum = 1;
export const picoStarsMaximum = 10_000;

export interface PicoStarInvoice {
  id: string;
  url: string;
}

export interface PicoStarInvoiceStatus {
  amount: number;
  status: 'pending' | 'expired' | 'paid' | 'refunded';
}

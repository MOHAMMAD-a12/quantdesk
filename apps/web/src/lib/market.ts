import type { AssetClass } from '@quantdesk/shared';

export const assetClassLabel: Record<AssetClass, string> = {
  crypto: 'Crypto',
  forex: 'Forex',
  stock: 'Stocks',
  index: 'Indices',
  commodity: 'Commodities',
};

export function symbolDisplay(symbol: string): string {
  if (symbol.endsWith('USDT')) return `${symbol.slice(0, -4)} / USDT`;
  if (symbol.endsWith('USD') && symbol.length > 3) return `${symbol.slice(0, -3)} / USD`;
  return symbol;
}

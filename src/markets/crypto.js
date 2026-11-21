// Crypto market adapter: Binance public market data (engine/candles.js),
// prices in USDT converted to IDR with the live USD/IDR rate, 24/7 trading,
// BTC as the regime symbol. The crypto engine config comes from the stored
// settings and the autopilot (settings.js engineCfgFromSettings).
import { loadLiveSeries } from '../engine/candles.js';
import { BTC_SYMBOL } from '../engine/config.js';

export const CRYPTO_NAMES = {
  BTCUSDT: ['Bitcoin', 'BTC'], ETHUSDT: ['Ethereum', 'Ether', 'ETH'], BNBUSDT: ['BNB', 'Binance Coin'], SOLUSDT: ['Solana', 'SOL'],
  XRPUSDT: ['XRP', 'Ripple'], ADAUSDT: ['Cardano', 'ADA'], DOGEUSDT: ['Dogecoin', 'DOGE'], AVAXUSDT: ['Avalanche', 'AVAX'],
  TRXUSDT: ['Tron', 'TRX'], NEARUSDT: ['NEAR Protocol', 'NEAR'], ZECUSDT: ['Zcash', 'ZEC'], PEPEUSDT: ['PEPE'],
  SUIUSDT: ['SUI'], FETUSDT: ['Fetch.ai', 'FET'], ENAUSDT: ['Ethena', 'ENA'], AAVEUSDT: ['Aave', 'AAVE'],
  LINKUSDT: ['Chainlink', 'LINK'], DOTUSDT: ['Polkadot'], LTCUSDT: ['Litecoin', 'LTC'], TONUSDT: ['Toncoin'],
  ATOMUSDT: ['Cosmos', 'ATOM'], APTUSDT: ['Aptos', 'APT'], INJUSDT: ['Injective'], SHIBUSDT: ['Shiba Inu', 'SHIB']
};

export const cryptoMarket = {
  key: 'crypto',
  label: 'Crypto',
  quoteCurrency: 'USDT',
  regimeSymbol: BTC_SYMBOL,
  loadSeries: (symbols, opts) => loadLiveSeries(symbols, opts)
};

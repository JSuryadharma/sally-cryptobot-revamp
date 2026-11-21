# Revamp strategi dengan day-trader-skill (21 Nov 2026)

Joe minta strategi robot di-revamp dengan day-trader-skill dan dibandingkan win rate-nya lewat backtest. Semua simulasi dijalankan di cloud.

## Kesimpulan

1. **Setup entry dari skill tidak lebih akurat dari breakout robot.** Bull flag, reclaim SMA20, oversold, dan oversold bounce menang di periode train, tapi semuanya rugi di periode test, baik di crypto maupun saham. Yang bertahan hanya breakout20 dari skill, yang pada dasarnya aturan yang sama dengan robot.
2. **Yang terbukti membantu dari skill adalah risk manager-nya (pre-trade gate).** Di crypto, gate ini menaikkan hasil 3 tahun dari +143% menjadi +172% dan menurunkan drawdown dari 21,3% menjadi 15,9%. Di 14 bulan terakhir hasilnya sama. Sekarang gate ini aktif untuk crypto.
3. **Aturan saham IDX diganti** dari breakout 20 hari (stop 2,5 ATR) ke breakout 55 hari (stop 3 ATR, target +2R). Dalam 4 tahun, aturan lama rugi 13,5% dengan win rate 40%. Aturan baru untung 14,6% dengan win rate 49%.

## Data

- Crypto: candle 1 menit Binance spot dari mirror publik di GitHub (`parshant231234-eng/<SYM>-Historical-Data`), digabung menjadi 5m/15m/1h/4h/1d. Datanya untuk 16 koin watchlist, dari Juni 2022 sampai 14 Nov 2026. Sudah dicek ke harga yang diketahui: BTC close 1 Jan 2025 = 94.591,79, dan BTC sekitar 82,5k pada 9 Okt 2026. Backtest robot dengan data ini juga mengulang angka sebelumnya persis (+143,4%, DD 21,3%).
- Saham: dataset BEI `wildangunawan/Dataset-Saham-IDX` (CC BY-NC) untuk 16 saham watchlist, Juli 2019 sampai 21 Feb 2025, dengan penyesuaian split dan right issue dari kolom harga acuan (`previous`). IHSG tidak tersedia, jadi filter regime memakai indeks equal-weight dari 16 saham itu sebagai proksi. Data Yahoo yang lebih baru tidak bisa diakses dari cloud.

## 1. Setup skill vs breakout robot (level sinyal)

Cara uji: beli di close hari sinyal, keluar di stop, target, atau batas waktu, dengan biaya dihitung dalam R. Target tiap aturan dipilih di periode train lalu dinilai di periode test. Isi tabel: jumlah trade, win rate, rata-rata R per trade.

### Crypto (16 koin, Des 2023 s/d Nov 2026, test mulai 9 Sep 2025, biaya 0,3%)

| Aturan | Train | Test |
|---|---|---|
| Robot 20 hari + BTC>200d, 3 ATR, +3R | 184 · 53% · +0,52R | 45 · 44% · **+0,52R** |
| Robot 55 hari + BTC>200d, 3 ATR, +3R | 125 · 53% · +0,64R | 35 · 43% · **+0,47R** |
| Skill breakout20 + regime, 2 ATR | 309 · 44% · +0,23R | 80 · 44% · +0,48R |
| Skill konfluensi 2 setup + regime | 75 · 41% · +0,01R | 21 · 52% · +0,35R |
| Skill reclaim SMA20 + regime | 305 · 38% · −0,02R | 71 · 41% · +0,21R |
| Skill bull flag | 160 · 38% · +0,02R | 76 · 28% · −0,28R |
| Skill oversold bounce | 68 · 57% · +0,19R | 86 · 37% · −0,24R |
| Skill oversold (RSI<30) | 69 · 51% · +0,12R | 96 · 39% · −0,27R |

### Saham IDX (16 saham, Mar 2021 s/d Feb 2025, test mulai 27 Jul 2023, biaya 0,4%)

| Aturan | Train | Test |
|---|---|---|
| Robot 55 hari + regime, 3 ATR, +3R | 96 · 52% · +0,19R | 34 · 59% · **+0,24R** |
| Robot 20 hari + regime, 3 ATR, +3R | 148 · 49% · +0,21R | 55 · 55% · +0,11R |
| Skill reclaim SMA20 + regime | 334 · 47% · −0,01R | 110 · 45% · +0,01R |
| Skill breakout20 + regime | 320 · 50% · −0,04R | 130 · 51% · −0,04R |
| Skill oversold bounce | 70 · 59% · +0,27R | 56 · 41% · −0,16R |
| Skill bull flag | 120 · 47% · −0,10R | 52 · 48% · −0,08R |

Win rate tertinggi di train (oversold bounce, 57-59%) justru turun ke 37-41% di test. Ini tanda aturannya cocok dengan masa lalu saja, bukan punya edge. Hybrid (breakout robot plus setup skill di hari yang sama) terlalu jarang muncul (2-7 trade di test) untuk bisa dinilai.

Tabel lengkap ada di `skill-research-crypto-2026-11-15.md` dan `skill-research-idx-2025-02-22.md`.

## 2. Engine penuh: crypto dengan dan tanpa gate risiko skill

Robot live (autopilot 55/20 hari, beli di break live, gap rebound 0,5%) dengan modal Rp10 juta, biaya 0,2% plus slippage 0,05%. Dijalankan dengan `scripts/skillEngineBacktest.mjs`.

| Periode | Varian | Return | Max DD | Trade | Win | R/trade | PF |
|---|---|---|---|---|---|---|---|
| 3 tahun | Robot lama | +143,4% | 21,3% | 203 | 52% | 0,33 | 1,74 |
| 3 tahun | **+ gate skill (dipakai)** | **+172,1%** | **15,9%** | 184 | 52% | 0,35 | 2,03 |
| 3 tahun | + gate skill tanpa aturan R:R | +130,9% | 22,9% | 197 | 51% | 0,29 | 1,72 |
| 3 tahun | + gate skill ketat | +182,5% | 17,3% | 102 | 57% | 0,65 | 2,44 |
| Test (14 bln) | Robot lama | +33,8% | 12,3% | 78 | 50% | 0,29 | 1,82 |
| Test (14 bln) | **+ gate skill (dipakai)** | +33,9% | 12,1% | 73 | 47% | 0,25 | 1,97 |
| Test (14 bln) | + gate skill ketat | +33,7% | 12,3% | 30 | 47% | 0,49 | 2,42 |

Gate skill berisi 5 aturan:
- reward:risk setelah biaya minimal 1
- risiko per trade maksimal 2,5% equity
- risiko baru per hari maksimal 6%
- maksimal 3 pembelian per hari
- sisa kas minimal 10%

Hampir semua keuntungannya datang dari aturan reward:risk. Aturan ini menolak breakout 20 hari dengan target +1R, karena setelah biaya rasionya di bawah 1. Jadi dalam praktiknya robot crypto sekarang hanya memakai breakout 55 hari (+3R) dan gap rebound. Versi ketat menaikkan win rate ke 57%, tapi jumlah trade-nya terlalu sedikit di periode test (30). Karena itu saya memakai versi standar.

## 3. Engine penuh: grid aturan IDX

`scripts/idxBacktest.mjs`, 4 tahun sampai 21 Feb 2025, gate skill aktif:

| Aturan | Trade | Win | R/trade | Return | Max DD |
|---|---|---|---|---|---|
| 20 hari, 2,5 ATR, +2R (lama) | 103 | 40% | −0,06 | −13,5% | 18,4% |
| 20 hari, 3 ATR, +2R | 100 | 45% | 0,00 | −2,4% | 17,2% |
| **55 hari, 3 ATR, +2R (baru)** | 82 | 49% | +0,12 | **+14,6%** | 20,6% |
| 55 hari, 3 ATR, +3R | 75 | 48% | +0,07 | +3,8% | 22,7% |

Di 2 tahun terakhir data, aturan baru menghasilkan 24 trade, win rate 75%, +28,9%, DD 2,7%. Artinya di 2 tahun pertama aturan ini sempat rugi. Gate skill juga membantu di IDX: +14,6% dibanding +10,4% tanpa gate untuk aturan baru, dan −13,5% dibanding −16,8% untuk aturan lama.

## Catatan

- Data saham berhenti di Februari 2025. Filter IHSG memakai proksi. Backtest sebaiknya diulang dengan data Yahoo di server atau Mac: `node scripts/idxBacktest.mjs --years 4`.
- Untuk crypto, 14 bulan terakhir tidak berubah dengan gate. Bukti perbaikannya datang dari periode sebelumnya.
- Mengulang riset di cloud: buat folder `KLINES_DIR` dan `IDX_DATA_DIR` dari mirror di atas, lalu jalankan `scripts/skillResearch.mjs`, `scripts/skillEngineBacktest.mjs`, dan `scripts/idxBacktest.mjs`.

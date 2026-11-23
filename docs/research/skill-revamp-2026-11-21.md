# Revamp strategi dengan day-trader-skill (21 Nov 2026)

Joe minta strategi robot di-revamp dengan day-trader-skill dan dibandingkan win rate-nya lewat backtest. Semua simulasi dijalankan di cloud.

## Kesimpulan

1. **Setup entry dari skill tidak lebih akurat dari breakout robot.** Bull flag, reclaim SMA20, oversold, dan oversold bounce menang di periode train, tapi semuanya rugi di periode test, baik di crypto maupun saham. Yang bertahan hanya breakout20 dari skill, yang pada dasarnya aturan yang sama dengan robot.
2. **Yang terbukti membantu dari skill adalah risk manager-nya (pre-trade gate).** Di crypto, gate ini menaikkan hasil 3 tahun dari +143% menjadi +172% dan menurunkan drawdown dari 21,3% menjadi 15,9%. Di 14 bulan terakhir hasilnya sama. Sekarang gate ini aktif untuk crypto.
3. **Aturan saham IDX diganti** dari breakout 20 hari (stop 2,5 ATR) ke breakout 55 hari (stop 3 ATR, target +2R). Aturan baru lebih baik di data BEI 2021-2025 (+5,0% vs −4,2%) dan di 2 tahun terakhir sampai Nov 2026 (+2,1% vs −1,6%). Dalam 11 tahun, breakout 20 hari menghasilkan lebih banyak (+86% vs +69%) dengan drawdown yang mirip (lihat bagian 4).
4. **Satu integrasi skill yang menjanjikan untuk saham:** breakout 55 hari yang juga dikonfirmasi minimal 2 setup scanner skill. Dalam 11 tahun hasilnya +65%, dengan drawdown hanya 11,9% (dibanding 25,7%) dan R per trade 0,53 (dibanding 0,13). Kekurangannya, trade-nya jarang: sekitar 6 per tahun.

## Data

- Crypto: candle 1 menit Binance spot dari mirror publik di GitHub (`parshant231234-eng/<SYM>-Historical-Data`), digabung menjadi 5m/15m/1h/4h/1d. Datanya untuk 16 koin watchlist, dari Juni 2022 sampai 14 Nov 2026. Sudah dicek ke harga yang diketahui: BTC close 1 Jan 2025 = 94.591,79, dan BTC sekitar 82,5k pada 9 Okt 2026. Backtest robot dengan data ini juga mengulang angka sebelumnya persis (+143,4%, DD 21,3%).
- Saham A: dataset BEI `wildangunawan/Dataset-Saham-IDX` (CC BY-NC) untuk 16 saham watchlist, OHLC Juli 2019 sampai 21 Feb 2025, dengan penyesuaian split dan right issue dari kolom harga acuan (`previous`).
- Saham B (sampai 2026): `Faridfarid/idx-market-data`, harga penutupan harian dari Yahoo, sudah disesuaikan dividen dan aksi korporasi. Isinya 14 saham (ADRO, ANTM, ASII, AUTO, BRIS, INDF, IPCC, PGAS, POWR, SIDO, TLKM, TOTL, TOTO, UNTR) dari 2010 sampai 19 Nov 2026, plus IHSG asli. Data ini hanya punya harga penutupan, jadi stop dan ATR dihitung dari close. Sudah dicek: harga TLKM cocok dengan dataset BEI dan dengan `SeedFlora/idx-daily-data`.
- IHSG asli dari sumber B dipakai sebagai filter regime di kedua dataset. Versi awal laporan ini masih memakai proksi equal-weight.

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

### Saham IDX, dataset A (16 saham, Mar 2021 s/d Feb 2025, test mulai 27 Jul 2023, biaya 0,4%, IHSG asli)

| Aturan | Train | Test |
|---|---|---|
| Robot 55 hari + regime, 3 ATR, +3R | 81 · 54% · +0,32R | 46 · 61% · **+0,29R** |
| Robot 20 hari + regime, 3 ATR, +3R | 127 · 52% · +0,29R | 84 · 49% · +0,05R |
| Skill reclaim SMA20 + regime | 275 · 41% · −0,01R | 188 · 35% · −0,05R |
| Skill breakout20 + regime | 219 · 44% · +0,03R | 153 · 36% · −0,22R |
| Skill oversold bounce | 70 · 59% · +0,27R | 56 · 41% · −0,16R |
| Skill bull flag | 120 · 47% · −0,10R | 52 · 48% · −0,08R |
| Hybrid 55 hari + ≥2 setup skill | 11 · 45% · +0,07R | 6 · 50% · −0,19R |

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

## 3. Saham sampai 2026 (level sinyal, dataset B)

14 saham, Jan 2015 sampai Nov 2026, test mulai 1 Jan 2024 (mencakup penurunan IHSG dari 8.748 di Jan 2026 ke sekitar 5.190 di Nov 2026). Isi tabel: trade, win rate, R per trade.

| Aturan | Train | Test |
|---|---|---|
| Hybrid: breakout 55 hari + ≥2 setup skill, 3 ATR, +3R | 60 · 40% · +0,46R | 24 · 46% · **+0,35R** |
| Skill bull flag, 2 ATR, +3R | 355 · 40% · +0,14R | 109 · 48% · +0,22R |
| Robot 20 hari + regime, 3 ATR, +3R | 495 · 38% · +0,14R | 167 · 39% · +0,10R |
| Robot 55 hari + regime, 3 ATR, +3R | 300 · 40% · +0,26R | 131 · 43% · +0,09R |
| Skill reclaim SMA20 + regime | 864 · 34% · −0,25R | 223 · 42% · +0,10R |
| Skill breakout20 + regime | 728 · 42% · −0,04R | 248 · 44% · −0,01R |
| Skill oversold bounce | 375 · 43% · −0,05R | 85 · 41% · −0,29R |
| Skill oversold + regime | 190 · 47% · −0,18R | 26 · 50% · −0,30R |

Di dataset ini bull flag dari skill positif di kedua periode, tapi di dataset A (OHLC) bull flag rugi. Hybrid positif di semua target, baik train maupun test. Tabel lengkap ada di `skill-research-idx-farid-2026-11-20.md`.

## 4. Engine penuh: aturan IDX di tiga periode

`scripts/idxBacktest.mjs` dengan gate skill aktif, max 4 posisi, lot 100, biaya 0,4%.

| Aturan | BEI 2021-02..2025-02 (16 saham, OHLC) | 14 saham 2015..2026-11 (11 tahun) | 14 saham 2024-11..2026-11 (2 tahun) |
|---|---|---|---|
| 20 hari, 2,5 ATR, +2R (lama) | 46 tr · 39% · −4,2% · DD 12,0% | 356 tr · 42% · +86,2% · DD 26,6% | 47 tr · 40% · −1,6% · DD 10,4% |
| **55 hari, 3 ATR, +2R (baru)** | 38 tr · 45% · **+5,0%** · DD 6,9% | 263 tr · 45% · +68,7% · DD 25,7% | 39 tr · 49% · **+2,1%** · DD 8,7% |
| 55 hari, 3 ATR, +3R | 33 tr · 48% · +9,6% · DD 7,7% | 221 tr · 43% · +54,6% · DD 23,0% | 33 tr · 48% · +8,2% · DD 7,1% |
| 55 hari + ≥2 setup skill, +2R | 6 tr · 50% · +2,0% · DD 1,7% | 67 tr · 48% · +42,4% · DD 13,0% | 8 tr · 63% · +6,4% · DD 3,3% |
| 55 hari + ≥2 setup skill, +3R | 6 tr · 50% · +0,2% · DD 1,7% | 66 tr · 45% · +65,4% · **DD 11,9%** | 8 tr · 63% · +7,2% · DD 3,3% |

Isi sel: trade, win rate, return, max drawdown. Efek gate skill di IDX tidak konsisten. Di 2 tahun terakhir dan di data BEI gate membantu, tapi selama 11 tahun return tanpa gate lebih tinggi (+88% vs +69% untuk aturan baru). Gate tetap aktif karena drawdown-nya mirip dan periode terbaru lebih baik dengan gate.

## Catatan

- Data OHLC saham hanya sampai Februari 2025. Data sampai 2026 hanya berisi harga penutupan dan 14 saham, dan hanya 7 di antaranya ada di watchlist robot. Backtest sebaiknya diulang dengan data Yahoo lengkap di server atau Mac: `node scripts/idxBacktest.mjs --years 4`.
- Untuk crypto, 14 bulan terakhir tidak berubah dengan gate. Bukti perbaikannya datang dari periode sebelumnya.
- Mengulang riset di cloud: buat folder `KLINES_DIR` dan `IDX_DATA_DIR` dari mirror di atas, lalu jalankan `scripts/skillResearch.mjs`, `scripts/skillEngineBacktest.mjs`, dan `scripts/idxBacktest.mjs`.

# Time travel: strategi alternatif vs robot, jendela 3 bulan (21 Nov 2026)

Joe minta strategi alternatif yang lebih sering trading dan lebih besar profitnya, diuji dengan metode time machine dari day-trader-skill dalam jendela trading 3 bulan.

## Cara uji

- **Replay (time travel):** mulai trading di setiap hari Senin dalam histori, trading selama 91 hari, lalu catat profit jendela itu. Untuk crypto ada 142 jendela (Des 2023 s/d Nov 2026), untuk saham 245 jendela (Nov 2021 s/d Nov 2026).
- **Bootstrap (cara time machine skill):** ambil trade acak dari histori strategi itu sendiri, sebanyak rata-rata jumlah trade dalam 3 bulan, lalu ulangi 2.000 kali.
- **Aturan portofolio sama untuk semua strategi:** risiko 2% equity per trade, maksimal 6 posisi, maksimal sepertiga equity per posisi, dan biaya pulang-pergi 0,25% untuk crypto atau 0,4% untuk saham.
- Baris "Robot sekarang" untuk crypto adalah engine asli (autopilot, beli di break live, gap rebound, gate skill). Strategi lain memakai simulator sederhana yang sama. Sebagai pembanding, versi robot di simulator sederhana menghasilkan +209%, sedangkan engine asli +172%. Jadi simulator sedikit lebih optimis.
- Data crypto dari mirror Binance 1 menit (16 koin, sampai 14 Nov 2026). Data saham berupa harga penutupan 14 saham dan IHSG asli (sampai 19 Nov 2026, close saja).

## Crypto (16 koin, 36 bulan)

| Strategi | Rata-rata profit 3 bln | Median | % jendela untung | Terburuk | Trade / 3 bln | Win rate | Per tahun | 3 bln terakhir | Bootstrap: median · P(untung) |
|---|---|---|---|---|---|---|---|---|---|
| **Robot sekarang** (engine asli, gate skill) | +9.4% | +3% | 73% | -9.9% | 15.4 | 52% | 101.6 / 12.3 / 20.2 | +23.5% | 9.6% · 81% |
| Robot sebelum gate skill | +8.4% | +3.6% | 64% | -14.7% | 17.1 | 52% | 87.2 / 9.8 / 18.4 | +20.4% | 11.3% · 84% |
| Robot disederhanakan: breakout 55 hari, +3R | +10.8% | +2.2% | 54% | -11.9% | 8.5 | 55% | 106.8 / 19.3 / 25.2 | +25.2% | 11% · 87% |
| **Breakout 20 hari, keluar saat tembus low 10 hari (tanpa target)** | +18.7% | +2.5% | 57% | -23.2% | 8.7 | 45% | 89.5 / 96.5 / 23.8 | +23.8% | 8% · 71% |
| RSI(2) dip harian dalam uptrend | -0.6% | -0.3% | 46% | -20.5% | 26.6 | 60% | -7.2 / 5.1 / -4.4 | +1.5% | -0.1% · 48% |
| Bull flag skill (harian) | -2.7% | -2.9% | 42% | -28.9% | 16.7 | 38% | -18.3 / -8.5 / -17.5 | -1.8% | -2.5% · 39% |
| Rotasi momentum mingguan (top 3) | +42.5% | +1.3% | 51% | -48.7% | 9 | 43% | 145.6 / 309.7 / -6.4 | +1.5% | 6.7% · 59% |
| Breakout 4 jam (high 5 hari) | +10.7% | +0% | 44% | -21.7% | 50.8 | 41% | 74.3 / 33.9 / -12 | -12% | 7.9% · 64% |
| Day trade 1 jam (break high 24 jam + volume 2x) | -4.7% | +0% | 32% | -38.3% | 146.2 | 37% | -41.9 / -3.6 / -19.2 | -19.2% | -26.6% · 17% |
| RSI(2) dip 4 jam | -7.1% | -8.7% | 20% | -23.2% | 125.4 | 58% | 3.2 / -41.6 / -31.4 | -11% | -13.7% · 8% |
| Tren 4 jam: EMA9 x EMA21 | +23.5% | +0% | 49% | -24.2% | 36.7 | 28% | 312.7 / 40.5 / 2.7 | +2.7% | 19.3% · 76% |

"Per tahun" adalah return di tahun 1, 2, dan 3 secara berurutan (Des 2023 sampai Nov 2026).

**Dicek ulang dengan engine asli** (profil baru `breakoutTrail`, beli di break live, plus gap rebound):

| Strategi | Rata-rata 3 bln | Median | % jendela untung | Terburuk | Trade / 3 bln | Win | Per tahun | 3 bln terakhir | Total |
|---|---|---|---|---|---|---|---|---|---|
| Robot sekarang | +9,4% | +3,0% | 73% | −9,9% | 15,4 | 52% | 101,6 / 12,3 / 20,2 | +23,5% | +172% |
| Breakout 20 hari, exit low 10 hari (engine) | +15,1% | +5,2% | 64% | −22,2% | 15,0 | 45% | 101,3 / 64,2 / 5,8 | +8,6% | +250% |
| Sama, tapi beli di close harian | +13,2% | +4,6% | 64% | −22,7% | 16,1 | 46% | 63,3 / 74,5 / 13,8 | +16,9% | +224% |

Di engine asli, keunggulan exit trailing lebih kecil daripada di simulator sederhana. Totalnya +250% vs +172%, dan rata-rata 3 bulannya +15,1% vs +9,4%. Tapi di tahun terakhir hasilnya kalah dari robot sekarang (+5,8% vs +20,2%), dan kerugian 3 bulan terburuknya dua kali lebih dalam.

## Saham IDX (14 saham, 60 bulan)

| Strategi | Rata-rata profit 3 bln | Median | % jendela untung | Terburuk | Trade / 3 bln | Win rate | Per tahun | 3 bln terakhir | Bootstrap: median · P(untung) |
|---|---|---|---|---|---|---|---|---|---|
| **Robot sekarang**: breakout 55 hari, 3 ATR, +2R | +2.4% | +1.4% | 55% | -14.6% | 8.3 | 46% | 15.9 / 4.6 / 34.8 / 7.8 / -10.1 | +0% | 2.1% · 59% |
| **Breakout 20 hari, keluar saat tembus low 10 hari (tanpa target)** | +0.4% | +0% | 39% | -16.8% | 7.5 | 28% | -0.9 / 17.2 / 10.6 / -13 / -6.2 | +0% | -2.3% · 44% |
| RSI(2) dip harian dalam uptrend | +2.1% | +2.2% | 67% | -11.6% | 21.7 | 68% | -7.1 / -4.8 / 34.2 / 11.8 / 9.5 | +3.9% | 2.8% · 65% |
| Bull flag skill (harian) | +2.4% | +0.4% | 55% | -12.1% | 8.9 | 46% | 12.2 / 20.8 / -0.1 / 17.8 / -7.5 | +0.3% | 2.1% · 57% |
| Rotasi momentum mingguan (top 3) | +1% | +0% | 43% | -21.5% | 7.6 | 40% | -6.1 / -0.5 / 19.9 / 4.5 / -0.1 | +0% | -0.2% · 49% |

"Per tahun" adalah return di tahun 1 sampai 5 (Nov 2021 sampai Nov 2026). Tahun 5 mencakup penurunan IHSG dari 8.748 ke sekitar 5.190.

## Yang terlihat

1. **Strategi yang lebih sering trading justru rugi.** Day trade 1 jam (146 trade per 3 bulan) rugi 55%. RSI(2) dip 4 jam (125 trade) rugi 59%. Bull flag skill rugi 38%. Biaya dan sinyal palsu memakan profitnya.
2. **Robot sekarang paling konsisten.** 73% jendela 3 bulan untung, dengan kerugian terburuk −9,9%. Tapi rata-rata profitnya (+9,4% per 3 bulan) tertahan oleh target tetap +3R.
3. **Breakout 20 hari dengan exit trailing (keluar saat harga tembus low 10 hari)** memberi rata-rata profit 3 bulan dua kali lipat (+18,7%) dan untung di ketiga tahun (+90%, +97%, +24%). Total +361% dibanding robot +172%. Harganya: jendela terburuk −23% dan hanya 57% jendela yang untung. Pemenangnya dibiarkan berjalan, bukan dijual di +3R.
4. **Tren 4 jam (EMA9 x EMA21)** paling tinggi rata-ratanya (+23,5%, 37 trade per 3 bulan). Tapi hampir semua profitnya dari tahun pertama (+313%, lalu +41% dan +3%), dan hanya 49% jendela yang untung.
5. **Rotasi momentum** totalnya +842%, tapi terlalu liar: jendela terburuk −49%, dan tahun ketiga −6%.
6. **Saham:** RSI(2) dip harian paling konsisten. 67% jendela untung, 22 trade per 3 bulan, win rate 68%, dan tetap untung di tahun crash 2026 (+9,5%). Breakout 55 hari robot menghasilkan total lebih besar (+58% vs +45%), tapi rugi 10% di tahun terakhir.

Catatan: semua ini simulasi atas data historis. Exit trailing pernah dimatikan atas permintaan Joe pada 5 Okt 2026 (ganti ke target tetap). Kalau dipakai lagi, aturannya berbeda: keluar di low 10 hari, bukan trailing berbasis ATR.

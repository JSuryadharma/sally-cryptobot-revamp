# Panduan trading nyata: Binance API dan Ajaib

Robot tetap menghitung semuanya di akun paper. Modul `src/brokers/` menyalin keputusan robot ke akun nyata:

- **Crypto → Binance Spot API.** Setiap kali robot membuka posisi paper baru, robot membeli koin yang sama di Binance dengan market order. Saat posisi paper ditutup (kena stop, target, batas 30 hari, jual manual, atau reset), robot menjual persis jumlah koin yang dibeli tadi.
- **Saham IDX → Ajaib.** Ajaib tidak punya API publik untuk order saham. API yang mereka punya hanya Ajaib Coin Exchange (crypto), dan aksesnya lewat permintaan email ke Ajaib. Karena itu robot mengirim **tiket order** lewat notifikasi dan Telegram, misalnya "BELI BBCA 3 lot, harga sekitar Rp 9.150, stop Rp 8.700". Anda memasang order itu sendiri di aplikasi Ajaib.

Semua bagian ini **mati secara default**. Order nyata baru terkirim kalau server sudah disetel (langkah 2) **dan** saklar di Settings dinyalakan (langkah 4).

## 1. Buat API key Binance

Mulai dari **testnet** (uang mainan) dulu, baru live setelah yakin.

**Testnet**
1. Buka https://testnet.binance.vision lalu login dengan GitHub.
2. Klik "Generate HMAC_SHA256 Key", beri nama, lalu simpan API Key dan Secret Key. Secret hanya muncul sekali.
3. Akun testnet otomatis berisi saldo mainan (USDT, BTC, dan lainnya).

**Live**
1. Di Binance: Profile → API Management → Create API → System generated.
2. Izin yang dicentang **hanya "Enable Spot & Margin Trading"**. Jangan pernah centang "Enable Withdrawals".
3. Pilih "Restrict access to trusted IPs only" dan isi IP server tempat robot berjalan. Binance mewajibkan ini untuk key dengan izin trading.
4. Isi akun Spot dengan USDT sebanyak modal yang mau dipakai robot.

Catatan: Binance memblokir API dari beberapa negara, termasuk server yang berlokasi di Amerika Serikat (error 451). Pastikan server Anda di lokasi yang diizinkan, misalnya Singapura atau Jakarta.

## 2. Isi pengaturan di server

Di server (Docker, lihat `docs/DEPLOY-SERVER.md`), buka `deploy/.env` lalu tambahkan:

```
BROKER_CRYPTO=binance-testnet        # nanti diganti binance-live
BINANCE_API_KEY=isi_api_key
BINANCE_API_SECRET=isi_secret_key
BROKER_MAX_ORDER_USDT=50             # batas keras per pembelian, dalam USDT
BROKER_SCALE=1                       # ukuran nyata = ukuran paper x angka ini
```

Lalu jalankan ulang aplikasinya: `cd deploy && docker compose up -d`.

Key ini hanya ada di server dan tidak pernah tampil di halaman web. Halaman web juga tidak bisa mengubah mode testnet/live.

### Mengatur ukuran order

Robot menentukan ukuran posisi dari akun paper (modal Rp 20 juta, sekitar 1.250 USDT). Ukuran order nyata dihitung begini:

`USDT per beli = min(uang paper posisi itu × BROKER_SCALE, BROKER_MAX_ORDER_USDT, 98% USDT bebas di Binance)`

Contoh: modal Binance Anda 300 USDT, sedangkan modal paper sekitar 1.250 USDT. Pakai `BROKER_SCALE=0.24` supaya proporsinya sama. Naikkan `BROKER_MAX_ORDER_USDT` sampai di atas ukuran posisi terbesar (sekitar 30% modal, jadi kira-kira 100 USDT untuk modal 300 USDT).

Binance punya minimum order sekitar 5 USDT per transaksi. Pembelian di bawah itu akan dilewati dan dicatat di log.

## 3. Tes koneksi

Buka **Settings → Real trading** lalu tekan **Test Binance connection**. Robot membaca saldo USDT dan mengirim order uji ke Binance (`/api/v3/order/test`). Order uji tidak membeli apa pun. Kalau berhasil, muncul tulisan "Connected to Binance testnet. Free USDT ...".

Error yang sering muncul:
- `-2015 Invalid API-key, IP, or permissions`: IP server belum didaftarkan atau izin Spot belum dicentang.
- `-1021 Timestamp outside of recvWindow`: jam server tidak sinkron. Aktifkan NTP (`timedatectl set-ntp true`).
- `451`: lokasi server diblokir Binance.

## 4. Nyalakan

- **Copy crypto buys to Binance**: mulai sekarang setiap pembelian baru robot juga dibeli di Binance. Posisi paper yang sudah terbuka sebelum saklar dinyalakan tidak ikut dibeli.
- **Ajaib order tickets for IDX**: setiap beli/jual saham IDX baru dikirim sebagai tiket order lewat notifikasi dan Telegram. Pastikan Telegram aktif supaya tiket langsung masuk ke HP.

Kartu Real trading juga menampilkan koin nyata yang sedang dipegang dan 8 aksi terakhir (beli, jual, gagal, tiket).

## 5. Pindah ke live

Setelah beberapa hari di testnet berjalan sesuai harapan:
1. Ganti `BROKER_CRYPTO=binance-live` dan isi key live di `deploy/.env`.
2. `docker compose up -d`.
3. Tes koneksi lagi, lalu nyalakan saklar. Kartu akan bertuliskan "Binance LIVE (real money)".

## Cara kerja dan pengaman

- **Setiap putaran (sekitar 5 menit)** robot mencocokkan posisi paper dengan posisi nyata. Posisi paper baru dibeli, posisi nyata yang paper-nya sudah tutup dijual. Karena cara kerjanya mencocokkan, robot tidak akan membeli dua kali walaupun server sempat mati.
- **Stop-loss dijaga robot, bukan dipasang di Binance.** Robot mengecek harga setiap 5 menit dan menjual dengan market order saat stop atau target tersentuh. Kalau server mati, tidak ada stop yang berjalan. Pantau notifikasi "SELL FAILED" dan jual manual kalau perlu.
- **Mematikan saklar** menghentikan pembelian baru. Koin nyata yang sudah dibeli tetap dijual robot saat posisi paper-nya tutup.
- **Pembelian terlambat dilewati.** Kalau posisi paper sudah lebih dari 30 menit saat robot mau menyalinnya (`BROKER_MAX_ENTRY_DELAY_MIN`), pembelian dilewati supaya tidak membeli di harga yang sudah lari.
- **Beli manual dari dashboard tidak disalin.** Jual manual tetap menjual koin nyatanya.
- **Halaman web terbuka untuk publik** (tanpa admin token). Siapa pun yang tahu URL-nya bisa menyalakan atau mematikan saklar. Mereka tidak bisa mengubah key atau batas order, karena itu ada di server. Kalau mau lebih aman, kunci halaman dengan login (misalnya basic auth di Caddy) sebelum memakai live.

## Ajaib: kenapa manual

Per November 2026 Ajaib tidak menyediakan API publik untuk order saham IDX bagi nasabah ritel. Kalau nanti Ajaib atau broker lain (misalnya yang mendukung FIX atau API resmi) membuka akses, adapternya cukup ditambahkan di `src/brokers/` dengan pola yang sama seperti `binance.js`.

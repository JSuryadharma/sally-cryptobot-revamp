# Panduan trading nyata: Binance (crypto) dan Ajaib (saham IDX)

Robot tetap menghitung semuanya di akun paper. Modul `src/brokers/` menyalin keputusan robot ke akun nyata:

- **Crypto → Binance Spot API, dengan market order.** Setiap kali robot membuka posisi paper baru, robot langsung membeli koin yang sama di Binance dengan market order. Saat posisi paper ditutup (kena stop, target, batas 30 hari, jual manual, atau reset), robot langsung menjual persis jumlah koin yang dibeli tadi, juga dengan market order.
- **Saham IDX → tiket order Ajaib.** Ajaib tidak punya API untuk order saham. Robot mengirim tiket lewat notifikasi dan Telegram, misalnya "BELI BBCA 3 lot, harga sekitar Rp 9.150, stop Rp 8.700", lalu Anda memasangnya di aplikasi Ajaib.

Semuanya **mati secara default**. Order nyata baru terkirim kalau server sudah disetel (langkah 2) **dan** saklar di Settings dinyalakan (langkah 4).

## 1. Buat API key Binance

Mulai dari **testnet** (uang mainan) dulu, baru live setelah yakin.

**Testnet**
1. Buka https://testnet.binance.vision lalu login dengan GitHub.
2. Klik "Generate HMAC_SHA256 Key", beri nama, lalu simpan API Key dan Secret Key. Secret hanya muncul sekali.
3. Akun testnet otomatis berisi saldo mainan (USDT, BTC, dan lainnya).

**Live**
1. Di Binance: Profile → API Management → Create API → System generated.
2. Izin yang dicentang **hanya "Enable Spot & Margin Trading"**. Jangan pernah centang "Enable Withdrawals".
3. Pilih "Restrict access to trusted IPs only" lalu isi IP server tempat robot berjalan. Binance mewajibkan ini untuk key yang boleh trading.
4. Isi akun Spot dengan USDT sebanyak modal yang mau dipakai robot.

Catatan:
- Binance memblokir API dari beberapa lokasi, termasuk server di Amerika Serikat (error 451). Pakai server di lokasi yang diizinkan, misalnya Singapura atau Jakarta.
- Binance.com tidak terdaftar di Indonesia, jadi aksesnya bisa saja dibatasi sewaktu-waktu. Simpan modal di Binance secukupnya.

## 2. Isi pengaturan di server

Di server (Docker, lihat `docs/DEPLOY-SERVER.md`), buka `deploy/.env` lalu tambahkan:

```
BROKER_CRYPTO=binance-testnet        # nanti diganti binance-live
BINANCE_API_KEY=isi_api_key
BINANCE_API_SECRET=isi_secret_key
BROKER_MAX_ORDER=50                  # batas keras per pembelian, dalam USDT
BROKER_SCALE=1                       # ukuran nyata = ukuran paper x angka ini
```

Lalu jalankan ulang aplikasinya: `cd deploy && docker compose up -d`.

Key hanya ada di server dan tidak pernah tampil di halaman web. Halaman web juga tidak bisa mengubah mode testnet/live atau batas order.

### Mengatur ukuran order

Robot menentukan ukuran posisi dari akun paper (modal Rp 20 juta, sekitar 1.250 USDT). Ukuran order nyata dihitung begini:

`USDT per beli = min(uang paper posisi itu × BROKER_SCALE, BROKER_MAX_ORDER, 98% USDT bebas di Binance)`

Contoh: modal Binance Anda 300 USDT, sedangkan modal paper sekitar 1.250 USDT. Pakai `BROKER_SCALE=0.24` supaya proporsinya sama. Naikkan `BROKER_MAX_ORDER` sampai di atas ukuran posisi terbesar (sekitar 30% modal, jadi kira-kira 100 USDT untuk modal 300 USDT).

Binance punya minimum order sekitar 5 USDT per transaksi. Pembelian di bawah itu dilewati dan dicatat di log.

## 3. Tes koneksi

Buka **Settings → Real trading** lalu tekan **Test connection**. Robot membaca saldo USDT dan mengirim order uji ke Binance (`/api/v3/order/test`). Order uji tidak membeli apa pun. Kalau berhasil, muncul tulisan "Connected to binance testnet. Free USDT ...".

Error yang sering muncul:
- `-2015 Invalid API-key, IP, or permissions`: IP server belum didaftarkan atau izin Spot belum dicentang.
- `-1021 Timestamp outside of recvWindow`: jam server tidak sinkron. Aktifkan NTP (`timedatectl set-ntp true`).
- `451`: lokasi server diblokir Binance.

## 4. Nyalakan

- **Copy crypto buys to Binance**: mulai sekarang setiap pembelian baru robot juga dibeli di Binance. Posisi paper yang sudah terbuka sebelum saklar dinyalakan tidak ikut dibeli.
- **Ajaib order tickets for IDX**: setiap beli atau jual saham IDX baru dikirim sebagai tiket order. Aktifkan Telegram supaya tiket langsung masuk ke HP.

Kartu Real trading juga menampilkan koin nyata yang sedang dipegang dan 8 aksi terakhir (beli, jual, gagal, tiket).

## 5. Pindah ke live

Setelah beberapa hari di testnet berjalan sesuai harapan:
1. Ganti `BROKER_CRYPTO=binance-live` dan isi key live di `deploy/.env`.
2. `docker compose up -d`.
3. Tes koneksi lagi, lalu nyalakan saklar. Kartu akan bertuliskan "Binance LIVE (real money)".

## Cara kerja dan pengaman

- **Market order**: beli memakai `quoteOrderQty` (jumlah USDT), dan jual memakai jumlah koin yang dibulatkan ke aturan lot Binance. Keduanya langsung terisi di harga pasar.
- **Setiap putaran (sekitar 5 menit)** robot mencocokkan posisi paper dengan posisi nyata. Posisi paper baru dibeli, posisi nyata yang paper-nya sudah tutup dijual. Karena cara kerjanya mencocokkan, robot tidak akan membeli dua kali walaupun server sempat mati.
- **Stop-loss dijaga robot, bukan dipasang di Binance.** Robot mengecek harga setiap 5 menit dan menjual saat stop atau target tersentuh. Kalau server mati, tidak ada stop yang berjalan. Pantau notifikasi "SELL FAILED" dan jual manual kalau perlu.
- **Mematikan saklar** menghentikan pembelian baru. Koin nyata yang sudah dibeli tetap dijual robot saat posisi paper-nya tutup.
- **Pembelian terlambat dilewati.** Kalau posisi paper sudah lebih dari 30 menit saat robot mau menyalinnya (`BROKER_MAX_ENTRY_DELAY_MIN`), pembelian dilewati supaya tidak membeli di harga yang sudah lari.
- **Beli manual dari dashboard tidak disalin.** Jual manual tetap menjual koin nyatanya.
- **Halaman web terbuka untuk publik** (tanpa admin token). Siapa pun yang tahu URL-nya bisa menyalakan atau mematikan saklar, tapi tidak bisa mengubah key atau batas order. Sebaiknya halaman dikunci dengan login (misalnya basic auth di Caddy) sebelum memakai live.

## Kenapa crypto tidak lewat Ajaib

Ajaib Coin Exchange API hanya menerima order limit (tidak ada market order), dan aksesnya harus diminta lewat email ke Ajaib. Kodenya tetap ada sebagai cadangan (`BROKER_CRYPTO=ajaib-testnet` atau `ajaib-live`, lihat `src/brokers/ajaibCoin.js`), tapi tidak disarankan.

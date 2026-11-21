# Panduan trading nyata dengan Ajaib

Robot tetap menghitung semuanya di akun paper. Modul `src/brokers/` menyalin keputusan robot ke akun Ajaib Anda:

- **Crypto → Ajaib Coin Exchange API (otomatis).** Setiap kali robot membuka posisi paper baru, robot membeli koin yang sama di Ajaib Kripto, misalnya pasangan `BTC_IDR`. Saat posisi paper ditutup (kena stop, target, batas 30 hari, jual manual, atau reset), robot menjual persis jumlah koin yang dibeli tadi.
- **Saham IDX → tiket order (manual).** Ajaib tidak punya API untuk order saham. Robot mengirim tiket lewat notifikasi dan Telegram, misalnya "BELI BBCA 3 lot, harga sekitar Rp 9.150, stop Rp 8.700", lalu Anda memasangnya di aplikasi Ajaib.

Semuanya **mati secara default**. Order nyata baru terkirim kalau server sudah disetel (langkah 2) **dan** saklar di Settings dinyalakan (langkah 4). Binance tetap tersedia sebagai pilihan lain (lihat bagian akhir).

## 1. Minta akses API Ajaib Coin

Akses API Ajaib tidak bisa diambil sendiri dari aplikasi. Prosesnya: Anda membuat sepasang kunci, mengirim kunci publiknya ke Ajaib, lalu Ajaib mengirim balik API key.

1. Buat kunci di komputer atau server Anda (butuh `openssl`):
   ```
   openssl ecparam -name prime256v1 -genkey -noout -out ajaib-ec.pem
   openssl pkcs8 -topk8 -nocrypt -in ajaib-ec.pem -out ajaib-private.pem
   openssl ec -in ajaib-ec.pem -pubout -out ajaib-public.pem
   ```
2. Kirim email ke **tech@ajaib.co.id** dengan lampiran `ajaib-public.pem`. Jelaskan bahwa Anda nasabah Ajaib Kripto dan ingin akses Coin Exchange API untuk trading otomatis di akun sendiri. Minta akses **testnet** juga.
3. Simpan `ajaib-private.pem` baik-baik dan jangan pernah dikirim ke siapa pun. Siapa pun yang memegang file ini bisa trading atas nama Anda.

Catatan penting: dokumentasi Ajaib menyebut API ini untuk "exchange client". Ajaib bisa saja hanya memberi akses ke mitra atau institusi, bukan nasabah ritel. Kalau permintaan ditolak, robot tetap bisa memakai tiket order manual untuk crypto juga, atau Binance.

## 2. Isi pengaturan di server

Di server (Docker, lihat `docs/DEPLOY-SERVER.md`), buka `deploy/.env` lalu tambahkan:

```
BROKER_CRYPTO=ajaib-testnet          # nanti diganti ajaib-live
AJAIB_API_KEY=api_key_dari_ajaib
AJAIB_PRIVATE_KEY=...satu baris, lihat di bawah...
AJAIB_QUOTE=IDR                      # pasangan BTC_IDR, ETH_IDR, ...
BROKER_MAX_ORDER=1000000             # batas keras per pembelian, dalam Rupiah
BROKER_SCALE=1                       # ukuran nyata = ukuran paper x angka ini
```

File `.env` Docker tidak bisa memuat teks beberapa baris. Ubah private key menjadi satu baris dengan perintah ini, lalu tempel hasilnya setelah `AJAIB_PRIVATE_KEY=`:

```
awk 'NF {printf "%s\\n", $0}' ajaib-private.pem
```

Lalu jalankan ulang aplikasinya: `cd deploy && docker compose up -d`.

Key hanya ada di server dan tidak pernah tampil di halaman web. Halaman web juga tidak bisa mengubah mode testnet/live atau batas order.

### Mengatur ukuran order

Robot menentukan ukuran posisi dari akun paper (modal Rp 20 juta). Ukuran order nyata dihitung begini:

`Rupiah per beli = min(uang paper posisi itu × BROKER_SCALE, BROKER_MAX_ORDER, 98% saldo Rupiah bebas di Ajaib)`

Contoh: saldo Ajaib Kripto Anda Rp 5 juta, sedangkan modal paper Rp 20 juta. Pakai `BROKER_SCALE=0.25` supaya proporsinya sama, dan `BROKER_MAX_ORDER=1500000` (posisi terbesar robot sekitar 30% modal).

## 3. Tes koneksi

Buka **Settings → Real trading** lalu tekan **Test connection**. Robot membaca jam server Ajaib, saldo Rupiah Anda, dan memastikan pasangan `BTC_IDR` ada. Tes ini tidak mengirim order. Kalau berhasil, muncul tulisan "Connected to ajaib testnet. Free IDR ...".

Kalau muncul `Ajaib 403 invalid_client`, tanda tangan ditolak. Penyebabnya bisa API key atau private key yang salah, atau jam server tidak sinkron (aktifkan NTP: `timedatectl set-ntp true`). Kalau keduanya sudah benar, kemungkinan format tanda tangan di dokumentasi resmi Ajaib berbeda dari yang saya pakai. Ada tiga pengaturan cadangan: `AJAIB_SIG_ENCODING=hex`, `AJAIB_DSA_ENCODING=ieee-p1363`, dan `AJAIB_PATH_PREFIX`. Cocokkan dengan dokumentasi yang Ajaib kirim.

## 4. Nyalakan

- **Copy crypto buys to Ajaib**: mulai sekarang setiap pembelian baru robot juga dibeli di Ajaib. Posisi paper yang sudah terbuka sebelum saklar dinyalakan tidak ikut dibeli.
- **Ajaib order tickets for IDX**: setiap beli atau jual saham IDX baru dikirim sebagai tiket order. Aktifkan Telegram supaya tiket langsung masuk ke HP.

Kartu Real trading juga menampilkan koin nyata yang sedang dipegang dan 8 aksi terakhir (beli, jual, gagal, tiket).

## 5. Pindah ke live

Setelah beberapa hari di testnet berjalan sesuai harapan:
1. Ganti `BROKER_CRYPTO=ajaib-live` (dan API key live kalau Ajaib memberi key yang berbeda) di `deploy/.env`.
2. `docker compose up -d`.
3. Tes koneksi lagi, lalu nyalakan saklar. Kartu akan bertuliskan "Ajaib Coin LIVE (real money)".

## Cara kerja dan pengaman

- **Ajaib hanya menerima order limit**, tidak ada market order. Karena itu robot memasang order limit sedikit di atas harga terakhir saat membeli (+0,5%) atau sedikit di bawah saat menjual (−0,5%), supaya langsung terisi. Robot mengecek statusnya sekitar 15 detik. Sisa yang belum terisi dibatalkan. Pembelian yang sama sekali tidak terisi dilewati. Penjualan yang baru sebagian terisi akan dicoba lagi di putaran berikutnya.
- **Setiap putaran (sekitar 5 menit)** robot mencocokkan posisi paper dengan posisi nyata. Posisi paper baru dibeli, posisi nyata yang paper-nya sudah tutup dijual. Karena cara kerjanya mencocokkan, robot tidak akan membeli dua kali walaupun server sempat mati.
- **Stop-loss dijaga robot, bukan dipasang di Ajaib.** Robot mengecek harga setiap 5 menit dan menjual saat stop atau target tersentuh. Kalau server mati, tidak ada stop yang berjalan. Pantau notifikasi "SELL FAILED" dan jual manual di aplikasi Ajaib kalau perlu.
- **Mematikan saklar** menghentikan pembelian baru. Koin nyata yang sudah dibeli tetap dijual robot saat posisi paper-nya tutup.
- **Pembelian terlambat dilewati.** Kalau posisi paper sudah lebih dari 30 menit saat robot mau menyalinnya (`BROKER_MAX_ENTRY_DELAY_MIN`), pembelian dilewati supaya tidak membeli di harga yang sudah lari.
- **Beli manual dari dashboard tidak disalin.** Jual manual tetap menjual koin nyatanya.
- **Koin yang tidak ada di Ajaib dilewati** dengan pesan "Ajaib has no pair ...". Cek daftar koin Ajaib Kripto dan watchlist robot.
- **Halaman web terbuka untuk publik** (tanpa admin token). Siapa pun yang tahu URL-nya bisa menyalakan atau mematikan saklar, tapi tidak bisa mengubah key atau batas order. Sebaiknya halaman dikunci dengan login (misalnya basic auth di Caddy) sebelum memakai live.

## Sumber spesifikasi

Dokumentasi resmi ada di https://ajaib.gitbook.io/coin-exchange, tapi halamannya tidak bisa dibaca dari server saya. Klien ini dibuat dari salinan spesifikasinya di apis.io:
- Alamat: testnet `https://api.ajaib.tech`, live `https://api.ajaib.co.id`, path `/coin/internal/v1`.
- Header `X-API-KEY`, `X-TIMESTAMP` (milidetik), dan `X-SIGNATURE`. Tanda tangannya ECDSA-SHA256 atas `timestamp + METHOD + path + query + body`.

Saat Ajaib mengirim dokumentasi resminya, cocokkan bagian ini. Detail yang belum pasti (format tanda tangan, minimum order) bisa diatur tanpa mengubah kode.

## Pilihan lain: Binance

Kalau tetap mau memakai Binance untuk crypto, isi `BROKER_CRYPTO=binance-testnet` atau `binance-live`, `BINANCE_API_KEY`, `BINANCE_API_SECRET`, dan `BROKER_MAX_ORDER` (dalam USDT). Buat key di https://testnet.binance.vision untuk testnet. Untuk live, buat di Binance → API Management, centang hanya "Enable Spot & Margin Trading", jangan centang withdrawals, dan batasi ke IP server.

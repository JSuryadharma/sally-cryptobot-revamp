# Deploying Sally Crypto Bot on your own server

This guide moves the app from Vercel to a server you rent (a VPS). Everything runs in Docker:

- **app**: the Node server (dashboard + API + engine)
- **db**: Postgres, kept on the server, never exposed to the internet
- **caddy**: the web server in front, which gets and renews the HTTPS certificate by itself

The server runs the robot by itself: a built-in timer ticks the engine every minute, so cron-job.org is no longer needed (the `POST /api/engine/tick` URL is switched off while the timer runs).

Time needed: about 30-45 minutes the first time.

---

## Step 1. Rent a server

Any VPS provider works (DigitalOcean, Vultr, Hetzner, Linode, AWS Lightsail, Biznet, IDCloudHost...).

- **System:** Ubuntu 24.04 LTS
- **Size:** 1 vCPU, 1-2 GB RAM, 20+ GB disk is plenty (about US$5-12/month)
- **Region:** Singapore or Tokyo. Avoid US regions: Binance blocks some US data centres, and the robot needs Binance's public market data.

Write down the server's **public IP address** (e.g. `203.0.113.7`) and how to log in (root password or SSH key).

## Step 2. Give it an address (domain)

HTTPS needs a name, not a bare IP. Pick one:

- **You have a domain:** at your DNS provider, add an **A record**, e.g. `bot.yourdomain.com` → your server IP. Wait a few minutes.
- **No domain:** use the free `sslip.io` name made from your IP with dashes: `203-0-113-7.sslip.io`. It already points to your server; nothing to set up.

From now on this guide calls it `YOUR_DOMAIN`.

The app lives under the path **`/sally`**, so the dashboard is at `https://YOUR_DOMAIN/sally/`. The path is the `BASE_PATH` setting in Step 5. Change it to anything you like, or leave it empty to serve the app at the root.

## Step 3. Log in and install Docker

From your Mac's Terminal:

```bash
ssh root@YOUR_SERVER_IP
```

Then, on the server:

```bash
# Updates + Docker (official install script)
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh

# Firewall: only SSH and web traffic in
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable

# Check that Binance's market data is reachable from this server (should print {})
curl -s https://data-api.binance.vision/api/v3/ping; echo
```

If the last command does not print `{}`, pick a server in another region before going further.

## Step 4. Download the app

```bash
cd /opt
git clone https://github.com/JSuryadharma/sally-cryptobot-revamp.git
cd sally-cryptobot-revamp/deploy
```

## Step 5. Fill in the settings

```bash
cp .env.server.example .env
openssl rand -hex 24     # copy the output: this is POSTGRES_PASSWORD
nano .env
```

Fill in two lines (save with `Ctrl+O`, `Enter`, quit with `Ctrl+X`):

```
DOMAIN=YOUR_DOMAIN
BASE_PATH=/sally
POSTGRES_PASSWORD=<the random value you just generated>
```

## Step 6. Start it

```bash
docker compose up -d --build
docker compose ps
```

After a minute all three services should say `Up`, and `app` and `db` should say `(healthy)`. Then check:

```bash
curl https://YOUR_DOMAIN/sally/api/health
# {"database":{"connected":true,...}}
```

Open `https://YOUR_DOMAIN/sally/` in your browser. You should see the dashboard (empty, because the database is new).

## Step 7. Bring over your current data (optional, recommended)

This copies your settings, paper portfolio, trade journal and history from the Vercel database (Neon) to the server.

1. **Pause the cron-job.org job** (so nothing writes to the old database while copying).
2. Get the old database address: Vercel → your project → Settings → Environment Variables → `DATABASE_URL` (starts with `postgresql://`).
3. On the server, in `/opt/sally-cryptobot-revamp/deploy`:

   ```bash
   ./copy-db-from-neon.sh 'postgresql://...paste the Vercel DATABASE_URL here...'
   docker compose restart app
   ```

   It prints the number of rows copied. Refresh the dashboard: your balance, positions and settings should match Vercel.

Skip this step if you want to start fresh.

## Step 8. Turn off the cron-job.org job

The server ticks itself, so the cron-job.org job is no longer needed. In cron-job.org, **disable or delete** the job (it was paused in Step 7). Leaving it pointed at Vercel would keep the old Vercel copy trading on the old database.

The app log shows the timer is on:

```
[tick] built-in timer on - POST /api/engine/tick is disabled
```

## Step 9. Check it's ticking

Wait a few minutes, then open:

```
https://YOUR_DOMAIN/sally/api/engine/status
```

`lastTickAt` should be within the last 1-2 minutes and `recentErrors` empty. You can also watch it live:

```bash
docker compose logs -f app
```

## Step 10. Retire the Vercel copy

Once the server has ticked fine for a day:

- Make sure the cron-job.org job is off, so the Vercel copy stops trading.
- In Vercel, either delete the project or pause it (Settings → General). Otherwise you'll have two dashboards showing different data.
- Keep the Neon database for a week or two as a backup, then delete it if you like.

---

## Server that already has nginx (or another web server)?

Then skip Caddy and use the `docker-compose.yml` in the repo root. It runs the web app and Postgres. Do Steps 1, 3 and 4 above, then:

```bash
cd /opt/sally-cryptobot-revamp
printf 'BASE_PATH=/sally\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env
docker compose up -d --build
curl http://127.0.0.1:3300/sally/api/health
```

The app listens on `127.0.0.1:3300` only. Add this inside your existing nginx `server { ... }` block, then run `nginx -t && systemctl reload nginx`:

```nginx
location /sally/ {
    proxy_pass http://127.0.0.1:3300;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
}
```

`proxy_pass` has no path after the port, so nginx forwards `/sally/...` unchanged. A trailing slash (`http://127.0.0.1:3300/`), which strips `/sally`, works too. Steps 7-10 work the same; the timer is on here too (use `https://YOUR_DOMAIN/sally/...`). For Step 7, run the copy from the repo root: `DB_SERVICE=postgres deploy/copy-db-from-neon.sh '<Vercel DATABASE_URL>'`, then `docker compose restart app`.

## Everyday commands

Run these on the server inside `/opt/sally-cryptobot-revamp/deploy`.

| What | Command |
|---|---|
| See status | `docker compose ps` |
| Live logs | `docker compose logs -f app` |
| Restart the app | `docker compose restart app` |
| Stop everything | `docker compose down` (data is kept) |
| Start again | `docker compose up -d` |

### Update to the latest code (after a PR is merged)

```bash
cd /opt/sally-cryptobot-revamp
git pull
cd deploy
docker compose up -d --build
```

A restart in the middle of a tick is safe: each tick saves in one transaction and the next tick catches up on missed candles.

### Backups

Make a backup file of the whole database:

```bash
docker compose exec -T db pg_dump -U postgres sallycryptobot | gzip > ~/backup-$(date +%F).sql.gz
```

To do it every night at 02:00, run `crontab -e` and add:

```
0 2 * * * cd /opt/sally-cryptobot-revamp/deploy && docker compose exec -T db pg_dump -U postgres sallycryptobot | gzip > /root/backup-$(date +\%F).sql.gz && find /root -name 'backup-*.sql.gz' -mtime +14 -delete
```

Copy a backup to your Mac with `scp root@YOUR_SERVER_IP:~/backup-*.sql.gz ~/Downloads/`.

---

## Good to know

- **The server survives reboots.** Every service has `restart: unless-stopped`, and Docker starts on boot.
- **The dashboard is public**, same as on Vercel today: anyone who knows the address can change settings or press Reset (paper money only). If you ever want a password in front of it, replace `deploy/Caddyfile` with the version below and run `docker compose restart caddy`.

  ```
  {$DOMAIN} {
  	encode gzip
  	@protected not path /sally/api/health /api/health
  	basic_auth @protected {
  		joe <hash from: docker compose exec caddy caddy hash-password>
  	}
  	reverse_proxy app:3300
  }
  ```

- **Built-in timer vs cron-job.org.** The timer is on by default (`ENGINE_LOCAL_LOOP=on`), and while it runs `POST /api/engine/tick` answers `404`. To drive the server from cron-job.org instead, set `ENGINE_LOCAL_LOOP=off` in `.env`, run `docker compose up -d`, and point a cron-job.org job (POST, minutes `1,6,11,...,56`) at `https://YOUR_DOMAIN/sally/api/engine/tick`. Only one of the two runs at a time.
- **Keeping Neon instead of the server database.** Set `DATABASE_URL=` (the Neon address, format `postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=SCHEMA&sslmode=require`; `?schema=` is optional) and `POSTGRES_SSL=true` in `deploy/.env`, skip Step 7, then `docker compose up -d`. The bundled Postgres still starts but sits unused.
- **Vercel still works.** Nothing here breaks the Vercel deploy (Vercel has no timer and keeps its tick URL), so you can switch back by turning the cron-job.org job on again.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser shows a certificate error | DNS doesn't point at the server yet, or ports 80/443 are blocked. Check `docker compose logs caddy`. |
| "Too many redirects" | If the domain is behind Cloudflare, set SSL/TLS mode to **Full** (not Flexible). Otherwise run `curl -sI https://YOUR_DOMAIN/sally/` and check the `Location:` header to see who redirects. |
| `502 Bad Gateway` | The app isn't up. `docker compose logs app` shows why (usually a typo in `.env`). |
| `/api/health` says `connected: false` | Database problem: check `POSTGRES_PASSWORD` / `DATABASE_URL` in `.env`. If you change `POSTGRES_PASSWORD` after the first start, it won't apply to the existing database; run `docker compose down -v` (wipes the server database) and start again. |
| `lastTickAt` doesn't move | Check `docker compose logs app` for `[tick] built-in timer on`. If it says `off`, remove `ENGINE_LOCAL_LOOP=off` from `.env` and run `docker compose up -d`. |
| cron-job.org gets `404` | Expected: the server ticks itself. Turn the job off (Step 8). |
| Ticks run but every coin shows a Binance error | The server's region can't reach `data-api.binance.vision`; move to a Singapore/Tokyo server. |

# QR Platform

A self-hosted platform for creating **static** and **dynamic** QR codes.

| | Static | Dynamic |
|---|---|---|
| What's encoded | The content itself | A short link on this server (`/r/<slug>`) |
| Edit after printing | No | Yes, change the destination any time |
| Scan analytics | No | Yes: total/unique scans, daily chart, device/OS/browser, CSV export |
| Needs server | Only to render | Yes, the server must stay online |

## Features

- **Static types:** URL, plain text, Wi‑Fi, email, SMS, phone, geo location
- **vCard QR codes:** first and last name, company, job title, photo, date of birth, up to 5 phones (type and country code), emails and websites, address, and card color.
  - **Dynamic (default):** opens a hosted mobile contact card (`/r/<slug>`) with Call, Email and Website buttons and **Add to contacts** (`/r/<slug>/vcf`). It's editable, trackable, and includes the photo.
  - **Static:** the vCard text is stored in the QR itself. The photo isn't included, and you can also download a `.vcf` file.
- **Dynamic codes:** custom slugs, editable destination, pause/resume, delete, destination history
- **Design:** foreground/background colors, transparent background, error correction level, quiet zone, size up to 2048 px, center logo (auto-switches to high error correction), contrast warnings
- **Export:** PNG, SVG and EPS. EPS is pure vector for print shops, Illustrator and CorelDRAW. The center logo is included in PNG and SVG only.
- **Privacy-friendly analytics:** visitors are counted with a salted hash, and raw IPs are never stored
- **Optional password** protection for the dashboard and API. The redirect links stay public.

## Run

Requires Node.js 22.13+ (uses the built-in `node:sqlite`, so nothing needs compiling).

```bash
npm install
npm start
```

Open http://localhost:3000.

## Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `3000`) |
| `BASE_URL` | Public URL encoded into dynamic QRs, e.g. `https://qr.example.com`. **Set this in production** or codes will point at whatever host you browsed from. |
| `ADMIN_PASSWORD` | Enables HTTP Basic auth on the dashboard and API (any username) |
| `IP_SALT` | Fixed salt for unique-visitor hashing. Set it so unique counts stay consistent across restarts. |
| `DATA_DIR` | Where the SQLite database lives (default `./data`) |

## API

All under `/api` (Basic auth if `ADMIN_PASSWORD` is set).

- `GET /api/qr?data=…&format=png|svg|eps&size=512&dark=111827&light=ffffff&ecc=M&margin=2`: render any QR
- `GET /api/dynamic`: list codes with scan counts
- `POST /api/dynamic` `{ name, targetUrl, code?, style? }`: create a redirect
- `POST /api/dynamic` `{ type: "vcard", vcard: {…}, name?, code?, style? }`: create a contact card
- `GET /api/dynamic/:id?days=30`: details, stats and history
- `PATCH /api/dynamic/:id` `{ name?, targetUrl?, active?, style? }`: update
- `DELETE /api/dynamic/:id`
- `GET /api/dynamic/:id/scans.csv`: export scans
- `GET /api/overview`: totals
- `GET /r/:code`: public redirect (logs the scan, `302` to the destination; `410` if paused)
- `GET /r/:code/vcf`: public `.vcf` download for vCard codes

## Deploying to a VPS

`deploy/build-installer.sh` bundles the app into one self-contained script:

```bash
deploy/build-installer.sh qr.starkpeople.in
```

Copy the resulting `deploy/install-qr-platform.sh` to an Ubuntu/Debian server and run it as root. It:

- installs Node.js 22 if needed
- installs the app to `/opt/qr-platform`, with data in `/var/lib/qr-platform` and config in `/etc/qr-platform.env`
- runs it as the `qr-platform` systemd service, bound to `127.0.0.1`
- adds the domain to the existing nginx, Caddy or Apache (or installs Caddy if port 80 is free), with HTTPS
- generates an admin password and prints it once

Re-running it updates the code and keeps the database, password and visitor salt.

## Project layout

```
server.js        Express app: redirect, QR rendering, REST API
db.js            SQLite schema (dynamic_codes, scans, url_history)
public/          Dashboard (vanilla HTML/CSS/JS, no build step)
```

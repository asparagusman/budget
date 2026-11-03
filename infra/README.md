# Deploying budget

One household, two people, one Linux thin client on the home network, at `http://budget.local`. No
public ingress, no CI,
no monitoring stack — see [`../.claude/plans/phases/11-polish-mobile-import.md`](../.claude/plans/phases/11-polish-mobile-import.md)
"Non-goals" for why each of those is deliberately absent.

Everything below is meant to be followed top to bottom on a machine that has nothing on it yet.

---

## How this is reached, and what that means

The app is served over **plain http on the home network**, at `http://budget.local`. The name comes
from the host announcing itself over mDNS (step 1), so there is no domain, no certificate and
nothing to install on the phones.

There are no passkeys, and no password to sign in with day to day. A device gets in by **being approved**: it
opens `http://budget.local`, asks to join, and shows a four-letter code; someone on a device that is
already signed in approves it (a notice appears on every page of the app) and says whose device it
is. That device then stays signed in for as long as it keeps being used.

What that trades away, deliberately:

- **No encryption in the app's own traffic.** Figures cross the Wi-Fi as plain http. The Wi-Fi's own
  encryption is what protects them, so the router should be on **WPA3** (or WPA2/WPA3 mixed), with
  guests on the **guest network** and the server **wired** to the router. What's left is someone
  already on the home network setting out to tamper with traffic.
- **Home network only.** Away from home the app isn't reachable at all.
- **Anyone on the network can ask to join.** Asking does nothing until a member approves it, and at
  most ten devices can be waiting at once. The first visitor to a fresh install becomes its first
  user, so set up straight after the first start (step 6).

**`PUBLIC_ORIGIN` must equal the address you type**, `http://budget.local`. CORS and the
break-glass invite links are built from it. The API checks its shape at startup and reports it as
`origin` in `GET /health`.

---

## 1. Prerequisites on the host

Debian/Ubuntu; adapt for your distro.

```sh
sudo apt-get update && sudo apt-get install -y git curl jq

# Docker Engine + the compose plugin (NOT docker.io from the distro repos — it ships
# a compose v1 that does not understand this project's compose file).
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"     # log out and back in

# Avahi announces names on the network as <name>.local. Most desktop distros
# (Linux Mint, Ubuntu desktop) already run it.
sudo apt-get install -y avahi-daemon avahi-utils
sudo systemctl enable --now avahi-daemon

# Caddy: the front door on port 80. It answers http://budget.local and passes
# it to the app (step 5). Skip if the host already runs it.
sudo apt-get install -y caddy

docker --version && docker compose version
```

Then give the machine the extra name `budget.local`, without renaming it — it may already be known
by its own name to other things on the network. A small service announces the alias, at this
machine's address on the home network (find it with `ip -4 -br addr`):

```sh
sudo tee /etc/systemd/system/budget-mdns.service >/dev/null <<'EOF'
[Unit]
Description=Announce budget.local on the home network
After=avahi-daemon.service network-online.target
Requires=avahi-daemon.service

[Service]
ExecStart=/usr/bin/avahi-publish -a -R budget.local 192.168.0.211
Restart=always

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now budget-mdns
avahi-resolve -n budget.local
```

Put this machine's own address where `192.168.0.211` is. `avahi-resolve` should print it back. Then, from a laptop or
phone on the same Wi-Fi, open `http://budget.local` once the stack is up (step 4) to check the name
resolves there too. iPhones, Macs and Windows resolve `.local` names; Android does from version 13.
If an Android phone can't find it, add a DNS entry on the router mapping `budget.local` to this
machine's address.

Two settings on the **router**, once:

- **Reserve this machine's address** (a DHCP reservation), so a router DNS entry, if you need one,
  keeps pointing at the right place.
- **Wi-Fi security on WPA3** (or WPA2/WPA3 mixed for older devices), and guests on the guest
  network. That is what keeps the app's plain-http traffic private — see the top of this page.

If the host runs a firewall (`ufw`), allow port 80 and mDNS from the home network:

```sh
sudo ufw allow 80/tcp
sudo ufw allow 5353/udp
```

**Disk encryption.** If the host's disk is not already encrypted, encrypt it. This machine holds
every figure about the household's money in a Postgres volume, in plaintext, forever. LUKS on the
whole disk at install time is the easy path; `cryptsetup` on a second disk that carries only
`/var/lib/docker/volumes` is the retrofit. A stolen thin client should cost you a thin client.

---

## 2. Get the code

```sh
git clone <your remote> budget && cd budget
```

The repo is the deployment artefact — there is no registry, and the images are built on the host.

---

## 3. Secrets and configuration

```sh
cp .env.example .env
ln -s ../.env infra/.env
```

Compose reads `.env` from the compose file's own directory — `infra/` — not from where you run it.
The symlink is what makes every `docker compose -f infra/docker-compose.yml …` command on this page
work as written; without it they stop with `required variable … is missing a value`. Like `.env`
itself it is gitignored and kept out of image builds.

Generate real values. Do not reuse anything, and do not commit the result (`.env` is gitignored):

```sh
# POSTGRES_PASSWORD — 32 URL-safe characters
openssl rand -base64 24 | tr -d '/+=' | head -c 32; echo

# SESSION_SECRET — must be at least 32 characters or the API refuses to start
openssl rand -base64 48
```

Then edit `.env`:

| Variable | Value on the thin client |
|---|---|
| `POSTGRES_USER` | `budget` |
| `POSTGRES_PASSWORD` | the generated password |
| `POSTGRES_DB` | `budget` |
| `DATABASE_URL` | only used by host-side tooling (`pnpm db:migrate`), not by the containers — leave the example value |
| `PORT` | `3001` |
| `SESSION_SECRET` | the generated secret |
| `VITE_API_URL` | leave it; the web image is built with `/api` and nginx proxies that to the api container |
| `PUBLIC_ORIGIN` | **`http://budget.local`**, exactly — see the top of this page |
| `TZ` | `Australia/Sydney`. The api's "today" — what's due, which pay period you're in — is local time, and containers are UTC unless told otherwise, which leaves today as yesterday until 10–11am. Compose falls back to `Australia/Sydney` if it's unset |
| `APP_VERSION` | leave it at `dev`. The commands below stamp each build with `APP_VERSION=$(git rev-parse --short HEAD)`, which overrides it, and `GET /health` reports it back. A value written here goes stale on the next pull |

The api container builds its own `DATABASE_URL` from `POSTGRES_*` at the compose network's `db`
hostname, so the `DATABASE_URL` in `.env` never reaches it. That separation is deliberate: host
tooling talks to a published port, containers talk to each other.

**`POSTGRES_PASSWORD` is fixed the first time the stack starts.** Postgres reads it only when it
initialises an empty volume. Changing it in `.env` afterwards changes the password the api *sends*,
not the one Postgres *accepts*, and the api is locked out. To rotate it, change it inside Postgres
first (`\password budget` in the database shell from Operating notes — it prompts, so the password
stays out of any history), then in `.env`, then run the up command from step 4.

Check that compose can see all of it:

```sh
docker compose -f infra/docker-compose.yml config >/dev/null && echo ok
```

`ok` means every required variable is present. It says nothing about whether the values are right.

---

## 4. Start the stack

```sh
APP_VERSION=$(git rev-parse --short HEAD) docker compose -f infra/docker-compose.yml up -d --build
```

Four services, in this order, enforced by compose rather than by you remembering:

1. **`db`** — Postgres 16. No published port: it is reachable only on the compose network.
2. **`migrate`** — a one-shot container on the api image that applies pending migrations and exits.
   `api` waits for it to exit **successfully**, so the app can never start against a schema older
   than its own code.
3. **`api`** — Hono on `${PORT}`, published on `127.0.0.1` only.
4. **`web`** — nginx serving the built SPA on `127.0.0.1:8080`, proxying `/api/` to the api
   container. Caddy puts it on the network as `http://budget.local` (step 5).

Check it:

```sh
docker compose -f infra/docker-compose.yml ps
curl -s localhost:3001/health | jq
```

A healthy response looks like:

```json
{
  "ok": true,
  "db": true,
  "version": "a1b2c3d",
  "origin": "http://budget.local",
  "migrations": { "applied": 13, "expected": 13, "latest": "0012_sleepy_shard",
                  "expectedLatest": "0012_sleepy_shard", "pending": 0 }
}
```

`origin` should be the address you will type into the browser. If it isn't, fix `PUBLIC_ORIGIN`
and recreate the api (`… up -d api`; a restart alone keeps the old environment).

`ok` is false and the endpoint returns **503** when the database is unreachable *or* when
`pending > 0` — a running app whose migrations are behind its code fails in ways that are far
harder to read from the symptom than from here. If you ever see `pending > 0`, you started the api
without the `migrate` service; bring the stack up again with the compose file rather than
`docker compose up api`.

---

## 5. Put it on the network

Add this block to `/etc/caddy/Caddyfile`, alongside anything already there:

```
http://budget.local {
	reverse_proxy 127.0.0.1:8080
}
```

The `http://` matters: without it Caddy tries to get an HTTPS certificate for the name, which no one
issues for `.local`. Then:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

On a phone on the home Wi-Fi, open `http://budget.local`. If it doesn't load, check in this order:

1. `curl -s localhost:8080/ | head -c 100` on the host returns HTML — the stack is serving.
2. `curl -s -H 'Host: budget.local' localhost/ | head -c 100` returns the same — Caddy is passing
   it through.
3. `avahi-resolve -n budget.local` on the host prints its address — the name is being announced.
4. The phone is on the same network (not the guest network, not mobile data, no VPN).
5. On Android older than 13, use the router DNS entry from step 1.

---

## 6. First run: set up, then approve everyone else

Open `http://budget.local` on the device you want to use first — a phone is the usual choice, since
that is where the app is used most. **Do this straight after the stack first starts**: until there
is a user, whoever opens it first sets it up.

The `users` table is empty on a fresh database, so the app shows a **set-up** screen. Enter your name
and you are the first user, signed in on that device.

Every other device — yours or anyone else's — joins the same way:

1. On the new device, open `http://budget.local`, name the device ("Grace's phone") and tap **Ask to
   join**. It shows a four-letter code and waits.
2. On a signed-in device, a notice appears at the top of every page: "Grace's phone is asking to
   join". Tap **Review**, check the code matches, choose whose device it is — an existing member, or
   **Someone new to the household** with their name — and **Approve**.
3. The new device signs itself in within a couple of seconds.

A request that isn't answered runs out after 15 minutes. **Turn down** removes it straight away.
Signed-in devices are listed under **Admin → My devices**, where a lost one can be signed out.

### Then, straight away: set the recovery password

Approved devices are the way in, and there is exactly one password in this app, for when every one
of them is gone. Set it now: **Admin → My devices → Recovery password**, at least 16 characters.
The household has one, held by one user; setting, replacing or removing it needs an approved device.

On the sign-in screen it opens a session that lasts an hour and reaches one screen: sign that device
in as a member of the household, approve a waiting device, sign out lost ones. It can't see or
change a single figure by itself. Keep it somewhere that isn't this app — a password manager, or
paper.

Without it, getting back in after losing every device needs a shell on this box (see Operating
notes).

---

## 7. Load the household's data

The app takes a backup every week from the moment it starts (see [Backups](#backups)), but those
files live on this box's disk until you copy them off. Do that once the data is in.

Either enter it by hand, or use the importer:

**Admin → Import spreadsheet** takes the old `.xlsx`, shows every row it found grouped by what
it will become, lets you deselect any of them, and writes nothing until you confirm. Re-importing
the same file updates rather than duplicating, so a mistake in the mapping step is fixable by
importing again. See the reconciliation summary it prints afterwards: every figure the spreadsheet
held, beside what the app now computes.

---

## Updating

Order matters, and three of the four steps are done for you:

```sh
cd budget
git rev-parse --short HEAD          # note it: this is what you roll back to
git pull                                                              # 1. pull
APP_VERSION=$(git rev-parse --short HEAD) docker compose -f infra/docker-compose.yml up -d --build
#                                                                     # 2. rebuild
#                                                                     # 3. migrate  (the one-shot
#                                                                     #    `migrate` service)
#                                                                     # 4. restart  (api waits for
#                                                                     #    migrate to exit 0)
curl -s localhost:3001/health | jq '.version, .migrations'

# Every build leaves the previous images and build cache behind. On a thin
# client's disk that adds up within months.
docker image prune -f
docker builder prune -f --keep-storage 2GB   # newer Docker also spells it --reserved-space
```

`--build` is not optional. Without it compose happily reuses the image it already has and serves
the code you had before the pull, which then looks like "the fix didn't work".

**A failed migration is an outage.** Compose removes the old `api` container *before* the new one
waits on `migrate`, so if `migrate` exits non-zero the new `api` never starts and the old one is
already gone (a rebuilt `web` waits on a healthy `api` too). The database itself is untouched: all
pending migrations run in one transaction, so a failure rolls every one of them back. Read why:

```sh
docker compose -f infra/docker-compose.yml logs migrate
```

Then roll the code back to the commit you noted, and bring that up the same way:

```sh
git checkout <previous sha>
APP_VERSION=$(git rev-parse --short HEAD) docker compose -f infra/docker-compose.yml up -d --build
```

That leaves the checkout on a detached HEAD. Once the migration is fixed upstream, `git checkout
main && git pull` (or whichever branch you deploy) and run the update again.

---

## Backups

The app backs itself up. **Admin → Backups** shows the last one, takes one on demand (**Back up
now**), and lists them with Download, Restore and Delete.

**What is backed up.** Everything the household entered: people, accounts and balances, pay
schedules, income, bills and their history, variable costs, allocation plans and versions, goals,
house scenarios, and settings. **Not** users, devices, invites, the audit log, or `.env` — so
restoring a backup can't lock anyone out or sign back in a device you signed out.

**When.** The api checks at startup and then hourly; if the newest automatic backup is 7 days old
(or there isn't one) it takes another. A box that was off for a month takes one on its next start.
It also takes a **safety backup** before every restore and before every import commit, so either
can be undone. The newest 3 of each of those, and of the weekly ones, are kept; **Back up now**
backups are kept until you delete them. If a weekly backup fails — a full disk, say — Admin →
Backups says so, and the dashboard warns when there has been none for 8 days.

**Where.** One gzipped JSON file each, in `infra/backups/` on the host (`/backups` inside the api
container; `BACKUP_DIR` sets it). The folder is gitignored, and a name like
`weekly-20261102T030000000Z.json.gz` says what it is and when. They are plaintext once unzipped:
the disk's encryption is the only thing protecting them, so don't leave copies somewhere that
isn't.

**Getting them off the box.** A backup on the same disk doesn't survive that disk. Either download
one from Admin → Backups, or copy the folder from another machine on the home network:

```sh
scp -r <user>@budget.local:/path/to/budget/infra/backups ./budget-backups
```

Do this after anything you'd hate to re-enter, and every few weeks regardless.

### Restoring

**On the same box**: Admin → Backups → **Restore** on the backup you want, and confirm. The current
state is backed up first (`Before restore`), so a restore that turns out to be the wrong one can be
undone the same way. Everything entered since the backup is replaced; users and devices aren't
touched. A restore either completes or changes nothing.

A backup from an older version of the app is attempted, and if it can't be mapped it is refused
with nothing changed. One from a *newer* version is refused: update the app first.

**On a fresh host** (a dead disk, a new machine):

1. Follow this page through step 6: bring the stack up and set up the first user on the set-up
   screen. A new host has no users, and backups don't carry any, so this step is what
   gives you a way in.
2. Copy the backup file to whatever device you're signed in on.
3. Admin → Backups → **Restore from file…**, choose it, and confirm.

Skip step 7 — the file already has everything the importer would have loaded.

---

## Operating notes

**Logs.** `docker compose -f infra/docker-compose.yml logs -f api`. The API logs method, path,
status and duration — never request bodies, because those carry the household's financial figures.
Do not add body logging. A failed request logs its database error code and Postgres's message, never
the query's parameters, for the same reason. `/health` is left out of the request log (the
healthcheck polls it every 5 seconds). Each service's log rotates at 3 × 10 MB.

**Health.** `GET /health` is the whole of this app's observability, alongside those request logs.
That is a deliberate choice for a two-user household app; an observability stack here would be cost
without benefit. If you want an alert, a cron entry that curls `/health` and mails you on non-200
is proportionate.

**Database shell.**

```sh
docker compose -f infra/docker-compose.yml exec db psql -U budget -d budget
```

**Ports.** Only `web` (8080) and `api` (3001) publish anything, and both only on the host's
loopback (`127.0.0.1`), so nothing on the network reaches either directly. Caddy, on port 80, is
what makes 8080 reachable as `http://budget.local`; nothing makes 3001 reachable off the host — it
is published only so `curl localhost:3001/health` works here. Postgres publishes nothing at all;
`docker-compose.dev.yml` exists solely to add a published 5432 for local development and must never
be merged in on this host.

### Recovering when every device is gone

There are no recovery codes to lose and no email reset. There are two ways back in.

**The recovery password**, if it was set (step 6): on the sign-in screen, tap **Lost every
device?** and sign in with it. The one screen it opens signs that device in as whichever member of
the household you choose, and lists your devices so the lost ones can be signed out.

**A shell on this box**, which works whether or not the password was set, or remembered:

```sh
docker compose -f infra/docker-compose.yml exec api node dist/scripts/auth-invite.js --user "Lachlan" --purpose new_device
```

`--user` is the display name, exactly. It prints a link — open it on whatever device you're
recovering with, and that device is signed in as that user — and writes an `audit_log` entry with
no actor, so it can be told apart from anything a signed-in user did. The link is single-use and
expires after 24 hours. `--purpose new_user`, with no `--user`, makes a link that adds a new member
of the household instead.

(The image has no pnpm and no source tree, so the dev-only `pnpm auth:invite` doesn't exist there.
`dist/scripts/auth-invite.js` is the same script, bundled.)

If the `users` table is empty — a fresh volume, say — there is nothing to recover: open the app and
it shows the set-up screen again, no shell needed. Whoever completes it first becomes the first
user, which is one more reason the app is reachable from the home network only.

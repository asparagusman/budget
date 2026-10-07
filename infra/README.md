# Deploying budget

One household, two people, one Linux thin client on a Tailscale tailnet. No public ingress, no CI,
no monitoring stack — see [`../.claude/plans/phases/11-polish-mobile-import.md`](../.claude/plans/phases/11-polish-mobile-import.md)
"Non-goals" for why each of those is deliberately absent.

Everything below is meant to be followed top to bottom on a machine that has nothing on it yet.

---

## The one thing that will break your deployment

**`PUBLIC_ORIGIN` must exactly equal the origin you type into the browser — and its hostname is
permanent.**

The API derives the WebAuthn relying-party ID from it: the hostname, `budget.tail1234.ts.net`. If
the two disagree — `https://` vs `http://`, `budget.tail1234.ts.net` vs `budget-1.tail1234.ts.net`,
the tailnet name vs `localhost` — passkey registration **fails silently**: the browser prompts, you
touch the key, and the request is rejected with a security error that names nothing useful. It is
by a wide margin the most likely thing to go wrong here, and it looks like a broken app rather than
a config typo.

Every passkey is bound to that RP ID for good. Renaming the machine, or the tailnet, changes the
hostname and **invalidates every passkey registered so far**: everyone re-enrols through the
recovery path in [Operating notes](#operating-notes). So the machine's final name is chosen in step
1, before anyone registers anything.

Set it once, exactly, and never guess at it:

```sh
tailscale status --json | jq -r '.Self.DNSName'   # -> budget.tail1234.ts.net.
# PUBLIC_ORIGIN=https://budget.tail1234.ts.net    (no trailing dot)
```

The API checks the shape at startup — `https://`, nothing after the hostname, no trailing dot — and
refuses to start otherwise, naming the bad value. It then reports the RP ID it derived: once in its
log at startup, and as `rpId` and `origin` in `GET /health`. What nothing can check is whether that
matches your address bar. That comparison is on you.

---

## 1. Prerequisites on the host

Debian/Ubuntu; adapt for your distro.

```sh
sudo apt-get update && sudo apt-get install -y git curl jq

# Docker Engine + the compose plugin (NOT docker.io from the distro repos — it ships
# a compose v1 that does not understand this project's compose file).
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"     # log out and back in

# Tailscale. --hostname is the machine's FINAL name: see the top of this page.
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname budget

docker --version && docker compose version && tailscale status
```

Then, once, in the Tailscale admin console:

- **DNS → enable MagicDNS, and enable HTTPS Certificates.** `tailscale serve --https` needs both:
  without them there is no `*.ts.net` name to serve on and no certificate to serve it with.
- **Machines → this machine → Disable key expiry.** Node keys expire after 180 days by default.
  When this one does, the machine drops off the tailnet and the app is unreachable until someone
  re-authenticates it from a keyboard on the box.
- **Settle the names now.** The machine name (above, or Machines → Edit machine name) and the
  tailnet name (DNS → Tailnet name) together make the hostname every passkey is bound to. Rename
  either after step 6 and every passkey stops working.

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
| `PUBLIC_ORIGIN` | **`https://<your-host>.ts.net`** — see the warning above |
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
   container.

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
  "rpId": "budget.tail1234.ts.net",
  "origin": "https://budget.tail1234.ts.net",
  "migrations": { "applied": 13, "expected": 13, "latest": "0012_sleepy_shard",
                  "expectedLatest": "0012_sleepy_shard", "pending": 0 }
}
```

`rpId` and `origin` are what passkeys will be registered against. If they aren't the address you
will type into the browser, stop and fix `PUBLIC_ORIGIN` now, while no passkey depends on it.

`ok` is false and the endpoint returns **503** when the database is unreachable *or* when
`pending > 0` — a running app whose migrations are behind its code fails in ways that are far
harder to read from the symptom than from here. If you ever see `pending > 0`, you started the api
without the `migrate` service; bring the stack up again with the compose file rather than
`docker compose up api`.

---

## 5. Expose it on the tailnet

`tailscale serve` terminates HTTPS with a tailnet certificate and forwards to the web container.
Nothing is published to the public internet; `tailscale funnel` is the command that would do that
and is deliberately not used here.

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
sudo tailscale serve status
```

That prints the hostname the app now answers on:

```
https://budget.tail1234.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8080
```

**Now go back and check `PUBLIC_ORIGIN` matches that hostname exactly.** If you had to change it:

```sh
APP_VERSION=$(git rev-parse --short HEAD) docker compose -f infra/docker-compose.yml up -d api
curl -s localhost:3001/health | jq '.rpId, .origin'
```

(Environment changes need the container recreated. A restart alone keeps the old environment.
`web` needs nothing: nginx re-resolves the api container's address on its own.)

---

## 6. First run: register the first passkey

Open `https://<your-host>.ts.net` on the device you want to sign in from — a phone is the usual
choice, since that is where the app is used most.

The `users` table is empty on a fresh database, so the app shows a **bootstrap** screen instead of
a login form. Enter a display name, register a passkey, and you are the first user.

From then on, other people and other devices come from **Admin → Users → Invite a user**, which
mints a single-use link that expires in 24 hours.

If the passkey prompt appears and then fails: it is `PUBLIC_ORIGIN`. It is essentially always
`PUBLIC_ORIGIN`.

### Then, straight away: set the recovery password

Passkeys are the way in, and there is exactly one password in this app, for when they are all gone.
Set it now, while you have a passkey session to set it with: **Admin → My devices → Recovery
password**, at least 16 characters. The household has one, held by one user; setting, replacing or
removing it needs a passkey sign-in.

It is deliberately weak as a key. On the sign-in screen it opens a session that lasts an hour and
reaches one screen: mint a new-device link for someone in the household, remove a lost passkey,
revoke sessions. It can't see or change a single figure, so a phished copy buys an attacker nothing
but the ability to ask for a passkey. Keep it somewhere that isn't this app — a password manager, or
paper.

Without it, getting back in after losing every passkey needs a shell on this box (see Operating
notes).

---

## 7. Load the household's data

**Not yet, if this is the real household's data.** Until in-app backups ship there are none at all
(see [Backups](#backups)), so a dead disk loses everything.

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

Backups are taken by the app itself (**Admin → Backups**), which arrives in phase C of
[`../.claude/plans/pre-deploy-plan.md`](../.claude/plans/pre-deploy-plan.md). Until it ships there
are **no backups at all** — so don't put real data on this box before phase C is deployed.

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
loopback (`127.0.0.1`), so nothing on the LAN can reach either directly. `tailscale serve` is what
makes 8080 reachable from other devices; nothing makes 3001 reachable off the host — it is published
only so `curl localhost:3001/health` works here. Postgres publishes nothing at all;
`docker-compose.dev.yml` exists solely to add a published 5432 for local development and must never
be merged in on this host.

### Recovering when every passkey is gone

There are no recovery codes to lose and no email reset. There are two ways back in.

**The recovery password**, if it was set (step 6): on the sign-in screen, sign in with it, and the
one screen it opens mints a new-device link. Open that link on the device you're recovering with
and register a passkey there.

**A shell on this box**, which works whether or not the password was set, or remembered:

```sh
docker compose -f infra/docker-compose.yml exec api node dist/scripts/auth-invite.js --user "Lachlan" --purpose new_device
```

`--user` is the display name, exactly. It prints a fresh invite link — open it on whatever device
you're recovering with — and writes an `audit_log` entry with no actor, so it can be told apart from
an invite minted by a signed-in user. The invite is single-use and expires after 24 hours, the same
as one minted from Admin → Users. `--purpose new_user`, with no `--user`, mints an invite for a new
member of the household instead.

(The image has no pnpm and no source tree, so the dev-only `pnpm auth:invite` doesn't exist there.
`dist/scripts/auth-invite.js` is the same script, bundled.)

If the `users` table is empty — a fresh volume, say — there is nothing to recover: open the app and
it shows the bootstrap screen again, no shell needed. Whoever completes it first becomes the first
user, which is one more reason the app is reachable from the tailnet only.

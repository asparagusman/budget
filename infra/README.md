# Deploying budget

One household, two people, one Linux thin client on a Tailscale tailnet. No public ingress, no CI,
no monitoring stack — see [`../.claude/plans/phases/11-polish-mobile-import.md`](../.claude/plans/phases/11-polish-mobile-import.md)
"Non-goals" for why each of those is deliberately absent.

Everything below is meant to be followed top to bottom on a machine that has nothing on it yet.

---

## The one thing that will break your deployment

**`PUBLIC_ORIGIN` must exactly equal the origin you type into the browser.**

The API derives the WebAuthn relying-party ID from it. If they disagree — `https://` vs `http://`,
a trailing slash, `budget.tail1234.ts.net` vs `budget.tail1234.ts.net:443`, the tailnet name vs
`localhost` — passkey registration **fails silently**: the browser prompts, you touch the key, and
the request is rejected with a security error that names nothing useful. It is by a wide margin the
most likely thing to go wrong here, and it looks like a broken app rather than a config typo.

Set it once, exactly, and never guess at it:

```sh
tailscale status --json | jq -r '.Self.DNSName'   # -> budget.tail1234.ts.net.
# PUBLIC_ORIGIN=https://budget.tail1234.ts.net    (no trailing dot, no trailing slash)
```

`GET /health` does not check this. Nothing does. It is on you.

---

## 1. Prerequisites on the host

Debian/Ubuntu; adapt for your distro.

```sh
# Docker Engine + the compose plugin (NOT docker.io from the distro repos — it ships
# a compose v1 that does not understand this project's compose file).
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"     # log out and back in

# Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

docker --version && docker compose version && tailscale status
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
```

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
| `APP_VERSION` | optional; `git rev-parse --short HEAD` is a good habit, and `GET /health` reports it back |

The api container builds its own `DATABASE_URL` from `POSTGRES_*` at the compose network's `db`
hostname, so the `DATABASE_URL` in `.env` never reaches it. That separation is deliberate: host
tooling talks to a published port, containers talk to each other.

---

## 4. Start the stack

```sh
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
```

Four services, in this order, enforced by compose rather than by you remembering:

1. **`db`** — Postgres 16. No published port: it is reachable only on the compose network.
2. **`migrate`** — a one-shot container on the api image that applies pending migrations and exits.
   `api` waits for it to exit **successfully**, so the app can never start against a schema older
   than its own code.
3. **`api`** — Hono on `${PORT}`.
4. **`web`** — nginx serving the built SPA on `8080`, proxying `/api/` to the api container.

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
  "migrations": { "applied": 9, "expected": 9, "latest": "0008_demonic_spirit",
                  "expectedLatest": "0008_demonic_spirit", "pending": 0 }
}
```

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
docker compose --env-file .env -f infra/docker-compose.yml up -d api
```

(Environment changes need the container recreated. A restart alone keeps the old environment.)

---

## 6. First run: register the first passkey

Open `https://<your-host>.ts.net` on the device you want to sign in from — a phone is the usual
choice, since that is where the app is used most.

The `users` table is empty on a fresh database, so the app shows a **bootstrap** screen instead of
a login form. Enter a display name, register a passkey, and you are the first user. There is no
password anywhere in this app and no way to add one.

From then on, other people and other devices come from **Settings → Users → Invite**, which mints a
single-use link that expires in 24 hours.

If the passkey prompt appears and then fails: it is `PUBLIC_ORIGIN`. It is essentially always
`PUBLIC_ORIGIN`.

---

## 7. Load the household's data

Either enter it by hand, or use the importer:

**Settings → Import spreadsheet** takes the old `.xlsx`, shows every row it found grouped by what
it will become, lets you deselect any of them, and writes nothing until you confirm. Re-importing
the same file updates rather than duplicating, so a mistake in the mapping step is fixable by
importing again. See the reconciliation summary it prints afterwards: every figure the spreadsheet
held, beside what the app now computes.

---

## Updating

Order matters, and three of the four steps are done for you:

```sh
cd budget
git pull                                                              # 1. pull
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
#                                                                     # 2. rebuild
#                                                                     # 3. migrate  (the one-shot
#                                                                     #    `migrate` service)
#                                                                     # 4. restart  (api waits for
#                                                                     #    migrate to exit 0)
curl -s localhost:3001/health | jq '.version, .migrations'
```

`--build` is not optional. Without it compose happily reuses the image it already has and serves
the code you had before the pull, which then looks like "the fix didn't work".

If a migration fails, the `migrate` container exits non-zero, `api` never starts, and the previous
`api` container stays up **on the old image** — the stack refuses to half-upgrade. Read the failure
with `docker compose -f infra/docker-compose.yml logs migrate`, fix it, and run the same command
again.

---

## Backups

Set them up now, not later: [`backup/README.md`](backup/README.md). It covers what is backed up,
how to verify a backup is decryptable without restoring it, and a restore procedure that has been
run rather than assumed.

---

## Operating notes

**Logs.** `docker compose -f infra/docker-compose.yml logs -f api`. The API logs method, path,
status and duration — never request bodies, because those carry the household's financial figures.
Do not add body logging.

**Health.** `GET /health` is the whole of this app's observability, alongside those request logs.
That is a deliberate choice for a two-user household app; an observability stack here would be cost
without benefit. If you want an alert, a cron entry that curls `/health` and mails you on non-200
is proportionate.

**Database shell.**

```sh
docker compose -f infra/docker-compose.yml exec db psql -U budget -d budget
```

**Recovering when every passkey is gone.** You have shell on the box, which is the recovery path:

```sh
docker compose -f infra/docker-compose.yml exec api pnpm auth:invite --user "Lachlan" --purpose new_device
```

It prints a fresh single-use invite link. See [`backup/README.md`](backup/README.md#recovery--losing-every-passkey)
for the details, including what happens if the `users` table itself is empty.

**Ports.** Only `web` (8080) and `api` (3001) publish anything, both to the host only —
`tailscale serve` is what makes 8080 reachable from other devices, and nothing makes 3001
reachable. Postgres publishes nothing at all; `docker-compose.dev.yml` exists solely to add a
published 5432 for local development and must never be merged in on this host.

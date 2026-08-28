# Backups

`backup.sh` runs `pg_dump | gzip | age -r $BACKUP_AGE_RECIPIENT`, writing an encrypted
`budget-YYYYMMDD-HHMMSS.sql.gz.age` into `/backups`, then prunes anything older than
`RETAIN_DAYS` (default 30). It exits non-zero on any failure — treat a non-zero exit
from this script as a page-worthy event, not a log line to skim later.

It runs as a one-shot container on the `budget` compose network (see `networks.default.name`
in `../docker-compose.yml`), not as a long-running service — it isn't one of the four
services in the base compose file.

| | |
|---|---|
| **What** | The whole `budget` database: every table, every row. Nothing else — the app keeps no uploaded files, and the container images rebuild from the repo. |
| **Where** | `/backups` inside the container, which you bind-mount to a real directory on the host. Put that directory somewhere the host's own backup or a synced drive also picks up: a backup that only exists on the machine it backs up is not one. |
| **Encryption** | `age`, to a public recipient. The private identity must live somewhere else entirely — see below. |
| **Retention** | `RETAIN_DAYS`, default 30. Older files are deleted, and their names are printed as they go. |

## Build the image

```sh
docker build -t budget-backup infra/backup
```

## Generate the key pair

Once, on a machine that is **not** this host:

```sh
age-keygen -o backup-key.txt
# Public key: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
```

`backup-key.txt` is the private identity and the only thing that can decrypt a backup. Keep it off
this host entirely — a host whose disk holds both the backups and the key to them has encrypted
nothing. The `age1...` public line is what goes in `BACKUP_AGE_RECIPIENT`, and it is not a secret.

If you lose the identity file, every backup you hold is permanently unreadable. There is no
recovery, by design.

## Run a backup manually

```sh
docker run --rm \
  --network budget \
  -e DATABASE_URL="postgres://budget:<password>@db:5432/budget" \
  -e BACKUP_AGE_RECIPIENT="age1..." \
  -v /path/on/host/backups:/backups \
  budget-backup
```

## Schedule it

One-shot container, so scheduling is a host cron entry, not a compose service:

```cron
0 3 * * * docker run --rm --network budget \
  -e DATABASE_URL="postgres://budget:<password>@db:5432/budget" \
  -e BACKUP_AGE_RECIPIENT="age1..." \
  -v /path/on/host/backups:/backups \
  budget-backup >> /var/log/budget-backup.log 2>&1
```

---

## Verify a backup without restoring it

Do this monthly. It takes seconds, needs no scratch database, and catches the two failure modes
that actually happen: a backup encrypted to a recipient whose identity you no longer have, and a
truncated file from a disk that filled up mid-dump.

```sh
docker run --rm \
  -e BACKUP=budget-20260101-030000.sql.gz.age \
  -v /path/on/host/backups:/backups \
  -v /path/to/backup-key.txt:/key.txt:ro \
  --entrypoint sh budget-backup -c '
    set -e
    age -d -i /key.txt "/backups/$BACKUP" | gunzip > /tmp/dump.sql
    head -2 /tmp/dump.sql
    grep -q "^-- PostgreSQL database dump complete$" /tmp/dump.sql \
      && echo "complete: yes ($(wc -c < /tmp/dump.sql) bytes)" \
      || { echo "TRUNCATED - this backup is not usable"; exit 1; }
  '
```

On a good backup that prints pg_dump's banner and `complete: yes (91893 bytes)` and exits 0; on a
file truncated at 9kB it prints `failed to decrypt and authenticate payload chunk` and exits 1.
Both were verified against this repo's own database.

The plaintext lands in `/tmp` **inside the container**, which `--rm` destroys on exit; it never
touches the host. Streaming it instead is tempting and wrong: `… | tee >(head -c 200) | tail -c 200`
looks like it reads the whole file, but `head` closes the pipe after 200 bytes and SIGPIPEs
everything upstream, so the check quietly passes on a file it only read the first page of.

You are checking three things, and all three must hold:

1. **`age` exits 0.** If it errors with "no identity matched any of the recipients", that file was
   encrypted to a key you no longer hold. Every backup after it is probably the same.
2. **The head reads `-- PostgreSQL database dump`.** That is pg_dump's own banner; anything else
   means the file is not what you think it is.
3. **`complete: yes`.** pg_dump writes `-- PostgreSQL database dump complete` at the very end, so
   its presence proves the dump ran to completion and gzip closed the stream cleanly. A backup
   truncated mid-write decrypts and un-gzips happily right up until it doesn't — this is the line
   that catches it.

A full restore drill (below) is worth doing once or twice a year on top of this. The monthly check
is what stops a year of silently unusable backups.

---

## Restore

**This procedure has been run, not assumed** — into a scratch database, with the app started
against it, exactly as written here. The run it is transcribed from restored 24 bills, 82
allocation lines and 9 applied migrations, and `GET /health` on the app pointed at the result
reported `pending: 0`.

### Into a scratch database (the drill, and the safe way to inspect a backup)

```sh
# 1. Create an empty database beside the real one.
docker compose -f infra/docker-compose.yml exec db \
  createdb -U budget budget_restore_test

# 2. Decrypt, decompress, and load. `--set ON_ERROR_STOP=1` matters: without it
#    psql reports a failed statement and carries on, and you end up with a
#    half-restored database that looks like it worked.
docker run --rm -i \
  -v /path/on/host/backups:/backups \
  -v /path/to/backup-key.txt:/key.txt:ro \
  --entrypoint sh budget-backup -c \
  'age -d -i /key.txt /backups/budget-20260101-030000.sql.gz.age | gunzip' \
  | docker compose -f infra/docker-compose.yml exec -T db \
    psql -U budget -d budget_restore_test --set ON_ERROR_STOP=1 -q

# 3. Sanity-check the contents.
docker compose -f infra/docker-compose.yml exec db psql -U budget -d budget_restore_test \
  -c 'select count(*) as bills from bills' \
  -c 'select count(*) as users from users' \
  -c 'select count(*) as migrations from drizzle.__drizzle_migrations'

# 4. Start the app against it and read its own health check. This is the step
#    that makes it a restore rather than a file copy: /health reports whether
#    the restored schema matches the running code's migrations.
docker run --rm --network budget \
  -e DATABASE_URL="postgres://budget:<password>@db:5432/budget_restore_test" \
  -e SESSION_SECRET="$(openssl rand -base64 48)" \
  -e PUBLIC_ORIGIN="http://localhost:3001" \
  -e PORT=3001 \
  -p 3002:3001 \
  infra-api node dist/index.js &
curl -s localhost:3002/health | jq
#  -> { "ok": true, "db": true, "migrations": { "pending": 0, ... } }

# 5. Tear the scratch database down.
docker compose -f infra/docker-compose.yml exec db dropdb -U budget budget_restore_test
```

`pending: 0` in step 4 is the whole point: it says the restored database is at the migration
version this build of the app expects. A restore that loads without error but lands two migrations
behind is a restore that will break on first write.

### Over the real database

Restoring into a database that already has data conflicts on every primary key. Drop and recreate
first — and take a fresh backup before you do, because this is the one irreversible step in this
document:

```sh
docker compose -f infra/docker-compose.yml stop api web
docker compose -f infra/docker-compose.yml exec db dropdb -U budget budget
docker compose -f infra/docker-compose.yml exec db createdb -U budget budget
# ...then the same decrypt-and-load pipeline as step 2 above, targeting `budget`.
docker compose --env-file .env -f infra/docker-compose.yml up -d
```

`api` and `web` are stopped first so nothing writes to a database that is being replaced under it.

---

## Recovery — losing every passkey

There are no recovery codes to lose, and no email-based reset. The operator has shell
access to the box, so recovery is a single CLI command run inside the running `api`
container:

```sh
docker compose -f infra/docker-compose.yml exec api pnpm auth:invite --user "Lachlan" --purpose new_device
```

It prints a fresh invite link (open it on whatever device you're recovering with) and
writes an `audit_log` entry with `createdBy: null`, so it's distinguishable from an invite
minted by a logged-in user. The invite is single-use and expires after 24 hours, same as
one minted from Settings → Users.

To recover the very first user's access when the `users` table itself is somehow empty
again (e.g. a restore from a backup taken before bootstrap), just visit the app — it
detects the empty table and shows the bootstrap screen again, no CLI needed.

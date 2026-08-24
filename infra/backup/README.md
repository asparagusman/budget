# Backups

`backup.sh` runs `pg_dump | gzip | age -r $BACKUP_AGE_RECIPIENT`, writing an encrypted
`budget-YYYYMMDD-HHMMSS.sql.gz.age` into `/backups`, then prunes anything older than
`RETAIN_DAYS` (default 30). It exits non-zero on any failure — treat a non-zero exit
from this script as a page-worthy event, not a log line to skim later.

It runs as a one-shot container on the `budget` compose network (see `networks.default.name`
in `../docker-compose.yml`), not as a long-running service — it isn't one of the three
services in the base compose file.

## Build the image

```sh
docker build -t budget-backup infra/backup
```

## Run a backup manually

```sh
docker run --rm \
  --network budget \
  -e DATABASE_URL="postgres://budget:<password>@db:5432/budget" \
  -e BACKUP_AGE_RECIPIENT="age1..." \
  -v /path/on/host/backups:/backups \
  budget-backup
```

`BACKUP_AGE_RECIPIENT` is the **public** age recipient (`age1...`), generated once with
`age-keygen -o backup-key.txt` — keep `backup-key.txt` (the private identity) off this
host entirely; it's only needed to restore.

## Schedule it

One-shot container, so scheduling is a host cron entry, not a compose service:

```cron
0 3 * * * docker run --rm --network budget \
  -e DATABASE_URL="postgres://budget:<password>@db:5432/budget" \
  -e BACKUP_AGE_RECIPIENT="age1..." \
  -v /path/on/host/backups:/backups \
  budget-backup >> /var/log/budget-backup.log 2>&1
```

## Restore — tested command

An untested restore path is not a backup. This is the exact command, decrypting with the
private identity file generated above and piping straight into `psql` inside the running
`db` container:

```sh
age -d -i backup-key.txt /path/on/host/backups/budget-20260101-030000.sql.gz.age \
  | gunzip \
  | docker exec -i $(docker compose -f infra/docker-compose.yml ps -q db) \
    psql -U budget -d budget
```

Restoring into a fresh/empty database is the normal case. Restoring on top of an existing
one will conflict on primary keys — drop and recreate the `budget` database first, or
restore into a scratch database and reconcile by hand.

## Recovery — losing every passkey

There are no recovery codes to lose, and no email-based reset. The operator has shell
access to the box, so recovery is a single CLI command run inside the running `api`
container:

```sh
docker compose exec api pnpm auth:invite --user "Lachlan" --purpose new_device
```

It prints a fresh invite link (open it on whatever device you're recovering with) and
writes an `audit_log` entry with `createdBy: null`, so it's distinguishable from an invite
minted by a logged-in user. The invite is single-use and expires after 24 hours, same as
one minted from Settings → Users.

To recover the very first user's access when the `users` table itself is somehow empty
again (e.g. a restore from a backup taken before bootstrap), just visit the app — it
detects the empty table and shows the bootstrap screen again, no CLI needed.

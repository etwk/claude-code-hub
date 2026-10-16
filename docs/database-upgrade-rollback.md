# Database-safe upgrade and rollback

An application image rollback is not a database rollback. Migrations can add or replace
triggers, functions, constraints and data; starting an older image does not reverse them.
Do not apply an old SQL dump on top of an upgraded database.

## Before upgrading

1. Pause incoming requests and stop **all CCH application replicas and other writers**.
   Leave PostgreSQL running. Disable automatic restart/scaling that could start a writer.
2. Record the previous image, Compose/manifests, environment, secret mounts and encryption
   keys. Preserve the actual previous image locally; a moving tag is not a rollback artifact.
   Store backups with restricted permissions and copy them off-host before proceeding.
3. Take a complete PostgreSQL custom-format dump without compression, verify that its TOC
   can be read, and rehearse a full restore into a **new, empty database**. Preserve database
   ownership/role grants separately if the installation uses more than its application role.
4. Capture Redis at the same quiescent application boundary. Run `SAVE`, stop the dedicated
   Redis instance, and copy its entire persistent data directory, including AOF files when
   enabled. Preserve its image, startup flags and configuration. If Redis is shared, arrange
   an isolated CCH restore instead of stopping or replacing unrelated applications' data.
5. Keep the pre-upgrade backup immutable. Record request/ledger counts and configuration
   fingerprints, and define whether rollback may discard requests accepted after upgrade.

For the repository's default Compose service names, this captures the frozen state.
Run from the deployment root in Bash; adjust the service names for the actual installation.
The Redis command assumes the default unauthenticated dedicated instance; authenticated
installations must use their existing secure authentication mechanism without printing secrets.

```bash
set -euo pipefail
umask 077
APP=app
PG=postgres
REDIS=redis
backup_dir="$PWD/backups/pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir/redis"

docker compose stop "$APP"
docker compose config > "$backup_dir/compose.effective.yml"
docker compose images "$APP" > "$backup_dir/application-images.txt"
docker compose exec -T "$PG" sh -eu -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z0 --no-owner --no-privileges' \
  > "$backup_dir/database.dump"
docker compose exec -T "$PG" pg_restore --list \
  < "$backup_dir/database.dump" > "$backup_dir/database.toc"

docker compose exec -T "$REDIS" redis-cli SAVE
docker compose stop "$REDIS"
redis_container="$(docker compose ps -aq "$REDIS")"
docker cp "$redis_container:/data/." "$backup_dir/redis/"
```

The effective Compose file may contain secrets. It does **not** include the contents of
referenced environment, configuration or secret files: copy those securely, together with
the encryption key, and retain the original mounts. Do not publish the dump or fingerprints
of secret-bearing rows. A readable dump TOC is not proof of restorability; complete the
fresh-database rehearsal before upgrading. Start Redis again before starting the candidate.
If any backup/restore check fails, leave ingress paused; do not continue the upgrade.

## Roll back after an attempted upgrade

1. Pause ingress again and stop every candidate application replica/writer. Take a separate
   dump of the **post-upgrade** database and freeze its Redis state before replacing anything.
   Keep the upgraded database and its data intact for investigation and reconciliation.
2. Restore the immutable pre-upgrade dump into a newly named, empty database with
   `pg_restore --exit-on-error`. Do not run `--clean` against the upgraded database.
3. Restore the matching Redis snapshot into a separate dedicated Redis instance/volume,
   using the saved Redis image/configuration. Do not combine a restored PostgreSQL snapshot
   with newer cached users/providers, sessions, rate limits or spend counters.
4. Configure the saved old application image to use the restored database and Redis while
   preserving its original encryption key, credentials, configuration and secret mounts.
   Do not run the candidate migration command or a deployment helper that selects latest.
5. Start one isolated old-image replica without public ingress. Verify migrations, users,
   API keys, providers, settings and pre-upgrade request/usage history against the snapshot.
   Exercise a real authenticated request through a safe local upstream and verify its stored
   request and accounting result. Health HTTP 200 alone is not sufficient.
6. Restore normal replicas/ingress only after those checks. Keep both database copies until
   post-upgrade requests have been reconciled and the rollback is accepted.

A restore command for the default Compose PostgreSQL service:

```bash
set -euo pipefail
PG=postgres
restore_db="claude_code_hub_restored_$(date -u +%Y%m%dT%H%M%SZ)"
# backup_dir is the immutable pre-upgrade directory captured above.
docker compose exec -T "$PG" sh -eu -c \
  'createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$1"' sh "$restore_db"
docker compose exec -T "$PG" sh -eu -c \
  'pg_restore -U "$POSTGRES_USER" -d "$1" --exit-on-error --no-owner --no-privileges' \
  sh "$restore_db" < "$backup_dir/database.dump"
```

Switch the old application's DSN explicitly to `restore_db`; never rename/drop the upgraded
production database as part of this procedure. Kubernetes `rollout undo` likewise restores
only an application revision, so it needs the same database/Redis cutover and verification.

## Post-upgrade traffic is a separate recovery decision

Restoring a snapshot necessarily excludes later requests, usage ledger entries and admin
changes. Preserving the upgraded database makes those records recoverable, but does not
merge them into the old schema. If loss of that interval is unacceptable, keep ingress paused
and reconcile using an explicitly validated export/import plan before reopening; do not
claim a lossless rollback or blindly replay billing rows/triggers.

## Local rehearsal evidence for this candidate

The rollout assessment uses disposable PostgreSQL 18 and Redis 7 instances and a local
Responses upstream. It establishes an old-image `v0.8.11` request/accounting baseline,
freezes a database/Redis snapshot, upgrades only the disposable database, then restores the
snapshot into a fresh database and starts the unchanged old image against restored state.
This validates the procedure for the exercised schema/images; it is not a production backup
or a guarantee that post-snapshot traffic can be restored without reconciliation.

# Media Manager

A small, isolated web UI for moving downloaded movies into the media library safely.

## Start

```bash
cp .env.example .env
# Edit .env and replace POSTGRES_PASSWORD.
docker compose up -d --build
```

Open `http://SERVER_IP:5687`.

This compose project uses only port **5687**, its own `media-manager` / `media-manager-db`
container names, its own Postgres volume, and an internal database network. It will not use
or modify the existing movie application's containers or database.

## Safe move behavior

For every selected file the app first creates a database record, copies the file to a temporary
destination name, compares SHA-256 checksums, atomically renames the verified copy into place,
and then removes the source. Each transition is logged in PostgreSQL.

If power or Docker stops during the copy, the source remains. If it stops after verification but
before cleanup, the source remains and the record is shown as **Needs cleanup** on the Moved tab;
using **Retry cleanup** safely deletes it only after the destination checksum matches. Errors stay
in the audit log for investigation. Existing destination files are never overwritten.

## Optimise Library

The Optimise Library page lists every regular file in `/mnt/resources/media/movies/Movies` in two
tabs. Video files at 720p or below are **Already optimised**; videos above 720p are **Not
optimised** and can be added to the queue.

The separate `media-manager-worker` container processes one queued video at a time with FFmpeg:
it atomically renames `movie.mkv` to `movie.unoptimised.mkv`, creates a 720p H.264 (4000 kbps)
replacement, verifies the codec and resolution, atomically restores the replacement as
`movie.mkv`, then removes the backup. A failure preserves the original backup, and the UI offers
safe retry. Successful jobs leave no temporary or `.unoptimised` file behind.

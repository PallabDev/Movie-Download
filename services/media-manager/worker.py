"""Single durable FFmpeg queue worker. It never deletes the preserved backup before verification."""
import os
import subprocess
import time
from pathlib import Path

from app import DATABASE_URL, db, init_db, media_info, is_optimised, OPTIMISE_DIR


def event(conn, job_id, name, details=None):
    conn.execute("INSERT INTO optimisation_events (job_id,event,details) VALUES (%s,%s,%s)",
                 (job_id, name, details))


def mark(job_id, status, error=None, **fields):
    assignments = ["status=%s", "error=%s"]
    values = [status, error]
    for key, value in fields.items():
        if value == "__now__":
            assignments.append(f"{key}=now()")
        else:
            assignments.append(f"{key}=%s")
            values.append(value)
    values.append(job_id)
    with db() as conn:
        conn.execute(f"UPDATE optimisation_jobs SET {', '.join(assignments)} WHERE id=%s", values)
        event(conn, job_id, status, error)


def verified_output(path):
    info = media_info(path)
    return path.is_file() and path.stat().st_size > 0 and info["video"] and info["codec"] == "h264" and (info["height"] or 99999) <= 720


def set_progress(job_id, value):
    with db() as conn:
        conn.execute("UPDATE optimisation_jobs SET progress=%s WHERE id=%s", (round(min(99.0, max(0.0, value)), 1), job_id))


def complete_cleanup(job):
    source, backup = Path(job["source_path"]), Path(job["backup_path"])
    # The source is already verified H.264/720p before the backup can be removed.
    if not source.exists() or not verified_output(source):
        raise RuntimeError("Refusing cleanup: final output is not verified 720p H.264")
    if backup.exists():
        backup.unlink()
    mark(job["id"], "completed", None, completed_at="__now__", progress=100)
    try:
        info = media_info(source)
        st = source.stat()
        candidate = {"path": source, **info}
        optimised = is_optimised(candidate)
        try:
            rel_path = str(source.relative_to(OPTIMISE_DIR))
        except Exception:
            rel_path = source.name
        with db() as conn:
            conn.execute("""
                INSERT INTO media_file_cache
                    (path, relative_path, size, mtime, is_video, codec, width, height, duration, is_optimised, scanned_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (path) DO UPDATE SET
                    relative_path = EXCLUDED.relative_path,
                    size = EXCLUDED.size,
                    mtime = EXCLUDED.mtime,
                    is_video = EXCLUDED.is_video,
                    codec = EXCLUDED.codec,
                    width = EXCLUDED.width,
                    height = EXCLUDED.height,
                    duration = EXCLUDED.duration,
                    is_optimised = EXCLUDED.is_optimised,
                    scanned_at = now()
            """, (str(source), rel_path, st.st_size, st.st_mtime, info["video"], info["codec"], info["width"], info["height"], info["duration"], optimised))
    except Exception as e:
        print(f"[Worker] Warning: could not update media cache: {e}")


def process(job):
    job_id = job["id"]
    source, backup, temporary = Path(job["source_path"]), Path(job["backup_path"]), Path(job["temporary_path"])
    try:
        # Recover after a crash that happened after replacing final output but before DB update.
        if source.exists() and backup.exists() and verified_output(source):
            mark(job_id, "verified", None, verified_at="__now__")
            complete_cleanup(job)
            return
        # A verified checkpoint means only backup cleanup remains. It is safe to retry indefinitely.
        if job["status"] == "verified":
            complete_cleanup(job)
            return
        # Rename is atomic. If it already happened before a power loss, resume from backup.
        if source.exists() and not backup.exists():
            os.replace(source, backup)
            mark(job_id, "renamed")
        elif not source.exists() and backup.exists():
            mark(job_id, "renamed")
        elif source.exists() and backup.exists():
            raise RuntimeError("Both original and backup exist; refusing to choose one")
        else:
            raise RuntimeError("Neither original nor backup exists; source is protected from further action")

        # Old partial output is disposable and never the preserved original.
        temporary.unlink(missing_ok=True)

        # Pure Dynamic Constant Rate Factor (CRF) 720p H.264 Encoding:
        # - Pure CRF 22 + -tune film: Fully dynamic bit allocation frame-by-frame.
        #   * Simple/dialogue scenes drop to ~500–900 kbps to save massive storage.
        #   * Action/complex scenes dynamically receive bits only when human eye needs them.
        # - No fixed maxrate cap: Encoder has full freedom to minimize size without quality loss.
        # - Preset medium: Enhanced Trellis quantization & CABAC for 8–12% smaller size at identical visual quality.
        # - 128k Stereo AAC: Clean dialogue and rich sound in minimal storage.
        # - movflags +faststart: Instant streaming without buffering.
        command = [
            "ffmpeg", "-nostdin", "-y", "-i", str(backup),
            "-map", "0:v:0", "-map", "0:a?", "-map", "0:s?",
            "-vf", "scale=-2:720:flags=lanczos:force_original_aspect_ratio=decrease",
            "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-tune", "film",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-ac", "2",
            "-c:s", "copy",
            "-threads", "0",
            "-movflags", "+faststart",
            "-progress", "pipe:1", "-nostats", str(temporary),
        ]
        process_cmd = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1
        )
        duration = float(job.get("duration_seconds") or 0)
        last_progress = -1

        # Read progress from stdout
        for line in process_cmd.stdout:
            if line.startswith("out_time_ms=") and duration:
                try:
                    progress = int(line.split("=", 1)[1]) / 1_000_000 / duration * 100
                    if progress - last_progress >= 0.5:
                        with db() as conn:
                            exists = conn.execute("SELECT id FROM optimisation_jobs WHERE id=%s", (job_id,)).fetchone()
                            if not exists:
                                print(f"[Worker] Job {job_id} was removed/cancelled. Aborting FFmpeg.")
                                process_cmd.terminate()
                                try:
                                    process_cmd.wait(timeout=2)
                                except Exception:
                                    process_cmd.kill()
                                temporary.unlink(missing_ok=True)
                                if backup.exists() and not source.exists():
                                    try:
                                        os.replace(backup, source)
                                    except Exception:
                                        pass
                                return
                        set_progress(job_id, progress)
                        last_progress = progress
                except ValueError:
                    pass

        _, stderr_output = process_cmd.communicate()
        if process_cmd.returncode != 0:
            err_snippet = (stderr_output or "").strip().split("\n")[-3:]
            raise RuntimeError(f"FFmpeg failed: {' '.join(err_snippet) or 'Unknown error'}")

        if not verified_output(temporary):
            raise RuntimeError("FFmpeg output did not verify as H.264 at 720p or lower")

        original_size = backup.stat().st_size
        output_size = temporary.stat().st_size
        info = media_info(temporary)

        # CRITICAL SAFEGUARD:
        # If transcoded output is equal or larger than original, keep the original smaller file!
        if output_size >= original_size:
            print(f"[Worker] Transcoded file ({output_size} B) is not smaller than original ({original_size} B). Preserving original.")
            temporary.unlink(missing_ok=True)
            if backup.exists() and not source.exists():
                os.replace(backup, source)
            mark(job_id, "completed", "Original file was already smaller than 720p transcode. Original preserved.",
                 completed_at="__now__", progress=100, output_size=original_size, output_height=info["height"])
            # Update cache to mark as optimised
            try:
                st = source.stat()
                src_info = media_info(source)
                rel_path = str(source.relative_to(OPTIMISE_DIR))
            except Exception:
                st = None
                rel_path = source.name
            if st:
                with db() as conn:
                    conn.execute("""
                        INSERT INTO media_file_cache
                            (path, relative_path, size, mtime, is_video, codec, width, height, duration, is_optimised, scanned_at)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                        ON CONFLICT (path) DO UPDATE SET
                            relative_path = EXCLUDED.relative_path,
                            size = EXCLUDED.size,
                            mtime = EXCLUDED.mtime,
                            is_video = EXCLUDED.is_video,
                            codec = EXCLUDED.codec,
                            width = EXCLUDED.width,
                            height = EXCLUDED.height,
                            duration = EXCLUDED.duration,
                            is_optimised = true,
                            scanned_at = now()
                    """, (str(source), rel_path, st.st_size, st.st_mtime, src_info["video"], src_info["codec"], src_info["width"], src_info["height"], src_info["duration"]))
            return

        mark(job_id, "output_verified", None, output_size=output_size, output_height=info["height"])
        # Atomic final replace, while the untouched .unoptimised original is retained.
        os.replace(temporary, source)
        mark(job_id, "verified", None, verified_at="__now__")
        complete_cleanup(job)
    except Exception as exc:
        # Delete only a disposable partial file. The original is source or backup and is retained.
        temporary.unlink(missing_ok=True)
        mark(job_id, "failed", str(exc))


def reset_stale_jobs():
    """Reset any interrupted jobs left in 'running' back to 'queued' on worker boot."""
    try:
        with db() as conn:
            conn.execute("""UPDATE optimisation_jobs
                            SET status='queued', progress=0
                            WHERE status = 'running'""")
    except Exception as e:
        print(f"[Worker] Note: could not reset stale jobs on startup: {e}")


def next_job():
    with db() as conn:
        job = conn.execute("""SELECT * FROM optimisation_jobs
                           WHERE status IN ('queued','running','renamed','output_verified','verified')
                           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1""").fetchone()
        if job:
            conn.execute("UPDATE optimisation_jobs SET status='running', progress=0, started_at=COALESCE(started_at, now()) WHERE id=%s", (job["id"],))
            event(conn, job["id"], "worker_started", "Dedicated worker claimed the job.")
            job["status"] = "running"
        return job


if __name__ == "__main__":
    init_db()
    reset_stale_jobs()
    while True:
        job = next_job()
        if job:
            process(job)
        else:
            time.sleep(3)

import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import psycopg
from psycopg.rows import dict_row
from flask import Flask, abort, flash, jsonify, redirect, render_template, request, url_for
from flask_socketio import SocketIO

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.secret_key = os.environ.get("SECRET_KEY", "cinegrab-media-manager-secret-key-2024")
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*")

# ---------------------------------------------------------------------------
# Directory Configuration
# ---------------------------------------------------------------------------
# Base download folder (contains 'movies' and 'shows')
DOWNLOAD_ROOT = Path(os.environ.get("DOWNLOAD_ROOT", os.environ.get("SOURCE_DIR", "/media/download"))).resolve()
SOURCE_MOVIES_DIR = Path(os.environ.get("SOURCE_MOVIES_DIR", str(DOWNLOAD_ROOT / "movies"))).resolve()
SOURCE_SHOWS_DIR = Path(os.environ.get("SOURCE_SHOWS_DIR", str(DOWNLOAD_ROOT / "shows"))).resolve()

# Base Jellyfin Library folder (contains 'Movies' and 'Shows')
LIBRARY_DIR = Path(os.environ.get("LIBRARY_DIR", os.environ.get("OPTIMISE_DIR", "/media/library"))).resolve()
DEST_MOVIES_DIR = Path(os.environ.get("DEST_MOVIES_DIR", str(LIBRARY_DIR / "Movies"))).resolve()
DEST_SHOWS_DIR = Path(os.environ.get("DEST_SHOWS_DIR", str(LIBRARY_DIR / "Shows"))).resolve()

# Backward compatibility aliases
SOURCE_DIR = DOWNLOAD_ROOT
DESTINATION_DIR = DEST_MOVIES_DIR
OPTIMISE_DIR = LIBRARY_DIR

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://movieuser:moviepass@postgres:5432/moviedownloader")
CHUNK = 1024 * 1024
VIDEO_EXTS = {".mkv", ".mp4", ".avi", ".webm", ".mov", ".m4v"}
ARCHIVE_EXTS = {".zip", ".rar", ".tar", ".gz"}


def db():
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def init_db():
    for _ in range(20):
        try:
            with db() as conn, conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS moves (
                      id UUID PRIMARY KEY,
                      source_path TEXT NOT NULL,
                      destination_path TEXT NOT NULL,
                      source_size BIGINT NOT NULL,
                      source_sha256 TEXT,
                      destination_sha256 TEXT,
                      status TEXT NOT NULL,
                      error TEXT,
                      media_type TEXT DEFAULT 'movie',
                      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                      copied_at TIMESTAMPTZ,
                      verified_at TIMESTAMPTZ,
                      completed_at TIMESTAMPTZ
                    )
                """)
                cur.execute("ALTER TABLE moves ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'movie'")
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS optimisation_jobs (
                      id UUID PRIMARY KEY, source_path TEXT NOT NULL, backup_path TEXT NOT NULL,
                      temporary_path TEXT NOT NULL, original_size BIGINT, original_height INTEGER,
                      output_size BIGINT, output_height INTEGER, status TEXT NOT NULL,
                      error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ,
                      verified_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
                    )
                """)
                cur.execute("ALTER TABLE optimisation_jobs ADD COLUMN IF NOT EXISTS duration_seconds DOUBLE PRECISION")
                cur.execute("ALTER TABLE optimisation_jobs ADD COLUMN IF NOT EXISTS progress DOUBLE PRECISION NOT NULL DEFAULT 0")
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS optimisation_events (
                      id BIGSERIAL PRIMARY KEY, job_id UUID REFERENCES optimisation_jobs(id),
                      event TEXT NOT NULL, details TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS move_events (
                      id BIGSERIAL PRIMARY KEY, move_id UUID REFERENCES moves(id), event TEXT NOT NULL,
                      details TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS media_file_cache (
                      path TEXT PRIMARY KEY,
                      relative_path TEXT NOT NULL,
                      size BIGINT NOT NULL,
                      mtime DOUBLE PRECISION NOT NULL,
                      is_video BOOLEAN NOT NULL DEFAULT false,
                      codec TEXT,
                      width INTEGER,
                      height INTEGER,
                      duration DOUBLE PRECISION DEFAULT 0,
                      is_optimised BOOLEAN NOT NULL DEFAULT false,
                      scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                """)
                cur.execute("CREATE INDEX IF NOT EXISTS idx_media_file_cache_relative ON media_file_cache(relative_path)")
                cur.execute("CREATE INDEX IF NOT EXISTS idx_media_file_cache_optimised ON media_file_cache(is_optimised)")
                cur.execute("UPDATE media_file_cache SET is_optimised = true WHERE is_video = true AND LOWER(codec) IN ('hevc', 'h265', 'x265', 'av1', 'vp9')")
            return
        except psycopg.OperationalError:
            time.sleep(2)
    raise RuntimeError("Database did not become ready")


# ---------------------------------------------------------------------------
# Checksum & File Verification
# ---------------------------------------------------------------------------
def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(CHUNK):
            digest.update(block)
    return digest.hexdigest()


def chunked_copy_and_hash(source_path: Path, target_path: Path, on_progress=None, chunk_size=8 * 1024 * 1024) -> Tuple[str, int]:
    """
    Copies source_path to target_path in chunks while computing SHA-256 digest on the fly.
    Calls on_progress(bytes_copied, total_bytes, speed_bytes_per_sec).
    Returns (source_sha256, total_bytes_copied).
    """
    total_size = source_path.stat().st_size
    bytes_copied = 0
    digest = hashlib.sha256()
    start_time = time.time()
    last_emit = 0

    target_path.parent.mkdir(parents=True, exist_ok=True)
    with source_path.open("rb") as src, target_path.open("wb") as dst:
        while True:
            chunk = src.read(chunk_size)
            if not chunk:
                break
            dst.write(chunk)
            digest.update(chunk)
            bytes_copied += len(chunk)

            now = time.time()
            if on_progress and (now - last_emit >= 0.2 or bytes_copied == total_size):
                elapsed = max(0.001, now - start_time)
                speed = bytes_copied / elapsed
                on_progress(bytes_copied, total_size, speed)
                last_emit = now

    return digest.hexdigest(), bytes_copied


def chunked_verify_hash(path: Path, on_progress=None, chunk_size=8 * 1024 * 1024) -> str:
    """
    Computes SHA-256 digest of path in chunks with progress updates.
    Calls on_progress(bytes_read, total_bytes, speed_bytes_per_sec).
    Returns sha256 hex string.
    """
    total_size = path.stat().st_size
    bytes_read = 0
    digest = hashlib.sha256()
    start_time = time.time()
    last_emit = 0

    with path.open("rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
            bytes_read += len(chunk)

            now = time.time()
            if on_progress and (now - last_emit >= 0.2 or bytes_read == total_size):
                elapsed = max(0.001, now - start_time)
                speed = bytes_read / elapsed
                on_progress(bytes_read, total_size, speed)
                last_emit = now

    return digest.hexdigest()


def safe_child(root: Path, raw: str) -> Path:
    candidate = (root / raw).resolve()
    if candidate != root and root not in candidate.parents:
        abort(400, "Invalid path: outside allowable root")
    return candidate


def log_event(conn, move_id, event, details=None):
    conn.execute("INSERT INTO move_events (move_id, event, details) VALUES (%s, %s, %s)",
                 (move_id, event, details))


def format_bytes_str(size_bytes: int) -> str:
    if not size_bytes or size_bytes <= 0:
        return "0 B"
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if size_bytes < 1024.0:
            return f"{size_bytes:.2f} {unit}"
        size_bytes /= 1024.0
    return f"{size_bytes:.2f} PB"


# ---------------------------------------------------------------------------
# Smart Title & Show Matcher
# ---------------------------------------------------------------------------
def normalize_title(name: str) -> str:
    """Normalizes title for robust comparison."""
    # Remove Season/Episode and release group info
    s = re.sub(
        r"\b(?:s\d{1,2}|season\s*\d{1,2}|all\s*episodes|web[-\s]*dl|hindi|complete|full\s*season(?:\s*batch)?|hdhub4u.*|dd5\.1|1080p|720p|480p|x264|hevc|x265)\b.*",
        "", name, flags=re.I
    )
    # Remove Year like (2024), [2021]
    s = re.sub(r"[\(\[\{]\s*\d{4}\s*[\)\]\}]", "", s)
    # Remove punctuation
    s = re.sub(r"[^\w\s]", " ", s)
    return " ".join(s.lower().split())


def clean_title_display(name: str) -> str:
    """Formats clean Title Cased title."""
    s = re.sub(
        r"\b(?:s\d{1,2}|season\s*\d{1,2}|all\s*episodes|web[-\s]*dl|hindi|complete|full\s*season(?:\s*batch)?|hdhub4u.*)\b.*",
        "", name, flags=re.I
    )
    s = re.sub(r"[\(\[\{]\s*\d{4}\s*[\)\]\}]", "", s)
    s = re.sub(r"[^\w\s-]", " ", s)
    words = s.strip().split()
    return " ".join(w.capitalize() for w in words) if words else name.strip()


def extract_season_num(text: str) -> int:
    m = re.search(r"\b(?:season|s)\s*[-._]?\s*(\d{1,2})\b", text, re.I)
    return int(m.group(1)) if m else 1


def extract_year(text: str) -> str:
    m = re.search(r"[\(\[\{]?\b(19\d{2}|20\d{2})\b[\)\]\}]?", text)
    return m.group(1) if m else "2024"


def get_existing_library_shows() -> List[str]:
    """Returns directory names from /media/library/Shows."""
    if not DEST_SHOWS_DIR.exists():
        return []
    shows = []
    try:
        for p in DEST_SHOWS_DIR.iterdir():
            if p.is_dir() and not p.name.startswith("."):
                shows.append(p.name)
    except Exception:
        pass
    return sorted(shows, key=lambda x: x.lower())


def match_existing_show(cand_name: str, existing_shows: Optional[List[str]] = None) -> Tuple[str, bool]:
    """
    Matches candidate show name against existing shows on Jellyfin server.
    Returns: (show_folder_name, is_existing_match)
    """
    if existing_shows is None:
        existing_shows = get_existing_library_shows()

    cand_norm = normalize_title(cand_name)
    if not cand_norm:
        return clean_title_display(cand_name), False

    # 1. Exact normalized match
    for show in existing_shows:
        if normalize_title(show) == cand_norm:
            return show, True

    # 2. Prefix / containment match (e.g. candidate "Asur" matches existing "Asur  tt11912196")
    for show in existing_shows:
        show_norm = normalize_title(show)
        if show_norm and (show_norm.startswith(cand_norm + " ") or cand_norm.startswith(show_norm + " ")):
            return show, True

    # 3. Fuzzy similarity match (difflib) with high confidence (0.85)
    norm_map = {normalize_title(s): s for s in existing_shows if normalize_title(s)}
    matches = difflib.get_close_matches(cand_norm, list(norm_map.keys()), n=1, cutoff=0.85)
    if matches:
        return norm_map[matches[0]], True

    # Not found on server: return cleaned show name
    return clean_title_display(cand_name), False


def safe_destination_for(target_path: Path) -> Path:
    """
    CRITICAL: Never overwrite an existing library file.
    If target_path exists, generates a harmless numbered candidate e.g. 'movie (1).mkv'.
    """
    if not target_path.exists():
        return target_path
    stem, suffix = target_path.stem, target_path.suffix
    count = 1
    while True:
        candidate = target_path.with_name(f"{stem} ({count}){suffix}")
        if not candidate.exists():
            return candidate
        count += 1


# ---------------------------------------------------------------------------
# Move Manager (Queue-based Safe Atomic Operations)
# ---------------------------------------------------------------------------
class MoveManager:
    """
    Manages background atomic file moves with on-the-fly SHA-256 computation,
    independent destination hash verification, ZIP batch extraction, and live Socket.IO events.
    """
    def __init__(self):
        self.lock = threading.Lock()
        self.queue: List[Dict[str, Any]] = []
        self.is_running = False
        self.current_job: Optional[Dict[str, Any]] = None

    def get_status(self) -> Dict[str, Any]:
        with self.lock:
            if not self.is_running or not self.current_job:
                return {
                    "is_active": False,
                    "queue_length": len(self.queue),
                    "current_item": "",
                    "stage": "idle",
                    "stage_label": "Idle",
                    "progress": 0,
                    "bytes_done": 0,
                    "total_bytes": 0,
                    "speed_mbps": 0,
                    "move_id": None
                }
            return {
                "is_active": True,
                "queue_length": len(self.queue),
                "current_item": self.current_job.get("file_name", ""),
                "media_type": self.current_job.get("media_type", "movie"),
                "stage": self.current_job.get("stage", "copying"),
                "stage_label": self.current_job.get("stage_label", ""),
                "progress": self.current_job.get("progress", 0),
                "bytes_done": self.current_job.get("bytes_done", 0),
                "total_bytes": self.current_job.get("total_bytes", 0),
                "speed_mbps": self.current_job.get("speed_mbps", 0),
                "move_id": str(self.current_job.get("move_id", ""))
            }

    def emit_progress(self):
        status = self.get_status()
        socketio.emit("move_progress", status)

    def queue_items(self, items: List[Dict[str, Any]]):
        with self.lock:
            for item in items:
                # Avoid duplicates
                src = str(item.get("source_path"))
                if not any(str(q.get("source_path")) == src for q in self.queue):
                    self.queue.append(item)
            if not self.is_running:
                self.is_running = True
                threading.Thread(target=self._worker_loop, daemon=True).start()
        self.emit_progress()

    def _worker_loop(self):
        while True:
            with self.lock:
                if not self.queue:
                    self.is_running = False
                    self.current_job = None
                    break
                item = self.queue.pop(0)

            try:
                media_type = item.get("type", "movie")
                source_path = Path(item["source_path"])

                if media_type == "batch_zip" or source_path.suffix.lower() in ARCHIVE_EXTS:
                    self._process_batch_zip_move(item)
                elif media_type in ("episode", "show"):
                    self._process_single_episode_move(item)
                else:
                    self._process_movie_move(item)

            except Exception as e:
                print(f"[MoveManager] Error processing {item.get('source_path')}: {e}")

            self.emit_progress()
            socketio.emit("moves_updated", {"completed_item": item.get("title", "")})
            time.sleep(0.5)

        self.emit_progress()

    def _process_movie_move(self, item: Dict[str, Any]):
        source = Path(item["source_path"])
        if not source.is_file():
            raise ValueError(f"Movie source file does not exist: {source}")

        # Resolve destination
        title = item.get("title") or clean_title_display(source.parent.name if source.parent != SOURCE_MOVIES_DIR else source.stem)
        year = item.get("year") or extract_year(source.name)
        folder_name = f"{title} ({year})"
        target_dir = DEST_MOVIES_DIR / folder_name
        target_file = safe_destination_for(target_dir / source.name)

        move_id = uuid.uuid4()
        total_size = source.stat().st_size
        file_name = source.name

        with self.lock:
            self.current_job = {
                "move_id": move_id,
                "file_name": file_name,
                "media_type": "movie",
                "source_path": str(source),
                "destination_path": str(target_file),
                "total_bytes": total_size,
                "bytes_done": 0,
                "stage": "copying",
                "stage_label": f"Copying movie '{title}' with on-the-fly SHA-256...",
                "progress": 0,
                "speed_mbps": 0
            }
        self.emit_progress()

        with db() as conn:
            conn.execute("""
                INSERT INTO moves (id, source_path, destination_path, source_size, status, media_type)
                VALUES (%s,%s,%s,%s,'copying','movie')
            """, (move_id, str(source), str(target_file), total_size))
            log_event(conn, move_id, "copy_started", "Movie transfer started with SHA-256 calculation.")

        temporary = target_file.with_name(f".{target_file.name}.{move_id}.partial")
        verified = False

        try:
            target_file.parent.mkdir(parents=True, exist_ok=True)

            # Phase 1: Copy chunk-by-chunk and compute source SHA-256 (0% - 50%)
            def on_copy_progress(copied, total, speed):
                pct = round((copied / total * 50.0), 1) if total > 0 else 0
                mb_c = round(copied / (1024 * 1024), 1)
                mb_t = round(total / (1024 * 1024), 1)
                spd = round(speed / (1024 * 1024), 1)
                with self.lock:
                    if self.current_job:
                        self.current_job["bytes_done"] = copied
                        self.current_job["progress"] = pct
                        self.current_job["speed_mbps"] = spd
                        self.current_job["stage_label"] = f"Copying: {mb_c} MB / {mb_t} MB ({spd} MB/s)"
                self.emit_progress()

            source_hash, _ = chunked_copy_and_hash(source, temporary, on_progress=on_copy_progress)

            with db() as conn:
                conn.execute("UPDATE moves SET source_sha256=%s WHERE id=%s", (source_hash, move_id))

            # Phase 2: Verify destination SHA-256 (50% - 95%)
            with self.lock:
                if self.current_job:
                    self.current_job["stage"] = "verifying"
                    self.current_job["stage_label"] = "Verifying destination SHA-256 checksum..."
            self.emit_progress()

            def on_verify_progress(v_bytes, total, speed):
                pct = round(50.0 + (v_bytes / total * 45.0), 1) if total > 0 else 50.0
                mb_v = round(v_bytes / (1024 * 1024), 1)
                mb_t = round(total / (1024 * 1024), 1)
                spd = round(speed / (1024 * 1024), 1)
                with self.lock:
                    if self.current_job:
                        self.current_job["bytes_done"] = v_bytes
                        self.current_job["progress"] = pct
                        self.current_job["speed_mbps"] = spd
                        self.current_job["stage_label"] = f"Verifying SHA-256: {mb_v} MB / {mb_t} MB ({spd} MB/s)"
                self.emit_progress()

            target_hash = chunked_verify_hash(temporary, on_progress=on_verify_progress)

            if target_hash != source_hash:
                raise IOError(f"Checksum mismatch: source={source_hash[:12]} vs dest={target_hash[:12]}. Source file retained.")

            # Phase 3: Atomic swap and source removal (95% - 100%)
            with self.lock:
                if self.current_job:
                    self.current_job["stage"] = "finalizing"
                    self.current_job["progress"] = 98.0
                    self.current_job["stage_label"] = "Atomic swap & safe source removal..."
            self.emit_progress()

            os.replace(temporary, target_file)
            verified = True

            with db() as conn:
                conn.execute("""
                    UPDATE moves SET destination_sha256=%s, status='verified', copied_at=now(), verified_at=now()
                    WHERE id=%s
                """, (target_hash, move_id))
                log_event(conn, move_id, "copy_verified", "Destination checksum matches source.")

            # Unlink source file
            source.unlink()

            # Clean empty parent directories up to SOURCE_MOVIES_DIR
            p = source.parent.resolve()
            while p != SOURCE_MOVIES_DIR and SOURCE_MOVIES_DIR in p.parents:
                try:
                    p.rmdir()
                    p = p.parent.resolve()
                except OSError:
                    break

            with db() as conn:
                conn.execute("UPDATE moves SET status='moved', completed_at=now() WHERE id=%s", (move_id,))
                log_event(conn, move_id, "source_removed", "Movie moved into Jellyfin library successfully.")

            with self.lock:
                if self.current_job:
                    self.current_job["stage"] = "moved"
                    self.current_job["progress"] = 100.0
                    self.current_job["stage_label"] = "Movie move completed!"
            self.emit_progress()

        except Exception as exc:
            temporary.unlink(missing_ok=True)
            with db() as conn:
                state = "verified" if verified else "failed"
                conn.execute("UPDATE moves SET status=%s, error=%s WHERE id=%s", (state, str(exc), move_id))
                log_event(conn, move_id, "failed", str(exc))
            with self.lock:
                if self.current_job:
                    self.current_job["stage"] = "failed"
                    self.current_job["stage_label"] = f"Failed: {exc}"
            self.emit_progress()
            raise

    def _process_single_episode_move(self, item: Dict[str, Any]):
        source = Path(item["source_path"])
        if not source.is_file():
            raise ValueError(f"Episode file does not exist: {source}")

        # Determine Show name and match against existing library
        raw_show = item.get("title") or source.parent.parent.name
        matched_show, _ = match_existing_show(raw_show)
        season = item.get("season") or extract_season_num(str(source))
        season_folder = f"Season {season:02d}"

        target_dir = DEST_SHOWS_DIR / matched_show / season_folder
        target_file = safe_destination_for(target_dir / source.name)

        move_id = uuid.uuid4()
        total_size = source.stat().st_size
        file_name = source.name

        with self.lock:
            self.current_job = {
                "move_id": move_id,
                "file_name": file_name,
                "media_type": "episode",
                "source_path": str(source),
                "destination_path": str(target_file),
                "total_bytes": total_size,
                "bytes_done": 0,
                "stage": "copying",
                "stage_label": f"Copying episode to '{matched_show}/{season_folder}' with SHA-256...",
                "progress": 0,
                "speed_mbps": 0
            }
        self.emit_progress()

        with db() as conn:
            conn.execute("""
                INSERT INTO moves (id, source_path, destination_path, source_size, status, media_type)
                VALUES (%s,%s,%s,%s,'copying','episode')
            """, (move_id, str(source), str(target_file), total_size))
            log_event(conn, move_id, "copy_started", f"Episode transfer started to {matched_show}/{season_folder}.")

        temporary = target_file.with_name(f".{target_file.name}.{move_id}.partial")
        verified = False

        try:
            target_file.parent.mkdir(parents=True, exist_ok=True)

            def on_copy_prog(copied, total, speed):
                pct = round((copied / total * 50.0), 1) if total > 0 else 0
                with self.lock:
                    if self.current_job:
                        self.current_job["bytes_done"] = copied
                        self.current_job["progress"] = pct
                        self.current_job["speed_mbps"] = round(speed / (1024 * 1024), 1)
                        self.current_job["stage_label"] = f"Copying: {round(copied/(1024*1024),1)} MB / {round(total/(1024*1024),1)} MB"
                self.emit_progress()

            source_hash, _ = chunked_copy_and_hash(source, temporary, on_progress=on_copy_prog)

            def on_ver_prog(v_bytes, total, speed):
                pct = round(50.0 + (v_bytes / total * 45.0), 1) if total > 0 else 50.0
                with self.lock:
                    if self.current_job:
                        self.current_job["bytes_done"] = v_bytes
                        self.current_job["progress"] = pct
                        self.current_job["speed_mbps"] = round(speed / (1024 * 1024), 1)
                        self.current_job["stage_label"] = f"Verifying SHA-256: {round(v_bytes/(1024*1024),1)} MB / {round(total/(1024*1024),1)} MB"
                self.emit_progress()

            target_hash = chunked_verify_hash(temporary, on_progress=on_ver_prog)

            if target_hash != source_hash:
                raise IOError(f"Checksum mismatch for episode {source.name}. Source retained.")

            os.replace(temporary, target_file)
            verified = True

            with db() as conn:
                conn.execute("""
                    UPDATE moves SET source_sha256=%s, destination_sha256=%s, status='verified', copied_at=now(), verified_at=now()
                    WHERE id=%s
                """, (source_hash, target_hash, move_id))

            source.unlink()

            # Clean empty directories up to SOURCE_SHOWS_DIR
            p = source.parent.resolve()
            while p != SOURCE_SHOWS_DIR and SOURCE_SHOWS_DIR in p.parents:
                try:
                    p.rmdir()
                    p = p.parent.resolve()
                except OSError:
                    break

            with db() as conn:
                conn.execute("UPDATE moves SET status='moved', completed_at=now() WHERE id=%s", (move_id,))
                log_event(conn, move_id, "source_removed", "Episode moved into Jellyfin library successfully.")

            with self.lock:
                if self.current_job:
                    self.current_job["stage"] = "moved"
                    self.current_job["progress"] = 100.0
                    self.current_job["stage_label"] = "Episode move completed!"
            self.emit_progress()

        except Exception as exc:
            temporary.unlink(missing_ok=True)
            with db() as conn:
                state = "verified" if verified else "failed"
                conn.execute("UPDATE moves SET status=%s, error=%s WHERE id=%s", (state, str(exc), move_id))
                log_event(conn, move_id, "failed", str(exc))
            with self.lock:
                if self.current_job:
                    self.current_job["stage"] = "failed"
                    self.current_job["stage_label"] = f"Failed: {exc}"
            self.emit_progress()
            raise

    def _process_batch_zip_move(self, item: Dict[str, Any]):
        """
        Unpacks season batch ZIP, identifies episode video files, matches Jellyfin show folder,
        safely transfers every episode with SHA-256 check into 'Shows/<Show>/Season XX/',
        and only unlinks the ZIP when all episodes are verified.
        """
        zip_source = Path(item["source_path"])
        if not zip_source.is_file():
            raise ValueError(f"ZIP file does not exist: {zip_source}")

        raw_show = item.get("title") or zip_source.parent.name
        matched_show, is_exist = match_existing_show(raw_show)
        season = item.get("season") or extract_season_num(f"{zip_source.parent.name} {zip_source.name}")
        season_folder = f"Season {season:02d}"

        target_season_dir = DEST_SHOWS_DIR / matched_show / season_folder
        staging_dir = SOURCE_SHOWS_DIR / ".staging" / f"unpack_{uuid.uuid4().hex[:10]}"

        zip_id = uuid.uuid4()
        total_zip_size = zip_source.stat().st_size

        with self.lock:
            self.current_job = {
                "move_id": zip_id,
                "file_name": zip_source.name,
                "media_type": "batch_zip",
                "source_path": str(zip_source),
                "destination_path": str(target_season_dir),
                "total_bytes": total_zip_size,
                "bytes_done": 0,
                "stage": "unpacking",
                "stage_label": f"Unpacking batch ZIP for '{matched_show} {season_folder}'...",
                "progress": 5.0,
                "speed_mbps": 0
            }
        self.emit_progress()

        with db() as conn:
            conn.execute("""
                INSERT INTO moves (id, source_path, destination_path, source_size, status, media_type)
                VALUES (%s,%s,%s,%s,'unpacking','batch_zip')
            """, (zip_id, str(zip_source), str(target_season_dir), total_zip_size))
            log_event(conn, zip_id, "unpacking_started", f"Extracting {zip_source.name} to staging.")

        try:
            staging_dir.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(zip_source, "r") as z:
                z.extractall(staging_dir)

            # Discover all video files inside extracted contents
            extracted_videos: List[Path] = []
            for root_dir, _, files in os.walk(staging_dir):
                for f in files:
                    p = Path(root_dir) / f
                    if p.suffix.lower() in VIDEO_EXTS and not p.name.startswith("."):
                        extracted_videos.append(p)

            extracted_videos.sort(key=lambda x: x.name.lower())

            if not extracted_videos:
                raise ValueError("No valid video files (.mkv, .mp4, etc.) found inside extracted ZIP.")

            target_season_dir.mkdir(parents=True, exist_ok=True)
            total_episodes = len(extracted_videos)

            with self.lock:
                if self.current_job:
                    self.current_job["stage"] = "transferring_episodes"
                    self.current_job["stage_label"] = f"Found {total_episodes} episodes. Moving to '{matched_show}/{season_folder}'..."
            self.emit_progress()

            # Process each episode with full SHA-256 verification
            for idx, ep_file in enumerate(extracted_videos, 1):
                target_file = safe_destination_for(target_season_dir / ep_file.name)
                ep_size = ep_file.stat().st_size
                ep_id = uuid.uuid4()

                base_pct = 15.0 + (float(idx - 1) / total_episodes * 80.0)
                step_pct = 80.0 / total_episodes

                with self.lock:
                    if self.current_job:
                        self.current_job["stage"] = f"copying_ep_{idx}"
                        self.current_job["progress"] = round(base_pct, 1)
                        self.current_job["stage_label"] = f"Episode {idx}/{total_episodes}: Copying '{ep_file.name}'..."
                self.emit_progress()

                temp_ep = target_file.with_name(f".{target_file.name}.{ep_id}.partial")

                def ep_copy_prog(copied, total, speed):
                    pct = base_pct + (copied / total * (step_pct * 0.5)) if total > 0 else base_pct
                    with self.lock:
                        if self.current_job:
                            self.current_job["progress"] = round(pct, 1)
                            self.current_job["speed_mbps"] = round(speed / (1024 * 1024), 1)
                            self.current_job["stage_label"] = f"Episode {idx}/{total_episodes}: Copying ({round(speed/(1024*1024),1)} MB/s)"
                    self.emit_progress()

                src_hash, _ = chunked_copy_and_hash(ep_file, temp_ep, on_progress=ep_copy_prog)

                def ep_ver_prog(v_bytes, total, speed):
                    pct = base_pct + (step_pct * 0.5) + (v_bytes / total * (step_pct * 0.5)) if total > 0 else base_pct
                    with self.lock:
                        if self.current_job:
                            self.current_job["progress"] = round(pct, 1)
                            self.current_job["speed_mbps"] = round(speed / (1024 * 1024), 1)
                            self.current_job["stage_label"] = f"Episode {idx}/{total_episodes}: Verifying SHA-256 ({round(speed/(1024*1024),1)} MB/s)"
                    self.emit_progress()

                dst_hash = chunked_verify_hash(temp_ep, on_progress=ep_ver_prog)

                if dst_hash != src_hash:
                    temp_ep.unlink(missing_ok=True)
                    raise IOError(f"Checksum verification failed on episode {ep_file.name}. Aborting batch move.")

                os.replace(temp_ep, target_file)

                # Log individual episode record
                with db() as conn:
                    conn.execute("""
                        INSERT INTO moves (id, source_path, destination_path, source_size, source_sha256, destination_sha256, status, media_type, completed_at)
                        VALUES (%s,%s,%s,%s,%s,%s,'moved','episode',now())
                    """, (ep_id, str(ep_file), str(target_file), ep_size, src_hash, dst_hash))
                    log_event(conn, ep_id, "episode_placed", f"Episode {idx}/{total_episodes} placed into {matched_show}/{season_folder}.")

            # All episodes 100% verified and placed!
            with self.lock:
                if self.current_job:
                    self.current_job["stage"] = "cleanup"
                    self.current_job["progress"] = 98.0
                    self.current_job["stage_label"] = "All episodes placed. Cleaning staging & removing source ZIP..."
            self.emit_progress()

            # Clean staging
            shutil.rmtree(staging_dir, ignore_errors=True)

            # Safely remove source ZIP
            zip_source.unlink()

            # Clean parent directory if empty
            p = zip_source.parent.resolve()
            while p != SOURCE_SHOWS_DIR and SOURCE_SHOWS_DIR in p.parents:
                try:
                    p.rmdir()
                    p = p.parent.resolve()
                except OSError:
                    break

            with db() as conn:
                conn.execute("UPDATE moves SET status='moved', completed_at=now() WHERE id=%s", (zip_id,))
                log_event(conn, zip_id, "batch_completed", f"All {total_episodes} episodes placed into {matched_show}/{season_folder}. Source ZIP removed.")

            with self.lock:
                if self.current_job:
                    self.current_job["stage"] = "moved"
                    self.current_job["progress"] = 100.0
                    self.current_job["stage_label"] = f"Season Batch complete: {total_episodes} episodes transferred!"
            self.emit_progress()

        except Exception as exc:
            shutil.rmtree(staging_dir, ignore_errors=True)
            with db() as conn:
                conn.execute("UPDATE moves SET status='failed', error=%s WHERE id=%s", (str(exc), zip_id))
                log_event(conn, zip_id, "failed", str(exc))
            with self.lock:
                if self.current_job:
                    self.current_job["stage"] = "failed"
                    self.current_job["stage_label"] = f"Batch failed: {exc}"
            self.emit_progress()
            raise


move_manager = MoveManager()


# ---------------------------------------------------------------------------
# Pending Media Analyzer
# ---------------------------------------------------------------------------
def analyze_pending_media() -> Dict[str, Any]:
    """
    Scans download/movies and download/shows to find completed items ready to move.
    Identifies type, clean title, year/season, matched Jellyfin folder, and sizes.
    """
    existing_shows = get_existing_library_shows()
    items: List[Dict[str, Any]] = []
    total_bytes = 0

    # 1. Analyze Movies (download/movies)
    if SOURCE_MOVIES_DIR.exists():
        for p in SOURCE_MOVIES_DIR.rglob("*"):
            if not p.is_file() or p.is_symlink() or p.name.startswith(".") or p.suffix.lower() not in VIDEO_EXTS:
                continue
            try:
                st = p.stat()
                total_bytes += st.st_size
                rel_path = str(p.relative_to(SOURCE_MOVIES_DIR))
                
                # Check parent folder name or file stem
                folder_title = p.parent.name if p.parent != SOURCE_MOVIES_DIR else p.stem
                clean_title = clean_title_display(folder_title)
                year = extract_year(folder_title)
                dest_folder = f"{clean_title} ({year})"
                target_dest = DEST_MOVIES_DIR / dest_folder / p.name

                items.append({
                    "id": f"movie_{uuid.uuid5(uuid.NAMESPACE_URL, str(p)).hex[:10]}",
                    "type": "movie",
                    "title": clean_title,
                    "year": year,
                    "file_name": p.name,
                    "relative_path": rel_path,
                    "source_path": str(p),
                    "file_size": st.st_size,
                    "file_size_str": format_bytes_str(st.st_size),
                    "dest_folder": dest_folder,
                    "dest_path": str(target_dest),
                    "already_in_library": target_dest.exists(),
                    "matched_existing_show": False
                })
            except Exception as e:
                print(f"[Analyzer] Error reading movie file {p}: {e}")

    # 2. Analyze Shows (download/shows) - Batch ZIPs and Episodes
    if SOURCE_SHOWS_DIR.exists():
        # First scan for ZIP batch packs
        for p in SOURCE_SHOWS_DIR.rglob("*"):
            if not p.is_file() or p.is_symlink() or p.name.startswith("."):
                continue
            if ".staging" in p.parts:
                continue

            try:
                st = p.stat()
                suffix = p.suffix.lower()

                if suffix in ARCHIVE_EXTS:
                    # Batch ZIP
                    total_bytes += st.st_size
                    rel_path = str(p.relative_to(SOURCE_SHOWS_DIR))
                    folder_name = p.parent.name if p.parent != SOURCE_SHOWS_DIR else p.stem
                    raw_title = f"{folder_name} {p.name}"
                    
                    matched_show, is_existing = match_existing_show(folder_name, existing_shows)
                    season_num = extract_season_num(raw_title)
                    season_folder = f"Season {season_num:02d}"
                    target_dest = DEST_SHOWS_DIR / matched_show / season_folder

                    items.append({
                        "id": f"zip_{uuid.uuid5(uuid.NAMESPACE_URL, str(p)).hex[:10]}",
                        "type": "batch_zip",
                        "title": matched_show,
                        "season": season_num,
                        "season_folder": season_folder,
                        "file_name": p.name,
                        "relative_path": rel_path,
                        "source_path": str(p),
                        "file_size": st.st_size,
                        "file_size_str": format_bytes_str(st.st_size),
                        "dest_folder": f"{matched_show}/{season_folder}",
                        "dest_path": str(target_dest),
                        "already_in_library": target_dest.exists(),
                        "matched_existing_show": is_existing,
                        "library_show_folder": matched_show
                    })

                elif suffix in VIDEO_EXTS:
                    # Single Episode
                    total_bytes += st.st_size
                    rel_path = str(p.relative_to(SOURCE_SHOWS_DIR))
                    parent_show = p.parent.parent.name if p.parent.parent != SOURCE_SHOWS_DIR else p.parent.name
                    matched_show, is_existing = match_existing_show(parent_show, existing_shows)
                    season_num = extract_season_num(str(p))
                    season_folder = f"Season {season_num:02d}"
                    target_dest = DEST_SHOWS_DIR / matched_show / season_folder / p.name

                    items.append({
                        "id": f"ep_{uuid.uuid5(uuid.NAMESPACE_URL, str(p)).hex[:10]}",
                        "type": "episode",
                        "title": matched_show,
                        "season": season_num,
                        "season_folder": season_folder,
                        "file_name": p.name,
                        "relative_path": rel_path,
                        "source_path": str(p),
                        "file_size": st.st_size,
                        "file_size_str": format_bytes_str(st.st_size),
                        "dest_folder": f"{matched_show}/{season_folder}",
                        "dest_path": str(target_dest),
                        "already_in_library": target_dest.exists(),
                        "matched_existing_show": is_existing,
                        "library_show_folder": matched_show
                    })
            except Exception as e:
                print(f"[Analyzer] Error reading show file {p}: {e}")

    # Sort items by type (movies first, then series) and title
    items.sort(key=lambda x: (x["type"] != "movie", x["title"].lower()))

    return {
        "status": "ok",
        "total_items": len(items),
        "total_bytes": total_bytes,
        "total_size_str": format_bytes_str(total_bytes),
        "items": items
    }


# ---------------------------------------------------------------------------
# Optimisation & FFmpeg Library Cache
# ---------------------------------------------------------------------------
def media_info(path: Path) -> Dict[str, Any]:
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=codec_name,width,height", "-show_entries", "format=duration", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=20, check=True,
        )
        stream = json.loads(result.stdout).get("streams", [])[0]
        return {
            "video": True,
            "codec": stream.get("codec_name", "unknown"),
            "width": stream.get("width"),
            "height": stream.get("height"),
            "duration": float(json.loads(result.stdout).get("format", {}).get("duration") or 0)
        }
    except Exception:
        return {"video": False, "codec": "not video", "width": None, "height": None, "duration": 0}


def is_optimised(item: Dict[str, Any]) -> bool:
    path_name = item["path"].name if isinstance(item.get("path"), Path) else Path(str(item.get("path", ""))).name
    match = re.search(r"(?:^|[. _-])(\d{3,4})p(?:[. _-]|$)", path_name, re.IGNORECASE)
    is_vid = item.get("video", False)
    codec = str(item.get("codec", "")).lower()
    height = item.get("height") or 0
    is_hevc = codec in ("hevc", "h265", "x265", "av1", "vp9")
    return bool(is_vid and (is_hevc or (match and int(match.group(1)) <= 720) or height <= 720))


class LibraryScanner:
    """Scans the media library in background chunks and maintains a fast DB cache."""
    def __init__(self):
        self.lock = threading.Lock()
        self.is_scanning = False
        self.total = 0
        self.scanned = 0
        self.current_chunk = 0
        self.total_chunks = 0
        self.current_file = ""
        self.last_scanned_at = None

    def get_status(self) -> Dict[str, Any]:
        with self.lock:
            percent = (self.scanned / self.total * 100) if self.total > 0 else (100.0 if not self.is_scanning else 0.0)
            return {
                "is_scanning": self.is_scanning,
                "total": self.total,
                "scanned": self.scanned,
                "current_chunk": self.current_chunk,
                "total_chunks": self.total_chunks,
                "current_file": self.current_file,
                "percent": round(min(100.0, max(0.0, percent)), 1),
                "last_scanned_at": self.last_scanned_at.isoformat() if self.last_scanned_at else None
            }

    def emit_progress(self):
        status = self.get_status()
        socketio.emit("library_scan_progress", status)

    def scan_in_background(self, chunk_size=15, force=False) -> bool:
        with self.lock:
            if self.is_scanning:
                return False
            self.is_scanning = True
            self.scanned = 0
            self.total = 0
            self.current_chunk = 0
            self.total_chunks = 0
            self.current_file = "Discovering library files..."

        def _run():
            try:
                self.emit_progress()
                self._do_scan(chunk_size=chunk_size, force=force)
            except Exception as e:
                print(f"[Scanner] Error during background scan: {e}")
            finally:
                with self.lock:
                    self.is_scanning = False
                    self.current_file = ""
                    self.last_scanned_at = datetime.now(timezone.utc)
                self.emit_progress()
                socketio.emit("library_scan_complete", self.get_status())

        threading.Thread(target=_run, daemon=True).start()
        return True

    def _do_scan(self, chunk_size=15, force=False):
        if not LIBRARY_DIR.exists():
            return

        disk_files = {}
        for path in LIBRARY_DIR.rglob("*"):
            if not path.is_file() or path.is_symlink() or ".unoptimised" in path.stem or ".optimising" in path.name:
                continue
            if path.suffix.lower() not in VIDEO_EXTS:
                continue
            try:
                st = path.stat()
                disk_files[str(path)] = (path, st.st_size, st.st_mtime)
            except OSError:
                continue

        with db() as conn:
            cached_rows = conn.execute("SELECT path, size, mtime FROM media_file_cache").fetchall()
            cached_map = {row["path"]: (row["size"], row["mtime"]) for row in cached_rows}

            # Prune deleted paths
            missing_paths = [p for p in cached_map if p not in disk_files]
            if missing_paths:
                with conn.cursor() as cur:
                    for i in range(0, len(missing_paths), 100):
                        cur.execute("DELETE FROM media_file_cache WHERE path = ANY(%s)", (missing_paths[i:i+100],))

        to_probe = []
        for path_str, (path, size, mtime) in disk_files.items():
            if force or path_str not in cached_map:
                to_probe.append((path, size, mtime))
            else:
                c_size, c_mtime = cached_map[path_str]
                if abs(c_mtime - mtime) > 1.0 or c_size != size:
                    to_probe.append((path, size, mtime))

        total_disk = len(disk_files)
        already_cached = total_disk - len(to_probe)
        chunks = [to_probe[i:i + chunk_size] for i in range(0, len(to_probe), chunk_size)]

        with self.lock:
            self.total = total_disk
            self.scanned = already_cached
            self.total_chunks = len(chunks)
            self.current_chunk = 0

        self.emit_progress()

        for chunk_idx, chunk in enumerate(chunks):
            with self.lock:
                self.current_chunk = chunk_idx + 1

            chunk_records = []
            for path, size, mtime in chunk:
                with self.lock:
                    self.current_file = path.name
                self.emit_progress()

                info = media_info(path)
                candidate = {"path": path, **info}
                optimised = is_optimised(candidate)
                try:
                    rel_path = str(path.relative_to(LIBRARY_DIR))
                except Exception:
                    rel_path = path.name

                chunk_records.append((
                    str(path), rel_path, size, mtime,
                    info["video"], info["codec"], info["width"], info["height"],
                    info["duration"], optimised
                ))

                with self.lock:
                    self.scanned += 1

            if chunk_records:
                with db() as conn, conn.cursor() as cur:
                    cur.executemany("""
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
                    """, chunk_records)

            self.emit_progress()


scanner = LibraryScanner()


def cached_library_files() -> List[Dict[str, Any]]:
    with db() as conn:
        rows = conn.execute("""
            SELECT path, relative_path, size, mtime, is_video, codec, width, height, duration, is_optimised
            FROM media_file_cache
            ORDER BY LOWER(relative_path) ASC
        """).fetchall()

    files = []
    for r in rows:
        files.append({
            "path": Path(r["path"]),
            "relative": Path(r["relative_path"]),
            "size": r["size"],
            "mtime": r["mtime"],
            "video": r["is_video"],
            "codec": r["codec"],
            "width": r["width"],
            "height": r["height"],
            "duration": r["duration"],
            "is_optimised": r["is_optimised"]
        })
    return files


def queue_snapshot() -> List[Dict[str, Any]]:
    with db() as conn:
        rows = conn.execute("""SELECT id, source_path, status, progress, error, created_at
                               FROM optimisation_jobs ORDER BY created_at DESC LIMIT 100""").fetchall()
    for row in rows:
        row["id"] = str(row["id"])
        row["created_at"] = row["created_at"].isoformat() if row.get("created_at") else ""
    return rows


# ---------------------------------------------------------------------------
# REST API Endpoints (For CineGrab Core App Integration)
# ---------------------------------------------------------------------------

@app.get("/api/health")
def api_health():
    return jsonify({
        "status": "healthy",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "download_root": str(DOWNLOAD_ROOT),
        "library_dir": str(LIBRARY_DIR),
        "movies_dir_exists": DEST_MOVIES_DIR.exists(),
        "shows_dir_exists": DEST_SHOWS_DIR.exists()
    })


@app.get("/api/media/analyze")
def api_media_analyze():
    """
    Analyzes pending downloads across download/movies and download/shows.
    Returns smart categorization, target Jellyfin destination, and existing show matches.
    """
    try:
        data = analyze_pending_media()
        return jsonify(data)
    except Exception as exc:
        return jsonify({"status": "error", "message": str(exc)}), 500


@app.post("/api/media/move")
def api_media_move():
    """
    Queues one, multiple, or all pending downloaded media for background safe move.
    """
    payload = request.get_json(silent=True) or {}
    items_to_move = payload.get("items") or []

    # If no items specified, move all pending
    if not items_to_move or payload.get("all") is True:
        analyzed = analyze_pending_media()
        items_to_move = analyzed.get("items", [])

    if not items_to_move:
        return jsonify({"status": "error", "message": "No valid media items found to move."}), 400

    move_manager.queue_items(items_to_move)

    return jsonify({
        "status": "ok",
        "message": f"Successfully queued {len(items_to_move)} item(s) for background transfer.",
        "queued_count": len(items_to_move)
    })


@app.get("/api/media/status")
def api_media_status():
    """Returns active move status, stage, speed, and remaining queue."""
    return jsonify(move_manager.get_status())


@app.get("/api/media/history")
def api_media_history():
    """Returns recent move events and audit records."""
    with db() as conn:
        rows = conn.execute("""
            SELECT id, source_path, destination_path, source_size, source_sha256,
                   destination_sha256, status, error, media_type, created_at, completed_at
            FROM moves
            ORDER BY created_at DESC LIMIT 100
        """).fetchall()

    history = []
    for r in rows:
        history.append({
            "id": str(r["id"]),
            "source_path": r["source_path"],
            "source_name": Path(r["source_path"]).name,
            "destination_path": r["destination_path"],
            "source_size": r["source_size"],
            "source_size_str": format_bytes_str(r["source_size"]),
            "source_sha256": r["source_sha256"] or "",
            "destination_sha256": r["destination_sha256"] or "",
            "status": r["status"],
            "error": r["error"] or "",
            "media_type": r.get("media_type") or "movie",
            "created_at": r["created_at"].isoformat() if r.get("created_at") else "",
            "completed_at": r["completed_at"].isoformat() if r.get("completed_at") else ""
        })

    return jsonify({
        "status": "ok",
        "history": history,
        "current": move_manager.get_status()
    })


@app.get("/api/optimize/list")
def api_optimize_list():
    """
    Returns library media items categorized into 'not_optimised' (>720p)
    and 'already_optimised' (720p / HEVC / AV1).
    """
    files = cached_library_files()
    if not files and not scanner.is_scanning and LIBRARY_DIR.exists():
        scanner.scan_in_background(chunk_size=15)

    with db() as conn:
        jobs = conn.execute("SELECT * FROM optimisation_jobs ORDER BY created_at DESC LIMIT 100").fetchall()

    active_paths = {row["source_path"]: row["status"] for row in jobs if row["status"] not in ("completed", "failed")}

    not_opt = []
    already_opt = []

    for item in files:
        path_str = str(item["path"])
        entry = {
            "path": path_str,
            "relative_path": str(item["relative"]),
            "name": item["path"].name,
            "size": item["size"],
            "size_str": format_bytes_str(item["size"]),
            "codec": item["codec"],
            "width": item["width"],
            "height": item["height"],
            "resolution": f"{item['height']}p" if item.get("height") else "Unknown",
            "duration": item["duration"],
            "is_optimised": item["is_optimised"],
            "job_status": active_paths.get(path_str, None)
        }
        if item["video"] and not item["is_optimised"]:
            not_opt.append(entry)
        elif item["video"]:
            already_opt.append(entry)

    return jsonify({
        "status": "ok",
        "total_videos": len(files),
        "not_optimised_count": len(not_opt),
        "already_optimised_count": len(already_opt),
        "not_optimised": not_opt,
        "already_optimised": already_opt,
        "scan_status": scanner.get_status()
    })


@app.post("/api/optimize/queue")
def api_optimize_queue():
    """Queues selected video paths for 720p H.264 compression."""
    payload = request.get_json(silent=True) or {}
    selected = payload.get("paths") or []

    if not selected:
        return jsonify({"status": "error", "message": "No video paths specified."}), 400

    queued = 0
    rejected = []

    with db() as conn:
        for p_str in selected:
            path = Path(p_str)
            if not path.is_file() or LIBRARY_DIR not in path.resolve().parents and path.resolve() != LIBRARY_DIR:
                rejected.append(path.name)
                continue

            info = media_info(path)
            candidate = {"path": path, **info}
            if not info["video"] or is_optimised(candidate):
                rejected.append(f"{path.name} (already optimal)")
                continue

            existing = conn.execute("SELECT id FROM optimisation_jobs WHERE source_path=%s AND status != 'completed'",
                                    (str(path),)).fetchone()
            if existing:
                rejected.append(f"{path.name} (already in queue)")
                continue

            job_id = uuid.uuid4()
            backup = path.with_name(f"{path.stem}.unoptimised{path.suffix}")
            temporary = path.with_name(f".{path.stem}.{job_id}.optimising{path.suffix}")

            if backup.exists():
                rejected.append(f"{path.name} (backup file exists)")
                continue

            conn.execute("""
                INSERT INTO optimisation_jobs
                (id,source_path,backup_path,temporary_path,original_size,original_height,status,duration_seconds)
                VALUES (%s,%s,%s,%s,%s,%s,'queued',%s)
            """, (job_id, str(path), str(backup), str(temporary), path.stat().st_size, info["height"], info["duration"]))

            conn.execute("INSERT INTO optimisation_events (job_id,event,details) VALUES (%s,%s,%s)",
                         (job_id, "queued", "Awaiting dedicated FFmpeg worker."))
            queued += 1

    socketio.emit("queue_update", queue_snapshot())

    return jsonify({
        "status": "ok",
        "queued": queued,
        "rejected": rejected,
        "message": f"{queued} file(s) queued for safe 720p optimisation."
    })


@app.get("/api/optimize/status")
def api_optimize_status():
    """Returns active optimization jobs and current worker state."""
    return jsonify({
        "status": "ok",
        "jobs": queue_snapshot(),
        "scan_status": scanner.get_status()
    })


@app.post("/api/optimize/scan")
def api_optimize_scan():
    """Triggers background media library cache scan."""
    started = scanner.scan_in_background(chunk_size=15, force=False)
    return jsonify({
        "status": "ok",
        "scanning": started,
        "message": "Library scan initiated in background." if started else "Scan already in progress."
    })


@app.post("/api/optimize/cancel/<job_id>")
def api_optimize_cancel(job_id: str):
    """Cancels an optimization job and safely restores the backup if needed."""
    with db() as conn:
        job = conn.execute("SELECT * FROM optimisation_jobs WHERE id=%s", (job_id,)).fetchone()
        if not job:
            return jsonify({"status": "error", "message": "Job not found."}), 404

        source = Path(job["source_path"])
        backup = Path(job["backup_path"])
        temporary = Path(job["temporary_path"])

        if backup.exists() and not source.exists():
            try:
                os.replace(backup, source)
            except Exception as e:
                print(f"[Cancel] Error restoring backup: {e}")
        try:
            temporary.unlink(missing_ok=True)
        except Exception:
            pass

        conn.execute("DELETE FROM optimisation_events WHERE job_id=%s", (job_id,))
        conn.execute("DELETE FROM optimisation_jobs WHERE id=%s", (job_id,))

    socketio.emit("queue_update", queue_snapshot())
    return jsonify({"status": "ok", "message": "Job cancelled and removed from queue."})


@app.post("/api/optimize/clear-history")
def api_optimize_clear_history():
    with db() as conn:
        conn.execute("""
            DELETE FROM optimisation_events 
            WHERE job_id IN (SELECT id FROM optimisation_jobs WHERE status IN ('completed', 'failed'))
        """)
        conn.execute("DELETE FROM optimisation_jobs WHERE status IN ('completed', 'failed')")
    socketio.emit("queue_update", queue_snapshot())
    return jsonify({"status": "ok", "message": "Optimisation history cleared."})


# ---------------------------------------------------------------------------
# Legacy Web Routes (Preserving direct browser access on port 5687)
# ---------------------------------------------------------------------------
@app.get("/favicon.ico")
def favicon():
    return app.send_static_file("favicon.ico")


@app.get("/")
def home():
    analyzed = analyze_pending_media()
    with db() as conn:
        cached_count = conn.execute("SELECT COUNT(*) AS c FROM media_file_cache").fetchone()["c"]
        not_opt_count = conn.execute("SELECT COUNT(*) AS c FROM media_file_cache WHERE is_video = true AND is_optimised = false").fetchone()["c"]
        active_jobs = conn.execute("SELECT COUNT(*) AS c FROM optimisation_jobs WHERE status IN ('queued', 'running', 'renamed')").fetchone()["c"]
    active_moves = len(move_manager.queue) + (1 if move_manager.is_running else 0)
    return render_template(
        "home.html",
        source=SOURCE_DIR,
        destination=DESTINATION_DIR,
        optimise_dir=OPTIMISE_DIR,
        source_count=analyzed["total_items"],
        cached_count=cached_count,
        not_opt_count=not_opt_count,
        active_jobs=active_jobs,
        active_moves=active_moves
    )


@app.get("/mv")
def moves():
    analyzed = analyze_pending_media()
    with db() as conn:
        history = conn.execute("""
            SELECT * FROM moves 
            WHERE status != 'moved' 
               OR completed_at >= now() - INTERVAL '1 hour' 
               OR (completed_at IS NULL AND created_at >= now() - INTERVAL '1 hour')
            ORDER BY created_at DESC LIMIT 200
        """).fetchall()
    return render_template(
        "moves.html",
        files=[Path(i["source_path"]) for i in analyzed["items"]],
        empty_folders=[],
        history=history,
        source=SOURCE_DIR,
        destination=DESTINATION_DIR,
        move_status=move_manager.get_status()
    )


@app.post("/mv")
def start_moves_legacy():
    selected = request.form.getlist("files")
    analyzed = analyze_pending_media()
    items_to_queue = []
    for item in analyzed["items"]:
        if not selected or item["source_path"] in selected or item["file_name"] in selected:
            items_to_queue.append(item)

    if not items_to_queue:
        flash("Choose at least one file.", "error")
        return redirect(url_for("moves"))

    move_manager.queue_items(items_to_queue)
    flash(f"{len(items_to_queue)} item(s) queued for background transfer.", "success")
    return redirect(url_for("moves"))


@app.get("/optimise")
def optimise():
    files = cached_library_files()
    if not files and not scanner.is_scanning and LIBRARY_DIR.exists():
        scanner.scan_in_background(chunk_size=15)

    with db() as conn:
        jobs = conn.execute("SELECT * FROM optimisation_jobs ORDER BY created_at DESC LIMIT 200").fetchall()

    active_by_path = {row["source_path"]: row for row in jobs if row["status"] != "completed"}
    not_optimised = [item for item in files if item["video"] and not item["is_optimised"]]
    already_optimised = [item for item in files if not item["video"] or item["is_optimised"]]

    return render_template(
        "optimise.html",
        not_optimised=not_optimised,
        already_optimised=already_optimised,
        active_by_path=active_by_path,
        jobs=jobs,
        destination=LIBRARY_DIR,
        scan_status=scanner.get_status()
    )


# ---------------------------------------------------------------------------
# Background Tasks & Initialization
# ---------------------------------------------------------------------------
@socketio.on("connect")
def on_client_connect():
    socketio.emit("queue_update", queue_snapshot())
    socketio.emit("library_scan_progress", scanner.get_status())
    socketio.emit("move_progress", move_manager.get_status())


@socketio.on("request_scan")
def socket_request_scan():
    scanner.scan_in_background(chunk_size=15)


def broadcast_queue_changes():
    previous = None
    while True:
        try:
            current = queue_snapshot()
            serialised = json.dumps(current, sort_keys=True)
            if serialised != previous:
                socketio.emit("queue_update", current)
                previous = serialised
        except Exception:
            pass
        time.sleep(1)


try:
    init_db()
    socketio.start_background_task(broadcast_queue_changes)
    scanner.scan_in_background(chunk_size=15)
except Exception as e:
    print(f"[Init Warning] DB/Scanner initialization notice: {e}")

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5687)

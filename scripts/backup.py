"""Offline PostgreSQL + attachments backup via Docker Compose; Python stdlib only.

Run with .venv/bin/python scripts/backup.py backup --output backups/<name>.tar.gz
Stop the app (not PostgreSQL) before backup/restore to keep attachments consistent.
"""
import argparse
from contextlib import contextmanager, ExitStack
import gzip
import io
import os
import tempfile
from pathlib import Path, PureWindowsPath
import stat
import subprocess
import tarfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
BACKUP_LIMIT = 3
LOCK_NAME = ".crm-retention.lock"
STAGING_PREFIX = ".crm-backup-"


def compose(*args, **kwargs):
    return subprocess.run(["docker", "compose", *args], cwd=ROOT, check=True, **kwargs)


def require_stopped():
    state = compose("ps", "--status", "running", "--services", capture_output=True, text=True)
    if "app" in state.stdout.splitlines():
        raise SystemExit("Stop writers first: docker compose stop app")


def valid_backup(fileobj):
    """Recognize our archive layout and read through the gzip footer (length + CRC)."""
    try:
        with gzip.GzipFile(fileobj=fileobj, mode="rb") as stream:
            with tarfile.open(fileobj=stream, mode="r:") as archive:
                sql = archive.next()
                if not sql or sql.name != "database.sql" or not sql.isfile() or sql.size <= 0:
                    return False
                for member in iter(archive.next, None):
                    if member.name == "files" and member.isdir():
                        continue
                    if (not member.name.startswith("files/")
                            or member.size < 0 or ".." in PureWindowsPath(member.name).parts
                            or not (member.isfile() or member.isdir())):
                        return False
                # tarfile can treat a malformed header after a member as end-of-tar.
                stream.seek(archive.offset)
                if stream.read(1024) != bytes(1024):
                    return False
                return all(not chunk.strip(b"\0") for chunk in iter(lambda: stream.read(1024 * 1024), b""))
    except (tarfile.TarError, gzip.BadGzipFile, EOFError, zlib.error):
        return False


def is_reparse_point(info):
    return bool(getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def reserved_name(path):
    name = path.name.lower()
    return name == LOCK_NAME or name.startswith(STAGING_PREFIX)


@contextmanager
def retention_lock(directory):
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or is_reparse_point(info):
        raise SystemExit("Refusing backup rotation through a linked directory")
    # Keep this empty file in place so every process locks the same inode.
    lock_path = directory / LOCK_NAME
    try:
        lock_file = lock_path.open("x+b")
    except FileExistsError:
        info = lock_path.lstat()
        if not stat.S_ISREG(info.st_mode) or is_reparse_point(info):
            raise SystemExit("Refusing a linked or non-regular backup lock")
        lock_file = lock_path.open("r+b")
    with lock_file as lock:
        if os.name == "nt":
            import msvcrt
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        yield


def rotate_locked(directory, verified=None):
    backups = []
    for path in directory.iterdir():
        if reserved_name(path):
            continue
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or is_reparse_point(info):
            continue
        if path != verified:
            with path.open("rb") as source:
                if not valid_backup(source):
                    continue
        # A restored timestamp or a clock correction must not expire this publication.
        backups.append((path == verified, info.st_mtime_ns, path.name, path))
    backups.sort(reverse=True)
    for _, _, _, path in backups[BACKUP_LIMIT:]:
        path.unlink()
        print(f"Expired backup removed: {path.name}")
    print(f"CRM backups retained: {min(len(backups), BACKUP_LIMIT)}")


def prune():
    directory = ROOT / "backups"
    if os.path.lexists(directory):
        with retention_lock(directory):
            rotate_locked(directory)


def backup(output):
    require_stopped()
    destination = Path(output).absolute()
    if os.path.lexists(destination):
        raise SystemExit("Output already exists; choose a new backup filename")
    destination.parent.mkdir(parents=True, exist_ok=True)
    directory = ROOT / "backups"
    managed = destination.parent.resolve() == directory.resolve()
    if managed and reserved_name(destination):
        raise SystemExit("Output name reserved for backup rotation")
    dump = compose("exec", "-T", "postgres", "pg_dump", "-U", "crm", "-d", "crm",
                   "--clean", "--if-exists", "--no-owner", capture_output=True).stdout
    # The temporary file is on the same filesystem, private from its first byte.
    # link() publishes the completed archive without replacing a concurrent writer.
    with ExitStack() as publication:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=STAGING_PREFIX) as target:
            with tarfile.open(fileobj=target, mode="w:gz") as archive:
                metadata = tarfile.TarInfo("database.sql")
                metadata.size = len(dump)
                metadata.mode = 0o600
                archive.addfile(metadata, io.BytesIO(dump))
                files = ROOT / "data" / "files"
                if files.exists():
                    archive.add(files, arcname="files", recursive=True)
            target.flush()
            os.fsync(target.fileno())
            if managed:
                target.seek(0)
                if not valid_backup(target):
                    raise SystemExit("Incomplete CRM backup; previous backups retained")
                publication.enter_context(retention_lock(directory))
            try:
                os.link(target.name, destination)
            except FileExistsError:
                raise SystemExit("Output already exists; choose a new backup filename") from None
        print(f"Backup created: {destination}")
        if managed:
            rotate_locked(directory, verified=directory / destination.name)


def restore(source, confirm):
    if not confirm:
        raise SystemExit("Restore replaces CRM database contents. Pass --confirm-restore only for the intended target.")
    require_stopped()
    with tarfile.open(Path(source).resolve(), "r:gz") as archive:
        members = archive.getmembers()
        for item in members:
            parts = Path(item.name).parts
            if (Path(item.name).is_absolute() or ".." in parts or not parts
                    or parts[0] not in {"database.sql", "files"}
                    or not (item.isfile() or item.isdir())):
                raise SystemExit("Unsafe backup member")
        sql = archive.extractfile("database.sql")
        if sql is None:
            raise SystemExit("Missing database.sql")
        # psql's single transaction makes a failed restore rollback as a whole.
        compose("exec", "-T", "postgres", "psql", "-U", "crm", "-d", "crm",
                "--single-transaction", "-v", "ON_ERROR_STOP=1", input=sql.read())
        data = ROOT / "data"
        data.mkdir(parents=True, exist_ok=True)
        archive.extractall(data, members=[m for m in members if m.name.startswith("files")], filter="data")
    print("Database and attachments restored. Verify health and a sample file before enabling the app.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    make = subs.add_parser("backup")
    make.add_argument("--output", required=True)
    subs.add_parser("prune", help="Keep the three newest complete CRM archives in backups/")
    load = subs.add_parser("restore")
    load.add_argument("--input", required=True)
    load.add_argument("--confirm-restore", action="store_true")
    args = parser.parse_args()
    if args.command == "backup":
        backup(args.output)
    elif args.command == "prune":
        prune()
    else:
        restore(args.input, args.confirm_restore)

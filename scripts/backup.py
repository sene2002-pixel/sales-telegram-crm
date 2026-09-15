"""Offline PostgreSQL + attachments backup via Docker Compose; Python stdlib only.

Run with .venv/bin/python scripts/backup.py backup --output backups/<name>.tar.gz
Stop the app (not PostgreSQL) before backup/restore to keep attachments consistent.
"""
import argparse
import io
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def compose(*args, **kwargs):
    return subprocess.run(["docker", "compose", *args], cwd=ROOT, check=True, **kwargs)


def require_stopped():
    state = compose("ps", "--status", "running", "--services", capture_output=True, text=True)
    if "app" in state.stdout.splitlines():
        raise SystemExit("Stop writers first: docker compose stop app")


def backup(output):
    require_stopped()
    destination = Path(output).resolve()
    if destination.exists():
        raise SystemExit("Output already exists; choose a new backup filename")
    destination.parent.mkdir(parents=True, exist_ok=True)
    dump = compose("exec", "-T", "postgres", "pg_dump", "-U", "crm", "-d", "crm",
                   "--clean", "--if-exists", "--no-owner", capture_output=True).stdout
    with tarfile.open(destination, "x:gz") as archive:
        metadata = tarfile.TarInfo("database.sql")
        metadata.size = len(dump)
        metadata.mode = 0o600
        archive.addfile(metadata, io.BytesIO(dump))
        files = ROOT / "data" / "files"
        if files.exists():
            archive.add(files, arcname="files", recursive=True)
    destination.chmod(0o600)
    print(f"Backup created: {destination}")


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
    load = subs.add_parser("restore")
    load.add_argument("--input", required=True)
    load.add_argument("--confirm-restore", action="store_true")
    args = parser.parse_args()
    if args.command == "backup":
        backup(args.output)
    else:
        restore(args.input, args.confirm_restore)

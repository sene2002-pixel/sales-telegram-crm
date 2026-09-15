"""Offline regression tests. No Docker daemon or real CRM database is accessed."""
import io
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import backup


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="crm-backup-tests-")
        self.root = Path(self.tmp.name)
        self.root_patch = patch.object(backup, "ROOT", self.root)
        self.root_patch.start()
        self.calls = []

        def compose(*args, **kwargs):
            self.calls.append((args, kwargs))
            if args[0] == "ps":
                return subprocess.CompletedProcess(args, 0, stdout="postgres\n")
            return subprocess.CompletedProcess(args, 0, stdout=b"SELECT 1;")

        self.compose_patch = patch.object(backup, "compose", side_effect=compose)
        self.compose = self.compose_patch.start()
        self.archive = self.root / "backup.tar.gz"

    def tearDown(self):
        self.compose_patch.stop()
        self.root_patch.stop()
        self.tmp.cleanup()

    def fixture(self):
        files = self.root / "data" / "files"
        files.mkdir(parents=True)
        (files / "attachment").write_bytes(b"file contents")
        (self.root / ".env").write_text("SECRET=not-for-backups")

    def test_backup_contains_sql_files_but_not_secrets(self):
        self.fixture()
        backup.backup(self.archive)
        with tarfile.open(self.archive) as archive:
            self.assertEqual(archive.extractfile("database.sql").read(), b"SELECT 1;")
            self.assertEqual(archive.extractfile("files/attachment").read(), b"file contents")
            self.assertNotIn(".env", archive.getnames())
        self.assertEqual(self.archive.stat().st_mode & 0o777, 0o600)

    def test_backup_refuses_to_overwrite_existing_archive(self):
        self.archive.write_bytes(b"existing")
        with self.assertRaisesRegex(SystemExit, "already exists"):
            backup.backup(self.archive)
        self.assertEqual(self.archive.read_bytes(), b"existing")

    def test_backup_requires_stopped_writers(self):
        self.compose.side_effect = lambda *a, **kw: subprocess.CompletedProcess(a, 0, stdout="postgres\napp\n")
        with self.assertRaisesRegex(SystemExit, "Stop writers"):
            backup.backup(self.archive)
        self.assertFalse(self.archive.exists())

    def test_restore_requires_explicit_flag(self):
        with self.assertRaisesRegex(SystemExit, "confirm-restore"):
            backup.restore(self.archive, False)
        self.assertEqual(self.calls, [])

    def test_restore_requires_stopped_writers(self):
        self.compose.side_effect = lambda *a, **kw: subprocess.CompletedProcess(a, 0, stdout="app\n")
        with self.assertRaisesRegex(SystemExit, "Stop writers"):
            backup.restore(self.archive, True)

    def test_restore_uses_sql_transaction_and_restores_file(self):
        self.fixture()
        backup.backup(self.archive)
        (self.root / "data/files/attachment").write_bytes(b"changed")
        backup.restore(self.archive, True)
        self.assertEqual((self.root / "data/files/attachment").read_bytes(), b"file contents")
        psql = [c for c in self.calls if "psql" in c[0]][0]
        self.assertIn("--single-transaction", psql[0])
        self.assertIn("ON_ERROR_STOP=1", psql[0])
        self.assertEqual(psql[1]["input"], b"SELECT 1;")

    def test_restore_rejects_traversal_and_links_before_sql(self):
        for name, link in [("../outside", False), ("/absolute", False), ("files/link", True)]:
            with self.subTest(name=name):
                with tarfile.open(self.archive, "w:gz") as archive:
                    member = tarfile.TarInfo(name)
                    if link:
                        member.type = tarfile.SYMTYPE
                        member.linkname = "/etc/passwd"
                    archive.addfile(member, io.BytesIO())
                self.calls.clear()
                with self.assertRaisesRegex(SystemExit, "Unsafe backup"):
                    backup.restore(self.archive, True)
                self.assertFalse(any("psql" in c[0] for c in self.calls))


if __name__ == "__main__":
    unittest.main()

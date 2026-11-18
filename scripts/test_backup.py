"""Offline regression tests. No Docker daemon or real CRM database is accessed."""
from concurrent.futures import ThreadPoolExecutor
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
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
        self.managed = self.root / "backups"

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

    def test_unfinished_archive_is_private_and_cleaned_up(self):
        def inspect(*args, **kwargs):
            staged, = self.root.glob(".crm-backup-*")
            self.assertEqual(staged.stat().st_mode & 0o777, 0o600)
            self.assertFalse(self.archive.exists())
            raise OSError("simulated write failure")

        with patch.object(tarfile.TarFile, "addfile", side_effect=inspect):
            with self.assertRaisesRegex(OSError, "write failure"):
                backup.backup(self.archive)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_backup_refuses_dangling_destination_symlink(self):
        target = self.root / "elsewhere"
        self.archive.symlink_to(target)
        with self.assertRaisesRegex(SystemExit, "already exists"):
            backup.backup(self.archive)
        self.assertTrue(self.archive.is_symlink())
        self.assertFalse(target.exists())

    def test_publication_preserves_file_created_during_backup(self):
        link = backup.os.link

        def competing_writer(source, destination):
            destination.write_bytes(b"earlier backup")
            return link(source, destination)

        with patch.object(backup.os, "link", side_effect=competing_writer):
            with self.assertRaisesRegex(SystemExit, "already exists"):
                backup.backup(self.archive)
        self.assertEqual(self.archive.read_bytes(), b"earlier backup")
        self.assertEqual(list(self.root.glob(".crm-backup-*")), [])

    def test_backup_requires_stopped_writers(self):
        self.compose.side_effect = lambda *a, **kw: subprocess.CompletedProcess(a, 0, stdout="postgres\napp\n")
        with self.assertRaisesRegex(SystemExit, "Stop writers"):
            backup.backup(self.archive)
        self.assertFalse(self.archive.exists())

    def legacy_backup(self, name, mtime, directory=None, extra_member=None):
        """Create a previous-format archive independently of the current backup command."""
        path = (directory or self.managed) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(path, "w:gz") as archive:
            sql = b"SELECT 1;"
            dump = tarfile.TarInfo("database.sql")
            dump.size = len(sql)
            archive.addfile(dump, io.BytesIO(sql))
            files = tarfile.TarInfo("files")
            files.type = tarfile.DIRTYPE
            archive.addfile(files)
            if extra_member:
                archive.addfile(tarfile.TarInfo(extra_member))
        os.utime(path, (mtime, mtime))
        return path

    def test_fourth_backup_keeps_three_newest_by_time(self):
        self.fixture()
        oldest = self.legacy_backup("daily", 100)
        middle = self.legacy_backup("custom-name.tar.gz", 200)
        latest = self.legacy_backup("a-third.tar.gz", 300)
        new = self.managed / "manual.tgz"
        backup.backup(new)
        self.assertFalse(oldest.exists())
        self.assertTrue(all(p.is_file() for p in (middle, latest, new)))

    def test_new_backup_survives_future_timestamps_on_existing_archives(self):
        future = int(time.time()) + 3600
        existing = [self.legacy_backup(f"old-{i}.tar.gz", future + i) for i in range(3)]
        new = self.managed / "new.tar.gz"
        backup.backup(new)
        with tarfile.open(new) as archive:
            self.assertEqual(archive.extractfile("database.sql").read(), b"SELECT 1;")
        self.assertEqual(set(self.managed.glob("*.tar.gz")), {new, *existing[1:]})

    def test_failed_new_backup_preserves_existing_archives(self):
        existing = [self.legacy_backup(f"crm-{i}.tar.gz", i) for i in range(1, 5)]
        with patch.object(backup.os, "link", side_effect=OSError("publish failed")):
            with self.assertRaisesRegex(OSError, "publish failed"):
                backup.backup(self.managed / "new.tar.gz")
        self.assertEqual(set(self.managed.glob("*.tar.gz")), set(existing))

    def test_prune_existing_archives_without_docker_preserves_unmanaged_files(self):
        valid = [self.legacy_backup(f"old-{i}.tar.gz", i) for i in range(1, 6)]
        foreign = self.legacy_backup("crm-unrelated.tar.gz", 1, extra_member="other-app.txt")
        nested = self.legacy_backup("nested.tar.gz", 1, self.managed / "other")
        external = self.legacy_backup("external.tar.gz", 1, self.root / "exports")
        link = self.managed / "crm-link.tar.gz"
        link.symlink_to(external)
        backup.prune()
        backup.prune()
        self.assertEqual(self.calls, [])
        self.assertEqual(set(self.managed.glob("*.tar.gz")), {*valid[-3:], foreign, link})
        self.assertTrue(link.is_symlink())
        self.assertTrue(nested.is_file())
        self.assertTrue(external.is_file())

    def test_prune_retains_all_backups_below_limit(self):
        backup.prune()
        first = self.legacy_backup("first.tar.gz", 1)
        second = self.legacy_backup("second.tar.gz", 2)
        backup.prune()
        self.assertEqual(set(self.managed.glob("*.tar.gz")), {first, second})

    def test_external_output_does_not_rotate_either_directory(self):
        valid = [self.legacy_backup(f"{i}.tar.gz", i) for i in range(4)]
        exports = self.root / "exports"
        outside = [self.legacy_backup(f"{i}.tar.gz", i, exports) for i in range(4)]
        new = exports / "new.tar.gz"
        backup.backup(new)
        self.assertEqual(set(self.managed.glob("*.tar.gz")), set(valid))
        self.assertEqual(set(exports.glob("*.tar.gz")), {*outside, new})

    def test_prune_refuses_redirected_backup_directory(self):
        external = self.root / "exports"
        copies = [self.legacy_backup(f"{i}.tar.gz", i, external) for i in range(4)]
        self.managed.symlink_to(external, target_is_directory=True)
        with self.assertRaises(SystemExit):
            backup.prune()
        self.assertEqual(set(external.glob("*.tar.gz")), set(copies))

    def test_prune_refuses_dangling_lock_before_removing_any_backup(self):
        copies = [self.legacy_backup(f"{i}.tar.gz", i) for i in range(4)]
        target = self.root / "outside-lock"
        lock = self.managed / ".crm-retention.lock"
        lock.symlink_to(target)
        with self.assertRaises(SystemExit):
            backup.prune()
        self.assertFalse(target.exists())
        self.assertTrue(lock.is_symlink())
        self.assertEqual(set(self.managed.glob("*.tar.gz")), set(copies))

    def test_damaged_gzip_trailer_does_not_displace_a_valid_backup(self):
        valid = [self.legacy_backup(f"{i}.tar.gz", i) for i in range(3)]
        damaged = self.legacy_backup("most-recent.tar.gz", 10)
        # The tar and its member headers remain readable, but the gzip CRC/size is incomplete.
        damaged.write_bytes(damaged.read_bytes()[:-4])
        backup.prune()
        self.assertEqual(set(self.managed.glob("*.tar.gz")), {*valid, damaged})

    def test_parallel_backups_leave_three_complete_archives(self):
        self.fixture()
        prior = [self.legacy_backup(f"old-{i}.tar.gz", i) for i in range(3)]
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(backup.backup, [self.managed / f"new-{i}.tar.gz" for i in range(4)]))
        kept = list(self.managed.glob("*.tar.gz"))
        self.assertEqual(len(kept), 3)
        self.assertTrue(set(kept).isdisjoint(prior))
        for path in kept:
            with tarfile.open(path) as archive:
                self.assertEqual(archive.extractfile("files/attachment").read(), b"file contents")

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

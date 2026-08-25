#!/usr/bin/env python3
"""
tools/leak_scan.py — unit tests
===============================

leak_scan.py is the FATAL gate in front of everything we ship: the ACME release
archive, the plugin pack, and (as of the PII remediation) the WorldBuilder
installer workflows, which run it between `dotnet publish` and `makensis`. A
false negative ships a secret; a false positive blocks a release. Both failure
modes are tested here.

Usage:
  python3 tests/test_leak_scan.py            # run all
  python3 tests/test_leak_scan.py -v
  python3 tests/test_leak_scan.py -k Email

No dependencies beyond the stdlib; the scanner is imported straight from
tools/leak_scan.py by path, so the tests run from a bare checkout.
"""

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCANNER = REPO / "tools" / "leak_scan.py"

_spec = importlib.util.spec_from_file_location("leak_scan", SCANNER)
leak_scan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(leak_scan)


class ScanCase(unittest.TestCase):
    """Writes bytes to a temp file and asserts on what the scanner finds."""

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory(prefix="leakscan-test-")
        self.dir = Path(self._dir.name)

    def tearDown(self):
        self._dir.cleanup()

    def write(self, name, payload, encoding="ascii"):
        """payload: str (encoded as asked) or bytes (written raw)."""
        path = self.dir / name
        if isinstance(payload, bytes):
            data = payload
        elif encoding == "utf-16-le":
            data = payload.encode("utf-16-le")
        else:
            data = payload.encode("utf-8")
        path.write_bytes(data)
        return str(path)

    def hits(self, payload, name="sample.txt", encoding="ascii", all_files=False):
        return leak_scan.scan_file(self.write(name, payload, encoding),
                                   all_files=all_files)

    def assertLeaks(self, payload, msg=None, **kw):
        h = self.hits(payload, **kw)
        self.assertTrue(h, msg or f"expected a hit for {payload!r}, got none")
        return h

    def assertClean(self, payload, msg=None, **kw):
        h = self.hits(payload, **kw)
        self.assertFalse(h, msg or f"expected no hit for {payload!r}, got {h}")


# ─────────────────────────────────────────────────────────────
# The literals that were already gated — these must not regress
# ─────────────────────────────────────────────────────────────

class TestExistingLiterals(ScanCase):

    def test_credentials(self):
        self.assertLeaks("account=tailnet1")
        self.assertLeaks("password=phase4demo")

    def test_dev_hosts_and_paths(self):
        self.assertLeaks("ssh wbterminal")
        self.assertLeaks("/mnt/wbterminal2/pbr-terrain/picker")
        self.assertLeaks("/home/someone/checkout")
        self.assertLeaks("ac-dat-test")

    def test_case_is_folded_for_paths(self):
        self.assertLeaks("/HOME/SOMEONE/")
        self.assertLeaks("TAILNET1")

    def test_dev_server_address(self):
        self.assertLeaks("http://100.116.47.66:9000/")

    def test_cgnat_sweep_bounds(self):
        # 100.64.0.0/10 is 100.64.x.x through 100.127.x.x, inclusive.
        self.assertLeaks("100.64.0.1")
        self.assertLeaks("100.127.215.75")
        self.assertLeaks("100.100.1.2")
        # Just outside the range on both sides: public addresses, not ours.
        self.assertClean("100.63.255.254")
        self.assertClean("100.128.0.1")

    def test_utf16le_is_scanned(self):
        """The r10 miss: .NET stores string literals as UTF-16LE."""
        h = self.assertLeaks("client=/mnt/wbterminal2/ac", encoding="utf-16-le",
                             name="assembly.bin")
        self.assertTrue(any(enc == "utf-16le" for enc, _, _ in h))

    def test_allowlisted_upstream_ci_path_is_suppressed(self):
        self.assertClean("/home/runner/work/Chorizite/Chorizite/src")

    def test_allowlist_is_not_a_blanket(self):
        """A real leak sitting next to an allowlisted string still fires."""
        h = self.hits("/home/runner/work/x and /home/realuser/secret")
        self.assertEqual(1, len(h), h)


class TestFileClasses(ScanCase):

    def test_opaque_extensions_skipped_by_default(self):
        self.assertClean("/mnt/wbterminal2/x", name="world.dat")
        self.assertClean("/mnt/wbterminal2/x", name="shot.png")

    def test_all_files_promotes_them(self):
        self.assertLeaks("/mnt/wbterminal2/x", name="world.dat", all_files=True)

    def test_empty_file_is_clean(self):
        self.assertClean(b"")


# ─────────────────────────────────────────────────────────────
# NEW: Windows / macOS home directories
# ─────────────────────────────────────────────────────────────

class TestHomeDirectoryLiterals(ScanCase):

    def test_windows_user_path(self):
        self.assertLeaks(r"C:\Users\young\AppData\Local\WorldBuilder")

    def test_windows_user_path_is_drive_letter_agnostic(self):
        self.assertLeaks(r"D:\Users\someone\src")
        self.assertLeaks(r"E:\Users\other\src")

    def test_windows_user_path_in_utf16le(self):
        """The form it takes inside a .NET assembly."""
        h = self.assertLeaks(r"C:\Users\young\src", encoding="utf-16-le",
                             name="AcmeLauncher.dll")
        self.assertTrue(any(enc == "utf-16le" for enc, _, _ in h))

    def test_macos_user_path(self):
        self.assertLeaks("/Users/someone/Projects/WorldBuilder")

    def test_users_without_the_path_shape_is_clean(self):
        """Prose, a URL path segment, and a plural noun are not home directories."""
        self.assertClean("Users of the editor should read the manual.")
        self.assertClean("https://example.com/api/v1/users/42")
        self.assertClean('{"$ref": "#/components/schemas/users/name"}')

    def test_upstream_package_author_paths_are_allowlisted(self):
        """
        Real assemblies in the win-x64 publish output. These are the paths of the
        AUTHORS of NuGet packages we consume, baked into their own shipped DLLs.
        We cannot rebuild them, and blocking on them would make the gate
        unpassable — which is worse than useless, because it gets switched off.
        """
        self.assertClean("/home/kekekeks/Projects/MicroCom/src/MicroCom.Runtime")
        self.assertClean(r"C:\Users\markh\code\mygithub\NAudio\NAudio.Core\obj")


# ─────────────────────────────────────────────────────────────
# NEW: e-mail addresses
# ─────────────────────────────────────────────────────────────

class TestEmailSweep(ScanCase):

    def test_real_address_is_caught(self):
        self.assertLeaks("git config user.email salvia420@gmail.com")

    def test_address_in_a_patch_or_script(self):
        self.assertLeaks('AUTHOR="Some One <someone@example.com>"')

    def test_address_in_utf16le(self):
        h = self.assertLeaks("contact someone@example.com", encoding="utf-16-le",
                             name="Acme.dll")
        self.assertTrue(any(enc == "utf-16le" for enc, _, _ in h))

    def test_subdomains_and_plus_addressing(self):
        self.assertLeaks("someone+tag@mail.corp.example.com")

    def test_binary_noise_does_not_fire(self):
        """
        The gate also runs with --all-files over dats and PNGs. These are real
        byte sequences pulled out of shipped images in this repo by a naive
        e-mail regex; each must miss, or the ACME release gate cries wolf.
        """
        for noise in ["E@t.QX", "b@2.zX", "9y.l@g.rL", "k9@5.GC", "S@Hw.ZH",
                      "3@HJ2EOe.IPfBO", "N@JQJUR.KZ", "xxU@R.bs"]:
            self.assertClean(noise, f"binary noise {noise!r} must not fire")

    def test_too_short_local_part_does_not_fire(self):
        self.assertClean("a@b.com")

    def test_not_an_address_without_a_tld(self):
        self.assertClean("someone@localhost")
        self.assertClean("user@192.168.1.10")

    def test_boundary_guards(self):
        """A TLD must end the token — a digit right after it means it is not one."""
        self.assertClean("someone@example.com9")

    def test_trailing_punctuation_still_fires(self):
        """The commonest shape in prose: an address ending a sentence."""
        self.assertLeaks("Write to someone@example.com.")
        self.assertLeaks("<mailto:someone@example.com>")


# ─────────────────────────────────────────────────────────────
# NEW: the case-sensitivity split, and what must NEVER be gated
# ─────────────────────────────────────────────────────────────

class TestCaseSensitiveLiterals(ScanCase):

    def test_buildbox_hostname_is_caught(self):
        self.assertLeaks("ssh buildbox 'dotnet build'")
        self.assertLeaks("/home/x/buildbox-out")   # also via /home/

    def test_buildbox_does_not_fire_on_an_identifier(self):
        """
        `BuildBoxGeometry` is a real method in
        WorldBuilder/Editors/Landscape/TransformGizmo.cs. Its name lands in
        WorldBuilder.dll's metadata, so a case-folded "buildbox" match blocked
        every single build of the editor.
        """
        self.assertClean("BuildBoxGeometry")
        self.assertClean("private void BuildBoxGeometry(Vector3 min)")


class TestShippedGameDataIsNotPII(ScanCase):
    """
    The surname in the dev-box account is also an Asheron's Call creature-name
    word and appears in shipped content (pipeline_data/, town_kits/,
    AcmeRagdoll/ragdoll_profiles.json). It must be caught STRUCTURALLY — via the
    path prefixes and the e-mail sweep — and never as a bare literal, or the gate
    would reject the game data we ship.
    """

    def test_creature_names_are_clean(self):
        self.assertClean("Young Banderling")
        self.assertClean('{"name": "Young Olthoi Queen", "wcid": 1234}')
        self.assertClean("a young drudge slinker")

    def test_the_same_word_as_an_account_still_leaks(self):
        self.assertLeaks("young@100.127.215.75")           # user@host
        self.assertLeaks(r"C:\Users\young\Desktop")        # windows home
        self.assertLeaks("/home/young/checkout")           # posix home
        self.assertLeaks("young@example.com")              # e-mail


# ─────────────────────────────────────────────────────────────
# CLI contract — the workflows depend on the exit code
# ─────────────────────────────────────────────────────────────

class TestCliContract(ScanCase):

    def run_scanner(self, *args):
        return subprocess.run([sys.executable, str(SCANNER), *args],
                              capture_output=True, text=True)

    def test_clean_tree_exits_zero(self):
        self.write("ok.txt", "nothing to see here")
        r = self.run_scanner(str(self.dir))
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("leak gate clean", r.stdout)

    def test_dirty_tree_exits_one(self):
        self.write("bad.txt", "password=phase4demo")
        r = self.run_scanner(str(self.dir))
        self.assertEqual(1, r.returncode)
        self.assertIn("LEAK", r.stdout)
        self.assertIn("LEAK GATE FAILED", r.stderr)

    def test_missing_path_exits_two(self):
        r = self.run_scanner(str(self.dir / "nope"))
        self.assertEqual(2, r.returncode)

    def test_quiet_suppresses_only_the_clean_line(self):
        self.write("ok.txt", "fine")
        r = self.run_scanner("--quiet", str(self.dir))
        self.assertEqual(0, r.returncode)
        self.assertEqual("", r.stdout.strip())


class TestThirdPartyNoiseSuppression(ScanCase):
    """
    The gate exists to stop OUR identity shipping. Three upstream artifacts in
    the plugin pack tripped it while disclosing nothing about us, and each is
    handled as narrowly as it can be. These tests pin the narrowness: every
    suppression here is paired with a case that must still FAIL.
    """

    # --- ":\\Users\\" with no account name after it is a path TEMPLATE ---

    def test_bare_users_prefix_is_a_template_not_a_leak(self):
        # Chorizite.Injector.dll: "C:\Users\" and the rest of the path are two
        # separate literals; the name is filled in at run time.
        self.assertClean("C:\\Users\\\x00\\AppData\\Local\\Temp\\SymbolCache")

    def test_users_prefix_with_a_real_name_still_leaks(self):
        self.assertLeaks("C:\\Users\\young\\Desktop\\notes.txt")

    def test_users_prefix_with_a_name_in_utf16_still_leaks(self):
        self.assertLeaks("C:\\Users\\young\\AppData", encoding="utf-16-le")

    def test_bare_users_template_in_utf16_is_clean(self):
        self.assertClean("C:\\Users\\\x00", encoding="utf-16-le")

    def test_other_drive_letters_are_still_gated(self):
        self.assertLeaks("D:\\Users\\someone\\src")

    # --- the third-party author's own attribution ---

    def test_upstream_author_contact_is_allowlisted(self):
        self.assertClean("Copyright (C) 2009 Aikar@Windower.net")

    def test_a_different_address_at_the_same_domain_still_leaks(self):
        self.assertLeaks("someoneelse@Windower.net")

    # --- notices files are exempt from the E-MAIL SWEEP ONLY ---

    def test_notices_file_may_carry_upstream_attribution_addresses(self):
        self.assertClean("jloup@gzip.org  madler@alumni.caltech.edu",
                         name="dotnet-THIRD-PARTY-NOTICES.TXT")

    def test_notices_exemption_is_case_insensitive_on_the_basename(self):
        self.assertClean("dotnet@microsoft.com",
                         name="DOTNET-third-party-NOTICES.txt")

    def test_notices_file_still_fails_on_OUR_identifiers(self):
        # The exemption is e-mail only. Our hostnames/credentials/range must
        # still fail the gate inside a notices file.
        self.assertLeaks("built on buildbox by tailnet1",
                         name="dotnet-THIRD-PARTY-NOTICES.TXT")

    def test_notices_file_still_fails_on_our_tailnet_address(self):
        self.assertLeaks("server 100.116.47.66",
                         name="dotnet-THIRD-PARTY-NOTICES.TXT")

    def test_notices_file_still_fails_on_a_windows_home_path(self):
        self.assertLeaks("C:\\Users\\young\\build",
                         name="dotnet-THIRD-PARTY-NOTICES.TXT")

    def test_the_exemption_does_not_generalise_to_other_filenames(self):
        # Exact basenames only - no suffix matching, or any file could opt out
        # of the e-mail sweep by renaming itself.
        self.assertLeaks("jloup@gzip.org",
                         name="vendor-THIRD-PARTY-NOTICES.TXT")


class TestScannerFileHygiene(unittest.TestCase):
    """
    The scanner must stay auditable with the tools people audit it with.
    ripgrep silently SKIPS any file containing a NUL byte during a directory
    walk, so a stray "\\x00" in a non-raw string literal would make leak_scan.py
    itself invisible to `rg`. (This is not hypothetical: it is exactly what
    hid WorldBuilder/ViewModels/TexturePickerPanelViewModel.cs from every
    repo-wide grep during the PII audit.)
    """

    def test_no_nul_bytes_in_the_scanner_source(self):
        self.assertEqual(0, SCANNER.read_bytes().count(0))


if __name__ == "__main__":
    unittest.main(verbosity=2)

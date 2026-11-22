import os
import tempfile
import unittest
from pathlib import Path
from omp_away_tunnel.identity import IdentityStore, private_directory


class PrivateStateTest(unittest.TestCase):
    def test_public_directory_rejected_before_key_creation(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'empty'
            private_directory(target)
            if os.name == 'nt':
                import win32security as sec
                kind = sec.DACL_SECURITY_INFORMATION
                acl = sec.GetNamedSecurityInfo(str(target), sec.SE_FILE_OBJECT, kind).GetSecurityDescriptorDacl()
                world = sec.CreateWellKnownSid(sec.WinWorldSid, None)
                acl.AddAccessAllowedAce(sec.ACL_REVISION, 0x120089, world)  # FILE_GENERIC_READ on empty test directory
                sec.SetNamedSecurityInfo(str(target), sec.SE_FILE_OBJECT, kind, None, None, acl, None)
            else:
                target.chmod(0o755)
            with self.assertRaises(PermissionError):
                IdentityStore(target)
            self.assertFalse(list(target.iterdir()))

    def test_corrupt_registry_never_regenerates_or_replaces_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            identity = IdentityStore(Path(temp) / 'state')
            identity.path.write_bytes(b'{corrupt')
            with self.assertRaises(ValueError):
                IdentityStore(identity.directory)
            self.assertEqual(identity.path.read_bytes(), b'{corrupt')

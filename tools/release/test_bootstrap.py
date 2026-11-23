from pathlib import Path
import tempfile
import unittest
import io
import tarfile
import os
import zipfile

import bootstrap



class BootstrapTests(unittest.TestCase):
    @unittest.skipIf(os.name == 'nt', 'Linux bootstrap symlinks require Unix semantics')
    def test_jdk_internal_links_are_allowed_but_external_links_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'tool.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                info = tarfile.TarInfo('jdk/lib/actual')
                info.size = 4
                tar.addfile(info, io.BytesIO(b'tool'))
                link = tarfile.TarInfo('jdk/lib/link')
                link.type = tarfile.SYMTYPE
                link.linkname = 'actual'
                tar.addfile(link)
            bootstrap.extract(archive, root / 'install')
            self.assertEqual((root / 'install/jdk/lib/link').read_bytes(), b'tool')
            with tarfile.open(archive, 'w:gz') as tar:
                link = tarfile.TarInfo('jdk/link')
                link.type = tarfile.SYMTYPE
                link.linkname = '../../outside'
                tar.addfile(link)
            with self.assertRaises(ValueError):
                bootstrap.extract(archive, root / 'bad')

    def test_tool_archive_cannot_escape_install_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'tool.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('../escape', b'bad')
            with self.assertRaises(ValueError):
                bootstrap.extract(archive, root / 'install')
            self.assertFalse((root / 'escape').exists())

    def test_tool_archive_restores_executable_permission(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'tool.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                info = zipfile.ZipInfo('bin/tool')
                info.external_attr = 0o100755 << 16
                z.writestr(info, b'tool')
            bootstrap.extract(archive, root / 'install')
            self.assertEqual((root / 'install/bin/tool').read_bytes(), b'tool')


if __name__ == '__main__':
    unittest.main()

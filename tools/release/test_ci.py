import base64
from pathlib import Path
import tempfile
import unittest

from ci import stage_secret


class SecretTests(unittest.TestCase):
    def test_missing_or_invalid_secret_fails_without_creating_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'secret'
            for value in ('', 'invalid base64!'):
                with self.assertRaises(ValueError):
                    stage_secret(value, path)
                self.assertFalse(path.exists())

    def test_secret_file_contains_only_decoded_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'secret'
            stage_secret(base64.b64encode(b'fixture').decode(), path)
            self.assertEqual(path.read_bytes(), b'fixture')
            with self.assertRaises(FileExistsError):
                stage_secret(base64.b64encode(b'other').decode(), path)


if __name__ == '__main__':
    unittest.main()

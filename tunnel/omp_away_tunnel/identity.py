"""One atomic identity + peer registry, inaccessible to other ordinary users."""
import base64
import hashlib
import json
import os
import re
import stat
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


ROUTE = re.compile(r'[A-Za-z0-9_-]{1,128}\Z')


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def digest_bytes(value):
    if not isinstance(value, str) or not re.fullmatch('[A-Za-z0-9_-]{43}', value):
        raise ValueError('invalid digest')
    data = base64.urlsafe_b64decode(value + '=')
    if b64(data) != value:
        raise ValueError('noncanonical digest')
    return data


def spki(key):
    return key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


def pin_of(cert):
    return b64(hashlib.sha256(spki(cert.public_key())).digest())


def checked_path(path, *, directory):
    st = path.lstat()
    if not (stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode)) or getattr(st, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise PermissionError('unsafe state path')
    if not directory and st.st_nlink != 1:
        raise PermissionError('linked state file')
    if os.name == 'nt':
        import win32security as sec
        desc = sec.GetNamedSecurityInfo(str(path), sec.SE_FILE_OBJECT, sec.OWNER_SECURITY_INFORMATION | sec.DACL_SECURITY_INFORMATION)
        sid = _user_sid()
        acl = desc.GetSecurityDescriptorDacl()
        if desc.GetSecurityDescriptorOwner() != sid or not acl or acl.GetAceCount() == 0:
            raise PermissionError('state ACL is not private')
        for i in range(acl.GetAceCount()):
            header, mask, trustee = acl.GetAce(i)
            if header[0] != sec.ACCESS_ALLOWED_ACE_TYPE or trustee != sid:
                raise PermissionError('state ACL is not private')
        if directory and not desc.GetSecurityDescriptorControl()[0] & 0x1000:  # SE_DACL_PROTECTED
            raise PermissionError('state directory inherits ACL')
    elif st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077:
        raise PermissionError('state path is not owner-only')


def _user_sid():
    import win32api
    import win32con
    import win32security as sec
    token = sec.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        return sec.GetTokenInformation(token, sec.TokenUser)[0]
    finally:
        token.Close()


def private_directory(path):
    if not path.is_absolute() or '..' in path.parts or path == path.parent:
        raise ValueError('state directory must be absolute')
    if not path.parent.exists():
        private_directory(path.parent)
    for ancestor in reversed(path.parents):
        if ancestor.is_symlink() or getattr(ancestor.lstat(), 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise PermissionError('linked state ancestor')
    if os.name == 'nt':
        import pywintypes
        import win32file
        import win32security as sec
        sid = sec.ConvertSidToStringSid(_user_sid())
        sa = pywintypes.SECURITY_ATTRIBUTES()
        sa.SECURITY_DESCRIPTOR = sec.ConvertStringSecurityDescriptorToSecurityDescriptor(f'O:{sid}D:P(A;OICI;FA;;;{sid})', 1)
        try:
            win32file.CreateDirectory(str(path), sa)
        except pywintypes.error as err:
            if err.winerror != 183:  # ERROR_ALREADY_EXISTS
                raise
    else:
        path.mkdir(mode=0o700, exist_ok=True)
    checked_path(path, directory=True)


@contextmanager
def locked(directory):
    path = directory / 'registry.lock'
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'r+b') as file:
        checked_path(path, directory=False)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield  # Closing the handle releases the OS lock, including on process death.


class IdentityStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        private_directory(self.directory)
        self.path = self.directory / 'identity.json'
        with locked(self.directory):
            try:
                data = self._read()
            except FileNotFoundError:
                key = ec.generate_private_key(ec.SECP256R1())
                name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'omp-away')])
                now = datetime.now(timezone.utc)
                cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                        .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
                        .not_valid_after(now + timedelta(days=3650)).sign(key, hashes.SHA256()))
                data = {'v': 1, 'cert': cert.public_bytes(serialization.Encoding.PEM).decode(),
                        'key': key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode(), 'peers': {}}
                self._save(data)
            self.cert = x509.load_pem_x509_certificate(data['cert'].encode())
            self.key = serialization.load_pem_private_key(data['key'].encode(), password=None)
            if spki(self.key.public_key()) != spki(self.cert.public_key()):
                raise ValueError('inconsistent private identity')
            self.pin = pin_of(self.cert)
            self.peers = data['peers']

    def _read(self):
        checked_path(self.path, directory=False)
        with self.path.open('rb') as f:
            raw = f.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError('registry too large')
        data = json.loads(raw)
        peers = data['peers']
        if data['v'] != 1 or not isinstance(peers, dict) or len(peers) > 1024 or len(set(peers.values())) != len(peers):
            raise ValueError('invalid registry')
        for device, pin in peers.items():
            if not ROUTE.fullmatch(device):
                raise ValueError('invalid device')
            digest_bytes(pin)
        return data

    def _save(self, data):
        fd, tmp = tempfile.mkstemp(dir=self.directory)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                checked_path(Path(tmp), directory=False)
                json.dump(data, f, separators=(',', ':'))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
            if os.name != 'nt':
                fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        finally:
            Path(tmp).unlink(missing_ok=True)

    def register(self, device, pin):
        digest_bytes(pin)
        if not ROUTE.fullmatch(device):
            raise ValueError('invalid route')
        with locked(self.directory):
            data = self._read()
            if data['cert'] != self.cert.public_bytes(serialization.Encoding.PEM).decode() or device in data['peers'] or pin in data['peers'].values() or len(data['peers']) >= 1024:
                raise ValueError('registration conflict')
            data['peers'][device] = pin
            self._save(data)
            self.peers = data['peers']

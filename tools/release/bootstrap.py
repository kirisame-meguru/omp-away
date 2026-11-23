"""Prepare pinned build tools on Linux x86_64 CI; never runs on consumer install."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import subprocess
import tarfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


def download(url, destination):
    if not url.startswith('https://'):
        raise ValueError('tool downloads require HTTPS')
    with urllib.request.urlopen(url, timeout=120) as response, destination.open('wb') as output:
        if not response.url.startswith('https://'):
            raise ValueError('insecure tool download redirect')
        shutil.copyfileobj(response, output)


def checked_download(url, destination, digest, algorithm='sha256'):
    download(url, destination)
    with destination.open('rb') as stream:
        digest_state = hashlib.new(algorithm)
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest_state.update(chunk)
        actual = digest_state.hexdigest()
    if actual != digest.lower():
        raise ValueError('tool archive checksum mismatch')


def extract(source, destination):
    destination.mkdir(parents=True, exist_ok=True)
    def safe(name):
        p = PurePosixPath(name)
        if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name:
            raise ValueError('unsafe tool archive')
    if source.suffix == '.zip':
        with zipfile.ZipFile(source) as z:
            for info in z.infolist():
                safe(info.filename)
                if stat.S_ISLNK(info.external_attr >> 16):
                    raise ValueError('tool archive symlinks are not allowed')
            z.extractall(destination)
            for info in z.infolist():
                if not info.is_dir():
                    (destination / info.filename).chmod(0o755 if info.external_attr >> 16 & 0o111 else 0o644)
    else:
        with tarfile.open(source) as tar:
            for info in tar.getmembers():
                safe(info.name)
                if not (info.isfile() or info.isdir() or info.issym() or info.islnk()):
                    raise ValueError('tool archive special entries are not allowed')
                if info.issym() or info.islnk():
                    target = ((destination / info.name).parent if info.issym() else destination) / info.linkname
                    if destination.resolve() not in target.resolve().parents:
                        raise ValueError('tool archive link escapes install directory')
            # Extract data first so no archive-controlled symlink can redirect a write.
            for info in tar.getmembers():
                path = destination / info.name
                if info.isdir():
                    path.mkdir(parents=True, exist_ok=True)
                elif info.isfile():
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(info) as source, path.open('wb') as output:
                        shutil.copyfileobj(source, output)
                    path.chmod(info.mode & 0o777)
            for info in tar.getmembers():
                path = destination / info.name
                if info.issym():
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.symlink_to(info.linkname)
                elif info.islnk():
                    path.parent.mkdir(parents=True, exist_ok=True)
                    os.link(destination / info.linkname, path)


def upstream_digest(url, filename):
    with urllib.request.urlopen(url, timeout=120) as response:
        lines = response.read().decode().splitlines()
    for line in lines:
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip('*./') == filename:
            return parts[0]
        if len(parts) == 1 and len(parts[0]) == 64:
            return parts[0]
    raise ValueError('upstream checksum manifest omitted pinned tool')


def bootstrap(root):
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'amd64'):
        raise ValueError('CI bootstrap supports Linux amd64; local builds use documented pinned tools')
    root.mkdir(parents=True, exist_ok=False)
    java_version = '17.0.17_10'
    java_filename = f'OpenJDK17U-jdk_x64_linux_hotspot_{java_version}.tar.gz'
    java_url = 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.17%2B10/' + java_filename
    java_archive = root / java_filename
    checked_download(java_url, java_archive, upstream_digest(java_url + '.sha256.txt', java_filename))
    extract(java_archive, root)
    java_home = str(root / 'jdk-17.0.17+10')

    with urllib.request.urlopen('https://go.dev/dl/?mode=json&include=all', timeout=120) as response:
        releases = json.load(response)
    go = next(f for r in releases if r['version'] == 'go1.26.0' for f in r['files'] if f['filename'] == 'go1.26.0.linux-amd64.tar.gz')
    go_archive = root / go['filename']
    checked_download('https://go.dev/dl/' + go['filename'], go_archive, go['sha256'])
    extract(go_archive, root)

    for name, version, filename, checksum_file in (
        ('oven-sh/bun', 'bun-v1.4.4', 'bun-linux-x64.zip', 'SHASUMS256.txt'),
        ('astral-sh/uv', '0.9.5', 'uv-x86_64-unknown-linux-gnu.tar.gz', 'uv-x86_64-unknown-linux-gnu.tar.gz.sha256'),
    ):
        base = f'https://github.com/{name}/releases/download/{version}/'
        archive = root / filename
        checked_download(base + filename, archive, upstream_digest(base + checksum_file, filename))
        extract(archive, root)

    gradle = root / 'gradle-8.14.3-bin.zip'
    gradle_url = 'https://services.gradle.org/distributions/' + gradle.name
    checked_download(gradle_url, gradle, upstream_digest(gradle_url + '.sha256', gradle.name))
    extract(gradle, root)

    # Google's repository metadata provides a checksum for this exact command-line tools revision.
    with urllib.request.urlopen('https://dl.google.com/android/repository/repository2-3.xml', timeout=120) as response:
        tree = ET.fromstring(response.read())
    filename = 'commandlinetools-linux-13114758_latest.zip'
    match = next(archive for archive in tree.iter('complete') if archive.findtext('url') == filename)
    sdk_zip = root / filename
    checksum = match.find('checksum')
    checked_download('https://dl.google.com/android/repository/' + filename, sdk_zip,
                     checksum.text.strip(), checksum.attrib.get('type', 'sha1'))
    sdk = root / 'android-sdk'
    extract(sdk_zip, sdk / 'cmdline-tools/bootstrap')
    sdkmanager = sdk / 'cmdline-tools/bootstrap/cmdline-tools/bin/sdkmanager'
    env = os.environ.copy()
    if java_home:
        env['JAVA_HOME'] = java_home
    subprocess.run([str(sdkmanager), '--sdk_root=' + str(sdk), '--licenses'], input='y\n' * 100,
                   text=True, check=True, env=env, stdout=subprocess.DEVNULL)
    subprocess.run([str(sdkmanager), '--sdk_root=' + str(sdk), 'platforms;android-36', 'build-tools;36.0.0'],
                   check=True, env=env)
    uv = root / 'uv-x86_64-unknown-linux-gnu/uv'
    subprocess.run([str(uv), 'python', 'install', '3.12.8'], check=True)
    python = subprocess.run([str(uv), 'python', 'find', '3.12.8'], check=True, capture_output=True, text=True).stdout.strip()
    bins = [str(Path(python).parent), str(root / 'go/bin'), str(root / 'bun-linux-x64'),
            str(uv.parent), str(root / 'gradle-8.14.3/bin')]
    if java_home:
        bins.insert(0, str(Path(java_home) / 'bin'))
    # Shared local/CI contract; no shell evaluation of generated text is needed.
    return {'PATH': os.pathsep.join(bins + [os.environ['PATH']]), 'ANDROID_HOME': str(sdk),
            'JAVA_HOME': java_home or '', 'GOTOOLCHAIN': 'local'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--environment', type=Path, required=True)
    args = parser.parse_args()
    args.environment.write_text(json.dumps(bootstrap(args.directory.resolve())), encoding='utf-8')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, StopIteration, subprocess.CalledProcessError):
        raise SystemExit('tool bootstrap failed; verify pinned upstream archives and Linux runner prerequisites') from None

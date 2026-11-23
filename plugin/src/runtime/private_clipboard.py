"""Write a single local enrollment from stdin. Never put it in argv or output."""
import struct
import sys

import win32clipboard as clipboard
import win32con
import win32gui


def main():
    payload = sys.stdin.buffer.read(4097)
    if not 0 < len(payload) <= 4096:
        return 1
    text = payload.decode('ascii')
    # A hidden window, rather than a NULL owner (SetClipboardData after EmptyClipboard requires an owner).
    owner = win32gui.CreateWindow('STATIC', '', 0, 0, 0, 0, 0, 0, 0, 0, None)
    try:
        clipboard.OpenClipboard(owner)
        try:
            clipboard.EmptyClipboard()
            for name in ('CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard'):
                clipboard.SetClipboardData(clipboard.RegisterClipboardFormat(name), struct.pack('<I', 0))
            clipboard.SetClipboardData(clipboard.RegisterClipboardFormat('ExcludeClipboardContentFromMonitorProcessing'), b'\0')
            clipboard.SetClipboardText(text, win32con.CF_UNICODETEXT)
        finally:
            clipboard.CloseClipboard()
    finally:
        win32gui.DestroyWindow(owner)
    return 0


if __name__ == '__main__':
    sys.exit(main())

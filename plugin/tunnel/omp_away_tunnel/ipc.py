import asyncio
import os
import struct
import sys
from .identity import ROUTE
from .transport import HEADER, PCM_SIZE, ProtocolError, encode, object_json

# Room for a maximum-size inner control plus its local routing envelope.
IPC_JSON_LIMIT = 131072


def frame_size(kind, size):
    if not (kind == 1 and 0 < size <= IPC_JSON_LIMIT or kind == 2 and PCM_SIZE + 22 <= size <= PCM_SIZE + 149):
        raise ProtocolError('invalid helper frame')


def decode_frame(kind, data):
    frame_size(kind, len(data))
    if kind == 1:
        return object_json(data)
    seq, n = struct.unpack_from('!IB', data)
    device = data[5:5+n].decode('ascii')
    if len(data) != 21 + n + PCM_SIZE or not ROUTE.fullmatch(device):
        raise ProtocolError('invalid media route')
    return {'op': 'pcm', 'deviceId': device, 'ref': data[5+n:21+n].hex(), 'id': seq, 'pcm': data[21+n:]}


class Stdio:
    def __init__(self):
        if os.name == 'nt':
            import msvcrt
            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
            msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
        self.lock = asyncio.Lock()

    def _read_frame(self):
        header = sys.stdin.buffer.read(5)
        if not header:
            raise EOFError
        if len(header) != 5:
            raise ProtocolError('short header')
        kind, size = HEADER.unpack(header)
        frame_size(kind, size)
        data = sys.stdin.buffer.read(size)
        if len(data) != size:
            raise ProtocolError('short helper frame')
        return kind, data

    async def read_frame(self):
        return await asyncio.to_thread(self._read_frame)

    async def read(self):
        return decode_frame(*(await self.read_frame()))

    def _write(self, kind, data):
        sys.stdout.buffer.write(HEADER.pack(kind, len(data)) + data)
        sys.stdout.buffer.flush()

    async def write(self, kind, data):
        async with self.lock:
            write = asyncio.create_task(asyncio.to_thread(self._write, kind, data))
            try:
                await asyncio.shield(write)
            except asyncio.CancelledError:
                await write  # Keep the pipe serialized until the blocking write finishes.
                raise

    async def event(self, **msg):
        data = encode(msg)
        if len(data) > IPC_JSON_LIMIT:
            raise ProtocolError('helper message too large')
        await self.write(1, data)

    async def media(self, device, ref, pcm):
        route = device.encode('ascii')
        await self.write(2, struct.pack('!IB', 0, len(route)) + route + bytes.fromhex(ref) + pcm)

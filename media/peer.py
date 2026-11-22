"""One Codex media peer. stdin/stdout are framed, never logs; no OS audio devices."""
import asyncio
from collections import deque
from fractions import Fraction
import json
import struct
import sys

from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCRtpSender, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError
from av import AudioFrame, AudioResampler

RATE = 24000
SAMPLES = 480
PHONE_BYTES = 2 * SAMPLES
JSON, PCM = 1, 2
CONTROL_MAX = 65536
HEADER = struct.Struct('>BI')


class MicrophoneTrack(AudioStreamTrack):
    def __init__(self):
        super().__init__()
        self.frames = deque(maxlen=10)
        self.next_time = None
        self.pts = 0
        self.silence = bytes(PHONE_BYTES)

    def push(self, pcm):
        if len(pcm) != PHONE_BYTES:
            raise ValueError('bad PCM frame')
        self.frames.append((asyncio.get_running_loop().time(), pcm))

    async def recv(self):
        if self.readyState != 'live':
            raise MediaStreamError
        loop = asyncio.get_running_loop()
        now = loop.time()
        if self.next_time is not None:
            await asyncio.sleep(max(0, self.next_time - now))
        now = loop.time()
        self.next_time = now + .020
        while self.frames and now - self.frames[0][0] > .200:
            self.frames.popleft()
        frame = AudioFrame(format='s16', layout='mono', samples=SAMPLES)
        frame.planes[0].update(self.frames.popleft()[1] if self.frames else self.silence)
        frame.pts, frame.time_base, frame.sample_rate = self.pts, Fraction(1, RATE), RATE
        self.pts += SAMPLES
        return frame

    def stop(self):
        self.frames.clear()
        super().stop()


async def receive_pcm(track, emit):
    resampler = AudioResampler(format='s16', layout='mono', rate=RATE, frame_size=SAMPLES)
    while True:
        decoded = await track.recv()
        for frame in resampler.resample(decoded):
            if frame.samples != SAMPLES:
                raise ValueError('bad decoder output')
            # FFmpeg may pad planes beyond the valid samples.
            emit(bytes(memoryview(frame.planes[0])[:PHONE_BYTES]))


class Peer:
    def __init__(self, emit, failed):
        if sys.byteorder != 'little':
            raise RuntimeError('s16 little endian required')
        self.pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        self.source = MicrophoneTrack()
        self.closed = False
        self.drain = None
        transceiver = self.pc.addTransceiver(self.source, direction='sendrecv')
        codecs = [c for c in RTCRtpSender.getCapabilities('audio').codecs if c.mimeType.lower() == 'audio/opus']
        if not codecs:
            raise RuntimeError('no Opus encoder')
        transceiver.setCodecPreferences(codecs)
        self.events = self.pc.createDataChannel('oai-events')
        # The authenticated SDK sideband is the sole owner of events; never bridge SCTP to the phone.
        self.opened = asyncio.Event()
        self.events.on('open', self.opened.set)

        @self.pc.on('track')
        def track(remote):
            if self.drain is not None or remote.kind != 'audio':
                failed(); return
            self.drain = asyncio.create_task(receive_pcm(remote, emit))
            def finished(task):
                if not task.cancelled():
                    task.exception()
                if not self.closed:
                    failed()
            self.drain.add_done_callback(finished)

        @self.pc.on('connectionstatechange')
        def state():
            if not self.closed and self.pc.connectionState in ('failed', 'closed', 'disconnected'):
                failed()

        @self.events.on('close')
        def data_closed():
            if not self.closed:
                failed()

    async def offer(self):
        await self.pc.setLocalDescription(await self.pc.createOffer())
        return self.pc.localDescription.sdp

    async def answer(self, sdp):
        await self.pc.setRemoteDescription(RTCSessionDescription(sdp, 'answer'))
        if self.drain is None or self.pc.getTransceivers()[0].currentDirection != 'sendrecv':
            raise ValueError('missing bidirectional negotiated track')
        await asyncio.wait_for(self.opened.wait(), 25)

    def phone_pcm(self, frame):
        self.source.push(frame)

    async def close(self):
        self.closed = True
        self.source.stop()
        if self.drain is not None:
            self.drain.cancel()
            await asyncio.gather(self.drain, return_exceptions=True)
        await self.pc.close()


def read_frame(stream):
    header = stream.read(HEADER.size)
    if not header:
        return None
    if len(header) != HEADER.size:
        raise ValueError('short header')
    kind, size = HEADER.unpack(header)
    if not ((kind == JSON and 0 < size <= CONTROL_MAX) or (kind == PCM and size == PHONE_BYTES)):
        raise ValueError('invalid helper frame')
    data = stream.read(size)
    if len(data) != size:
        raise ValueError('short payload')
    return kind, data


def write_frame(stream, kind, payload):
    if kind == JSON and len(payload) > CONTROL_MAX:
        raise ValueError('oversize control')
    stream.write(HEADER.pack(kind, len(payload)))
    stream.write(payload)
    stream.flush()


async def main():
    out = asyncio.Queue(maxsize=16)
    failure = asyncio.Event()
    def emit(kind, data):
        # Never omit part of a word from a readback because the phone is slow.
        try:
            out.put_nowait((kind, data))
        except asyncio.QueueFull:
            failure.set()
    def control(obj):
        emit(JSON, json.dumps(obj, separators=(',', ':')).encode())
    async def writer():
        while True:
            kind, data = await out.get()
            await asyncio.to_thread(write_frame, sys.stdout.buffer, kind, data)
    peer = Peer(lambda pcm: emit(PCM, pcm), failure.set)
    async def reader():
        control({'type': 'offer', 'sdp': await peer.offer()})
        answered = False
        while True:
            frame = await asyncio.to_thread(read_frame, sys.stdin.buffer)
            if frame is None:
                return
            kind, data = frame
            if kind == PCM and answered:
                peer.phone_pcm(data)
            elif kind == JSON and not answered:
                message = json.loads(data)
                if set(message) != {'type', 'sdp'} or message['type'] != 'answer' or not isinstance(message['sdp'], str):
                    raise ValueError('expected answer')
                await peer.answer(message['sdp'])
                answered = True
                control({'type': 'ready'})
            else:
                raise ValueError('unexpected frame')
    tasks = [asyncio.create_task(f()) for f in (reader, writer, failure.wait)]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
        if failure.is_set():
            raise RuntimeError('media failed')
    finally:
        for task in tasks:
            task.cancel()
        await peer.close()
        await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == '__main__':
    import os
    # Windows pipes must not perform CRT newline translation.
    if sys.platform == 'win32':
        import msvcrt
        for fd in (sys.stdin.fileno(), sys.stdout.fileno()):
            msvcrt.setmode(fd, os.O_BINARY)
    try:
        # A cancelled executor read on a Windows pipe cannot be joined until the parent
        # closes stdin. Release WebRTC in main's finally, then end this dedicated child.
        asyncio.new_event_loop().run_until_complete(main())
    except Exception:
        # A generic status is sufficient; SDP, DTLS parameters and speech never enter logs.
        os._exit(1)
    os._exit(0)

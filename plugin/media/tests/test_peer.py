import asyncio
import io
import math
import struct

import pytest
from aiortc import RTCConfiguration, RTCPeerConnection, RTCRtpSender, RTCSessionDescription
from peer import MicrophoneTrack, Peer, PHONE_BYTES, read_frame, receive_pcm, trace_wire_category


def tone(hz, frame):
    return struct.pack('<480h', *(round(10000 * math.sin(2 * math.pi * hz * (i + frame * 480) / 24000)) for i in range(480)))


def energy(pcm, hz):
    values = struct.unpack('<480h', pcm)
    return abs(sum(v * complex(math.cos(2 * math.pi * hz * i / 24000), math.sin(2 * math.pi * hz * i / 24000)) for i, v in enumerate(values))) / 480


def test_two_real_opus_peers_carry_distinct_tones_in_both_directions():
    async def scenario():
        got_phone, got_server = asyncio.Event(), asyncio.Event()
        def hear(frame, expected, other, heard):
            assert len(frame) == PHONE_BYTES
            if energy(frame, expected) > 800 and energy(frame, expected) > 5 * energy(frame, other):
                heard.set()

        peer = Peer(lambda frame: hear(frame, 850, 400, got_phone), lambda: None)
        remote = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        speaker = MicrophoneTrack()
        transceiver = remote.addTransceiver(speaker, direction='sendrecv')
        transceiver.setCodecPreferences([c for c in RTCRtpSender.getCapabilities('audio').codecs if c.mimeType.lower() == 'audio/opus'])
        drains = []
        @remote.on('track')
        def track(t):
            drains.append(asyncio.create_task(receive_pcm(t, lambda f: hear(f, 400, 850, got_server))))

        try:
            offer = await peer.offer()
            assert 'opus/48000' in offer.lower() and 'm=application' in offer
            await remote.setRemoteDescription(RTCSessionDescription(offer, 'offer'))
            await remote.setLocalDescription(await remote.createAnswer())
            await peer.answer(remote.localDescription.sdp)
            async def feed():
                frame = 0
                while not (got_phone.is_set() and got_server.is_set()):
                    peer.phone_pcm(tone(400, frame)); speaker.push(tone(850, frame)); frame += 1
                    await asyncio.sleep(.02)
            await asyncio.wait_for(feed(), 10)
        finally:
            await peer.close(); await remote.close()
            for t in drains: t.cancel()
            await asyncio.gather(*drains, return_exceptions=True)
    asyncio.run(scenario())


def test_backlog_discards_old_microphone_and_never_bursts_to_catch_up():
    async def scenario():
        track = MicrophoneTrack()
        for i in range(200): track.push(bytes([i]) * 960)
        first, second = await track.recv(), await track.recv()
        assert bytes(first.planes[0])[0] >= 185
        assert second.pts - first.pts == 480
        track.stop()
    asyncio.run(scenario())


@pytest.mark.parametrize('wire', [
    struct.pack('>BI', 1, 65537), struct.pack('>BI', 2, 959),
    struct.pack('>BI', 3, 960), struct.pack('>BI', 2, 960) + b'only a prefix', b'\x01\x00',
])
def test_rejects_invalid_or_truncated_pipe_frame(wire):
    with pytest.raises(ValueError):
        read_frame(io.BytesIO(wire))


@pytest.mark.parametrize(('wire', 'category'), [
    ('{"type":"turn.done","turn":{"role":"user","transcript":"PRIVATE"}}', 'turn.user.valid'),
    ('{"type":"turn.done","turn":{"role":"assistant","text":"PRIVATE"}}', 'turn.assistant.missing_transcript'),
    ('{"type":"turn.done","turn":{"role":"SECRET"}}', 'turn.other_role'),
    ('{"type":"turn.done","transcript":"SECRET"}', 'turn.missing_turn'),
    ('{"type":"SECRET","credentials":"SECRET"}', 'other'),
    (b'PRIVATE', 'binary'), ('{' * 65537, 'oversize'),
    ('{"type":"conversation.item.input_audio_transcription.completed","transcript":"SECRET"}', 'conversation.item.input_audio_transcription.completed'),
], ids=['user-turn', 'missing-transcript', 'other-role', 'missing-turn',
        'unknown-event', 'binary', 'oversize', 'transcription-completed'])
def test_wire_trace_classifies_without_forwarding_payload(wire, category):
    assert trace_wire_category(wire) == category

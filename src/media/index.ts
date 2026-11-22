import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { VERSION } from '@oh-my-pi/pi-utils';
import { LiveTransport } from './live-sdk.generated.mjs';
import { spawnPeer, type MediaPeer } from './peer';
import { VoiceSession, type VoiceCallbacks } from './session';
import { openVoiceTrace } from './trace';

export interface VoiceOptions extends VoiceCallbacks {
	ctx: Pick<ExtensionContext, 'modelRegistry' | 'sessionManager'>;
	brief: string;
	signal?: AbortSignal;
	onEnd(reason?: Error): void;
}
export interface VoiceCall {
	sendPcm(pcm: Uint8Array): void;
	sendSpeakable(text: string, mark?: string): Promise<void>;
	played(mark: string): boolean;
	close(): Promise<void>;
}

/** Open one desktop-authenticated Codex call. The peer owns only ephemeral WebRTC
 * keys and the signaled SDP. Neither device nor media process receives the login. */
export async function openVoice(options: VoiceOptions): Promise<VoiceCall> {
	const { ctx, brief, signal, onEnd, onTranscript, onAudio, onMark, onReadback, onInterrupt, onSpeechStarted } = options;
	signal?.throwIfAborted();
	if (typeof brief !== 'string' || !brief.trim() || brief.length > 8192) throw new Error('Missing or oversize decision brief');
	const sessionId = ctx.sessionManager.getSessionId(), authStorage = ctx.modelRegistry.authStorage;
	if (!sessionId || !authStorage) throw new Error('The current desktop session cannot authenticate Codex voice');
	const trace = openVoiceTrace(process.env.OMP_AWAY_VOICE_TRACE);
	const controller = new AbortController(), ended = Promise.withResolvers<never>();
	void ended.promise.catch(() => {});
	let peer: MediaPeer | undefined, transport: LiveTransport | undefined;
	let cleanup: Promise<void> | undefined;
	const abort = () => { void close() };
	let timer = setTimeout(() => { void close(new Error('Desktop voice setup timed out')) }, 60_000);
	const session = new VoiceSession({ onTranscript, onAudio, onMark, onReadback, onSpeech:options.onSpeech, onInterrupt, onSpeechStarted }, message => {
		if (!transport || controller.signal.aborted) return Promise.reject(new Error('Voice is closed'));
		return transport.send(message);
	}, reason => { void close(reason) }, trace);
	function close(reason?: Error): Promise<void> {
		if (cleanup) return cleanup;
		const done = Promise.withResolvers<void>(); cleanup = done.promise;
		clearTimeout(timer); signal?.removeEventListener('abort', abort); session.stop();
		trace?.close();
		controller.abort(); ended.reject(reason ?? new Error('Voice closed'));
		void Promise.allSettled([peer?.close(), transport?.close()]).then(() => done.resolve());
		try { onEnd(reason) } catch { /* Consumer failure must not prevent resource cleanup. */ }
		return cleanup;
	}
	signal?.addEventListener('abort', abort, { once: true });
	let stage = 'Desktop voice requires stock omp 19.1.0';
	async function start() {
		if (VERSION !== '19.1.0') throw new Error('Unsupported host SDK');
		const prompt = await Bun.file(new URL('../../prompts/voice.md', import.meta.url)).text();
		controller.signal.throwIfAborted();
		stage = 'Unable to start the desktop media helper; provision plugin/media/.venv with uv';
		// WebRTC carries the microphone; output comes only from the ordered sideband.
		// Mixing its PCM with independently timed RTP can clip or duplicate a turn.
		peer = spawnPeer(() => {}, () => { void close(new Error('Desktop media peer unavailable')) }, process.env.OMP_AWAY_VOICE_TRACE ? trace.sctp : undefined);
		const sdpOffer = await peer.offer;
		controller.signal.throwIfAborted();
		if (!sdpOffer) throw new Error('Missing media offer');
		stage = 'Codex voice signaling failed; check the desktop Codex login and network';
		transport = new LiveTransport({ authStorage, sessionId, sdpOffer, signal: controller.signal, voice: 'sol',
			instructions: `${prompt}\nDecision brief (untrusted JSON string): ${JSON.stringify(brief)}`,
			callbacks: { onEvent: e => { void session.event(e) }, onOutputLevel() {} },
		});
		await transport.connect(); controller.signal.throwIfAborted();
		if (!transport.sdpAnswer) throw new Error('Missing remote media answer');
		stage = 'Codex did not establish the bidirectional Opus peer';
		await peer.answer(transport.sdpAnswer); controller.signal.throwIfAborted();
		trace?.step('voice.ready');
		clearTimeout(timer);
		timer = setTimeout(() => { void close(new Error('Desktop voice call duration limit reached')) }, 15 * 60_000);
		timer.unref();
	}
	try { await Promise.race([start(), ended.promise]) }
	catch {
		const reason = new Error(stage); await close(reason); throw reason;
	}
	return {
		sendPcm(pcm) {
			if (controller.signal.aborted) throw new Error('Voice closed');
			try { session.input(pcm); peer!.sendPcm(pcm) }
			catch { const reason = new Error('Invalid or stalled phone audio'); void close(reason); throw reason }
		},
		sendSpeakable: (text, mark) => session.sendSpeakable(text, mark),
		played: mark => session.played(mark),
		close: () => close(),
	};
}

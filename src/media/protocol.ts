import { parseLiveServerEvent as parseStock, type LiveServerEvent } from '@oh-my-pi/pi-coding-agent/live/protocol';
import { isRecord } from '@oh-my-pi/pi-utils';
export * from '@oh-my-pi/pi-coding-agent/live/protocol';

/** The live service's ordered audio stream is 24 kHz mono PCM16, not Opus RTP. */
export function parseLiveServerEvent(payload: unknown): LiveServerEvent | null {
	let value: unknown = payload;
	if (typeof value === 'string') {
		try { value = JSON.parse(value) } catch { return null }
	}
	if (!isRecord(value) || value.type !== 'session.output_audio.delta') return parseStock(value);
	const { delta, start_ms: start, end_ms: end } = value;
	if (typeof delta !== 'string' || typeof start !== 'number' || typeof end !== 'number' ||
		!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0) {
		return {type:'error',message:'Invalid ordered voice audio'};
	}
	const duration = end - start;
	// Each 20 ms frame is 960 bytes / 1280 base64 characters, without padding.
	if (duration <= 0 || duration > 1000 || duration % 20 !== 0 ||
		delta.length !== duration * 64 || !/^[A-Za-z0-9+/]+$/.test(delta)) {
		return {type:'error',message:'Invalid ordered voice audio'};
	}
	return {type:'output_audio.delta',audio:delta};
}

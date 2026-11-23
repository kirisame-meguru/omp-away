import { expect, test } from 'bun:test';
import { parseLiveServerEvent } from '../src/media/protocol';
const delta=Buffer.alloc(9600,8).toString('base64');
test('the service output event reaches the voice session as ordered 24 kHz PCM16',()=>{
	expect(parseLiveServerEvent(JSON.stringify({type:'session.output_audio.delta',delta,start_ms:400,end_ms:600})))
		.toEqual({type:'output_audio.delta',audio:delta});
});
test.each([
	['alphabet',{delta:'!'.repeat(delta.length),start_ms:0,end_ms:200}],
	['byte count',{delta:delta.slice(4),start_ms:0,end_ms:200}],
	['reversed interval',{delta,start_ms:200,end_ms:0}],
	['oversize interval',{delta,start_ms:0,end_ms:2000}],
	['partial frame',{delta,start_ms:0,end_ms:21}],
] as const)('invalid %s fails the call instead of silently dropping spoken samples',(_name,payload)=>{
	expect(parseLiveServerEvent({type:'session.output_audio.delta',...payload})).toMatchObject({type:'error'});
});

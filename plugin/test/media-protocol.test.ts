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
test('readback timing retains only bounded coordinates, not provider identifiers',()=>{
	expect(parseLiveServerEvent({type:'session.context.appended',start_ms:200,end_ms:400,id:'opaque'}))
		.toEqual({type:'unknown',wireType:'session.context.appended',startMs:200,endMs:400});
	expect(parseLiveServerEvent({type:'turn.done',turn:{role:'assistant',transcript:'Blue. Submit?',id:'opaque',start_ms:400,end_ms:800}}))
		.toEqual({type:'turn.done',turn:{role:'assistant',transcript:'Blue. Submit?'},startMs:400,endMs:800});
});
test.each([
	{start_ms:-1,end_ms:200},{start_ms:400,end_ms:200},{start_ms:NaN,end_ms:200},
	{start_ms:0,end_ms:Infinity},{start_ms:'0',end_ms:200},{end_ms:200},
])('invalid readback coordinates cannot become a confirmation fence',range=>{
	expect(parseLiveServerEvent({type:'session.context.appended',...range}))
		.toEqual({type:'unknown',wireType:'session.context.appended'});
	expect(parseLiveServerEvent({type:'turn.done',turn:{role:'assistant',transcript:'Blue. Submit?',...range}}))
		.toEqual({type:'turn.done',turn:{role:'assistant',transcript:'Blue. Submit?'}});
});

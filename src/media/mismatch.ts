import type { VoiceTrace } from './trace';

/** For operator diagnosis only. Deliberately discards punctuation (including semantically
 * important punctuation); none of these partial matches is returned to decision logic. */
export function traceMismatch(trace: VoiceTrace, expected: string, actual: string, phrase: string) {
	const words = (s: string) => s.normalize('NFC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
	const want = words(expected), got = words(actual), tail = words(phrase).slice(2);
	const sequence = ` ${got.join(' ')} `;
	trace.step(want.length === got.length ? 'compare.length.equal' : want.length > got.length ? 'compare.length.shorter' : 'compare.length.longer');
	trace.step(want.join(' ') === got.join(' ') ? 'compare.tokens.equal' : 'compare.tokens.different');
	const fields = want.slice(0, -(3 + tail.length)); // expected canonical script ends with 'Your words are ...'
	if (fields.length && sequence.includes(` ${fields.join(' ')} `)) trace.step('compare.fields.contiguous');
	else {
		let i = 0;
		for (const token of got) if (i < fields.length && token === fields[i]) ++i;
		trace.step(i === fields.length && i > 0 ? 'compare.fields.ordered_only' : 'compare.fields.missing');
	}
	const suffix = `${tail.join(' ')} `;
	trace.step(sequence.endsWith(` your words are ${suffix}`) ? 'compare.tail.with_intro' : sequence.endsWith(` ${suffix}`) ? 'compare.tail.words_only' : 'compare.tail.different');
}

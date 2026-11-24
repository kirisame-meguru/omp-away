import unittest
from pathlib import Path

from acoustic import load_scenarios, native_live_passed, response_for_step


def observation(ordinal, caller=1, category='answer', **overrides):
    result = {
        'id': ordinal, 'callerTurn': caller, 'category': category,
        'startedAt': ordinal * 100, 'finalAt': ordinal * 100 + 50,
        'firstAudioAt': ordinal * 100, 'lastAudioAt': ordinal * 100 + 40,
        'words': [], 'wordCount': 3, 'readback': 0,
        'interrupted': False, 'submitPrompts': 0,
    }
    result.update(overrides)
    return result


class ResponseSelectionTest(unittest.TestCase):
    def test_completed_opening_survives_a_later_assistant_continuation(self):
        opening = observation(1, 0, 'opening', words=['json', 'sqlite', 'local'])
        continuation = observation(2, 0)
        state = {'responses': [opening, continuation], 'duplicateSubmitPrompt': True}
        result = response_for_step(state, 'opening')
        assert result is not None
        self.assertEqual(result['category'], 'opening')
        self.assertEqual(result['words'], ['json', 'sqlite', 'local'])
        self.assertEqual(result['finalAt'], 250)
        self.assertEqual(state['responses'], [opening, continuation])
        self.assertTrue(state['duplicateSubmitPrompt'])

    def test_answer_fragments_keep_all_spoken_concepts_for_one_caller(self):
        state = {'responses': [
            observation(1, words=['transactions', 'recovery']),
            observation(2, words=['recovery', 'tests']),
        ]}
        result = response_for_step(state, 'answer')
        assert result is not None
        self.assertEqual(result['words'], ['transactions', 'recovery', 'tests'])
        self.assertEqual(result['wordCount'], 6)
        self.assertEqual(result['firstAudioAt'], 100)
        self.assertEqual(result['lastAudioAt'], 240)
        self.assertEqual(result['finalAt'], 250)

    def test_incomplete_tail_cannot_reuse_an_earlier_final(self):
        state = {'responses': [observation(1), observation(2, category='pending', finalAt=0)]}
        result = response_for_step(state, 'answer')
        assert result is not None
        self.assertEqual(result['finalAt'], 0)

    def test_new_caller_never_inherits_an_old_answer_or_readback(self):
        old = observation(1, 1, 'readback', readback=1, words=['sqlite', 'submit'])
        current = observation(2, 2, 'pending', finalAt=0)
        for step in ('answer', 'readback', 'during-readback'):
            with self.subTest(step=step):
                result = response_for_step({'responses': [old, current]}, step)
                assert result is not None
                self.assertEqual(result['callerTurn'], 2)
                self.assertEqual(result['words'], [])
                self.assertEqual(result['readback'], 0)
                self.assertEqual(result['finalAt'], 0)

    def test_new_playback_does_not_reuse_words_from_a_shared_pending_caller_onset(self):
        state = {'responses': [
            observation(1, words=['old']),
            observation(2, words=['current']),
            observation(3, words=['continuation']),
        ]}
        result = response_for_step(state, 'answer', since=150)
        assert result is not None
        self.assertEqual(result['id'], 2)
        self.assertEqual(result['words'], ['current', 'continuation'])
        self.assertIsNone(response_for_step(state, 'answer', since=400))

    def test_shared_onset_needs_a_real_caller_completion_after_this_playback(self):
        state = {'responses': [observation(2)], 'lastCallerFinalAt': 100}
        self.assertIsNone(response_for_step(state, 'answer', since=150, previous_caller=1))
        state['lastCallerFinalAt'] = 250
        result = response_for_step(state, 'answer', since=150, previous_caller=1)
        assert result is not None
        self.assertEqual(result['id'], 2)
        self.assertEqual(result['callerTurn'], 1)

    def test_fresh_recognized_onset_keeps_direct_answers_independent_of_completion(self):
        state = {'responses': [observation(2, caller=2)], 'lastCallerFinalAt': 0}
        result = response_for_step(state, 'answer', since=150, previous_caller=1)
        assert result is not None
        self.assertEqual(result['id'], 2)

    def test_new_desktop_readback_starts_a_new_group(self):
        state = {'responses': [
            observation(1, words=['transactions']),
            observation(2, category='readback', readback=1, words=['sqlite']),
            observation(3, words=['submit'], submitPrompts=1),
        ]}
        result = response_for_step(state, 'readback')
        assert result is not None
        self.assertEqual(result['category'], 'readback')
        self.assertEqual(result['readback'], 1)
        self.assertEqual(result['words'], ['sqlite', 'submit'])
        self.assertEqual(result['submitPrompts'], 1)
        self.assertEqual(result['startedAt'], 200)

    def test_interruption_and_duplicate_prompts_remain_visible(self):
        first = observation(1, category='readback', readback=1, interrupted=True, submitPrompts=1)
        second = observation(2, submitPrompts=1)
        state = {'responses': [first, second], 'duplicateSubmitPrompt': True}
        result = response_for_step(state, 'readback')
        assert result is not None
        self.assertTrue(result['interrupted'])
        self.assertEqual(result['submitPrompts'], 2)
        self.assertTrue(state['duplicateSubmitPrompt'])
        self.assertEqual(len(state['responses']), 2)

    def test_missing_opening_cannot_be_satisfied_by_an_unrequested_answer(self):
        self.assertIsNone(response_for_step({'responses': [observation(1)]}, 'opening'))
        self.assertIsNone(response_for_step({'responses': []}, 'opening'))


class NativeLiveAcceptanceTest(unittest.TestCase):
    def setUp(self):
        self.scenario = {'mode': 'native-live', 'steps': [{'say': 'Discuss the choices.'}], 'finalWords': [['tea'], ['coffee']]}
        self.played = [{'submittedBefore': 0, 'startedAt': 100, 'callerBefore': 0}]
        self.reply = observation(2, caller=1, words=['tea', 'coffee'])
        self.state = {
            'mode': 'native-live', 'offers': 1, 'takeoverAttempts': 1, 'takeovers': 1, 'nativeEnds': 1,
            'withdrawals': 0, 'submitted': 0, 'messages': 1, 'contextMatched': True, 'contextAckAt': 10,
            'firstAudioAt': 20, 'liveStarted': True, 'nativeEnded': True, 'liveStops': 1,
            'closed': True, 'ended': True, 'resumed': True, 'callerTurns': 1, 'assistantFinals': 2,
            'micFrames': 10, 'hotMicFrames': 3, 'outFrames': 10, 'marks': 1, 'drains': 1, 'errors': [],
        }

    def accepted(self, **overrides):
        return native_live_passed(self.scenario, self.played, {**self.state, **overrides}, self.reply, 'OK (1 test)', None)

    def test_native_discussion_has_no_canonical_submission(self):
        self.assertTrue(self.accepted())
        self.assertFalse(self.accepted(submitted=1, delivery='accepted', values={'drink': 'coffee'}))

    def test_every_lifecycle_context_and_media_invariant_is_required(self):
        for key, bad in (
            ('mode', 'scripted'), ('offers', 2), ('takeoverAttempts', 2), ('takeovers', 0),
            ('nativeEnds', 2), ('withdrawals', 1), ('messages', 0), ('contextMatched', False),
            ('contextAckAt', 0), ('contextAckAt', 30), ('firstAudioAt', 0),
            ('liveStarted', False), ('nativeEnded', False), ('liveStops', 0), ('liveStops', 2),
            ('closed', False), ('ended', False), ('resumed', False), ('callerTurns', 0),
            ('assistantFinals', 1), ('micFrames', 0), ('hotMicFrames', 0), ('outFrames', 0),
            ('marks', 0), ('drains', 0), ('errors', ['native-model-failed']),
        ):
            with self.subTest(key=key, bad=bad):
                self.assertFalse(self.accepted(**{key: bad}))

    def test_final_reply_must_be_fresh_audible_and_contain_requested_context(self):
        for change in ({'words': ['tea']}, {'callerTurn': 0}, {'finalAt': 0},
                       {'firstAudioAt': 0}, {'lastAudioAt': 0}, {'interrupted': True}):
            with self.subTest(change=change):
                self.assertFalse(native_live_passed(self.scenario, self.played, self.state,
                                                   {**self.reply, **change}, 'OK (1 test)', None))
        self.assertFalse(native_live_passed(self.scenario, self.played, self.state, None, 'OK (1 test)', None))
        self.assertFalse(native_live_passed(self.scenario, self.played, self.state, self.reply, '', None))
        self.assertFalse(native_live_passed(self.scenario, self.played, self.state, self.reply, 'OK (1 test)', 'timeout'))

    def test_default_scenarios_are_native_and_legacy_canonical_data_is_rejected(self):
        directory = Path(__file__).parent
        scenarios = load_scenarios(directory / 'acoustic.json')
        self.assertTrue(all(scenario['mode'] == 'native-live' and 'expected' not in scenario for scenario in scenarios))
        with self.assertRaises(ValueError):
            load_scenarios(directory / 'acoustic-scripted.json')


if __name__ == '__main__':
    unittest.main()

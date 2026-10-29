"""Offline contract tests for public benchmark parsing and safe composition."""
import datetime as dt
import json
import unittest
import urllib.error

import sources


def flight(models):
    payload = '1:' + json.dumps(["$", "main", None, {"initialModels": models}]) + '\n'
    return '<html><script>self.__next_f.push(' + json.dumps([1, payload]) + ')</script></html>'


def aa_model(index, **changes):
    value = {"name": "Example Model " + str(index) + " (Max, Default Fallback)",
             "slug": "example-model-" + str(index), "modelCreatorName": "OpenAI",
             "intelligenceIndex": 80 - index, "isOpenWeights": index % 2 == 0}
    value.update(changes)
    return value


def live_script(count=12, releases=None):
    entries = []
    for index in range(count):
        key = '"example-model-' + str(index) + '"'
        body = 'displayName:' + json.dumps('Example Model ' + str(index)) + ',organization:"OpenAI",effort:"max",openweight:' + ('!0' if index % 2 == 0 else '!1')
        entries.append(key + ':{' + body + '}')
    return 'const versions=' + json.dumps(releases or ['20261014', '20261025']) + ';const models={' + ','.join(entries) + '};'


def live_csv(count=12):
    return 'model,agentic,coding,research\n' + '\n'.join('example-model-' + str(index) + ',' + ','.join([str(90-index)] * 3) for index in range(count))


CATEGORIES = {'Agentic': ['agentic'], 'Coding': ['coding'], 'Research': ['research'], '_overall_weights': {'Agentic': 2, 'Coding': 1.5}}
LB_MAIN = 'https://livebench.ai/static/js/main.fixture.js'
LB_TABLE = 'https://livebench.ai/data/20261025/table.csv'
LB_CATEGORIES = 'https://livebench.ai/data/20261025/categories.json'


def arena_html(count=12, preliminary=False):
    # An Agent table on the same page must never become Text score evidence.
    agent = '<table><tr><th>Rank</th><th>Model</th><th>Net Improvement</th></tr><tr><td>1</td><td>Wrong agent</td><td>20.77%</td></tr></table>'
    rows = []
    for index in range(count):
        flag = ' data-preliminary="true"' if preliminary and index == count-1 else ''
        rows.append('<tr' + flag + '><td>' + str(index+1) + '</td><td><a>Example Model ' + str(index) + ' (High)</a><span>OpenAI · Proprietary</span></td><td>' + str(1500-index) + '<span>±7</span></td></tr>')
    return '<h1>Text Arena | Overall</h1><p>Updated 2026-10-22</p>' + agent + '<table><tr><th>Rank</th><th>Model</th><th>Score</th></tr>' + ''.join(rows) + '</table>'


def fixture_fetch(count=12, arena=None):
    documents = {
        sources.AA_URL: flight([aa_model(index) for index in range(count)]),
        sources.LB_URL: '<script src="./static/js/main.fixture.js"></script>',
        LB_MAIN: live_script(count), LB_TABLE: live_csv(count),
        LB_CATEGORIES: json.dumps(CATEGORIES),
        sources.ARENA_URL: arena_html(count) if arena is None else arena,
    }

    def get(url):
        value = documents[url]
        if isinstance(value, Exception):
            raise value
        return value

    return get, documents


class ArtificialAnalysisTests(unittest.TestCase):
    def test_extracts_exact_flight_scores_and_excludes_deprecated_or_unscored(self):
        raw = flight([aa_model(0, intelligenceIndex=58.4060336078904), aa_model(1, deprecated=True), aa_model(2, intelligenceIndex=None), aa_model(3, intelligenceIndex=0)])
        rows = sources.parse_artificial_analysis(raw)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['score'], 58.4060336078904)
        self.assertEqual(rows[1]['score'], 0)
        self.assertEqual(rows[0]['configuration'], 'Example Model 0 (Max, Default Fallback)')
        self.assertEqual(rows[0]['url'], 'https://artificialanalysis.ai/models/example-model-0')

    def test_rejects_changed_structure_nonfinite_and_unsafe_model_slugs(self):
        for raw in ['<h1>No initial data</h1>', flight([aa_model(0, intelligenceIndex=float('nan'))]), flight([aa_model(0, slug='../other')])]:
            with self.subTest(raw=raw[:40]), self.assertRaises(sources.SourceParseError):
                sources.parse_artificial_analysis(raw)


class LiveBenchTests(unittest.TestCase):
    def test_applies_official_suite_weights_and_keeps_zero_scores(self):
        csv = 'model,agentic,coding,research\nexample-model-0,10,20,30\nexample-model-1,0,0,0\n'
        rows = sources.parse_livebench(live_script(2), csv, CATEGORIES)
        self.assertEqual(rows[0]['score'], 17.78)
        self.assertEqual(rows[1]['score'], 0)
        self.assertTrue(rows[0]['openWeights'])
        self.assertFalse(rows[1]['openWeights'])
        self.assertEqual(rows[0]['configuration'], 'Example Model 0 (max)')

    def test_accepts_unquoted_metadata_identifiers(self):
        script = 'const m={inkling:{displayName:"Inkling",organization:"Thinking Machines",effort:"max",openweight:!0}};'
        rows = sources.parse_livebench(script, 'model,score\ninkling,12.5\n', {'Overall': ['score']})
        self.assertEqual(rows[0]['name'], 'Inkling')
        self.assertEqual(rows[0]['score'], 12.5)

    def test_discovers_latest_nonfuture_release_from_current_script(self):
        get, documents = fixture_fetch()
        documents[LB_MAIN] = live_script(releases=['20261014', '20261025', '20261101'])
        rows, date, url = sources.collect_livebench(get, dt.date(2026, 10, 28))
        self.assertEqual(date, '2026-10-25')
        self.assertEqual(url, LB_TABLE)
        self.assertEqual(len(rows), 12)
        self.assertEqual(rows[0]['url'], LB_TABLE)

    def test_rejects_unknown_scripts_changed_columns_or_missing_metadata(self):
        get, documents = fixture_fetch()
        documents[sources.LB_URL] = '<script src="https://example.com/main.fixture.js"></script>'
        with self.assertRaises(sources.SourceParseError):
            sources.collect_livebench(get, dt.date(2026, 10, 28))
        for script, csv, categories in [(live_script(1), 'model,other\nexample-model-0,10', CATEGORIES), ('', live_csv(1), CATEGORIES), (live_script(1), live_csv(1), {'Overall': ['coding'], '_overall_weights': {'Overall': 0}})]:
            with self.subTest(script=script[:25]), self.assertRaises(sources.SourceParseError):
                sources.parse_livebench(script, csv, categories)


class ArenaTests(unittest.TestCase):
    def test_accepts_an_explicit_new_provider_without_guessing_its_identity(self):
        raw = arena_html(2).replace('OpenAI · Proprietary', 'New Research Lab · Proprietary')
        rows, _ = sources.parse_arena(raw)
        self.assertEqual(rows[0]['provider'], 'New Research Lab')

    def test_reads_only_text_scores_and_skips_preliminary_models(self):
        rows, date = sources.parse_arena(arena_html(3, preliminary=True))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['name'], 'Example Model 0 (High)')
        self.assertEqual(rows[0]['provider'], 'OpenAI')
        self.assertEqual(rows[0]['score'], 1500)
        self.assertEqual(date, '2026-10-22')
        self.assertTrue(all(row['url'] == sources.ARENA_URL for row in rows))

    def test_rejects_agent_pages_or_changed_rating_columns(self):
        for raw in [arena_html(2).replace('Text Arena | Overall', 'Agent Arena | Overall'), arena_html(2).replace('<th>Score</th>', '<th>Net Improvement</th>'), arena_html(2).replace('1500', '20.77%')]:
            with self.subTest(raw=raw[:40]), self.assertRaises(sources.SourceParseError):
                sources.parse_arena(raw)


class IdentityTests(unittest.TestCase):
    def test_strips_reasoning_effort_but_keeps_versions_dates_and_release_qualifiers(self):
        self.assertEqual(sources.model_name('Claude Fable 5.1 (Xhigh, Default Fallback)'), 'Claude Fable 5.1')
        for name in ['Mistral Large 4 (Preview)', 'Qwen3.8 Max (0902)', 'DeepSeek V4.1 Flash (20260910)', 'Model Pro', 'Model Flash', 'Muse Wonder 1.0']:
            self.assertEqual(sources.model_name(name), name)
        self.assertNotEqual(sources._identity('Mistral Large 4 Preview', 'Mistral'), sources._identity('Mistral Large 4', 'Mistral AI'))
        self.assertNotEqual(sources._identity('Example Model 1.0', 'OpenAI'), sources._identity('Example Model 10', 'OpenAI'))
        self.assertEqual(sources._identity('MiMo-V2.6-Pro (High)', 'Xiaomi'), sources._identity('MiMo V2.6 Pro', 'Xiaomi'))


class CollectionTests(unittest.TestCase):
    def test_combines_three_fresh_sources_with_exact_scores_and_stable_shape(self):
        get, _ = fixture_fetch()
        snapshot = sources.collect_rankings(get, '2026-10-28')
        self.assertEqual(snapshot['retrievedAt'], '2026-10-28')
        self.assertEqual([row['id'] for row in snapshot['sources']], list(sources.SOURCE_IDS))
        self.assertEqual(len(snapshot['models']), 12)
        first = next(row for row in snapshot['models'] if row['id'] == 'example-model-0')
        self.assertEqual(first['provider'], 'OpenAI')
        self.assertEqual(first['icon'], 'openai')
        self.assertEqual(set(first['measurements']), set(sources.SOURCE_IDS))
        self.assertEqual(first['measurements']['artificial-analysis']['score'], 80)
        self.assertEqual(first['measurements']['livebench']['score'], 90)
        self.assertEqual(first['measurements']['arena']['score'], 1500)

    def test_partial_failure_uses_two_fresh_sources_and_never_fills_arena_with_old_values(self):
        error = urllib.error.HTTPError(sources.ARENA_URL, 403, 'Forbidden', None, None)
        get, _ = fixture_fetch(arena=error)
        failures = []
        snapshot = sources.collect_rankings(get, dt.date(2026, 10, 28), lambda source, reason: failures.append((source, reason)))
        self.assertEqual(failures, [('arena', error)])
        self.assertEqual(snapshot['sources'][2]['updatedAt'], None)
        self.assertTrue(all(row['measurements']['arena'] is None for row in snapshot['models']))
        self.assertTrue(all(len([value for value in row['measurements'].values() if value is not None]) == 2 for row in snapshot['models']))

    def test_selects_best_configuration_without_averaging_different_efforts(self):
        get, documents = fixture_fetch()
        documents[sources.AA_URL] = flight([aa_model(index) for index in range(12)] + [aa_model(0, name='Example Model 0 (High)', slug='example-model-0-high', intelligenceIndex=99)])
        snapshot = sources.collect_rankings(get, '2026-10-28')
        first = next(row for row in snapshot['models'] if row['id'] == 'example-model-0')
        self.assertEqual(first['measurements']['artificial-analysis']['configuration'], 'Example Model 0 (High)')
        self.assertEqual(first['measurements']['artificial-analysis']['score'], 99)

    def test_fails_closed_with_one_source_or_fewer_than_ten_paired_models(self):
        get, documents = fixture_fetch(arena=OSError('source unavailable'))
        documents[sources.AA_URL] = '<html>changed</html>'
        with self.assertRaises(sources.CollectionError) as caught:
            sources.collect_rankings(get, '2026-10-28')
        self.assertEqual(str(caught.exception), 'fewer_than_two_fresh_sources')
        self.assertEqual(set(caught.exception.source_errors), {'artificial-analysis', 'arena'})
        get, _ = fixture_fetch(9)
        with self.assertRaises(sources.CollectionError) as caught:
            sources.collect_rankings(get, '2026-10-28')
        self.assertEqual(str(caught.exception), 'fewer_than_ten_cross_source_models')

    def test_does_not_match_different_release_dates_previews_or_providers(self):
        get, documents = fixture_fetch(arena=OSError('unavailable'))
        models = [aa_model(index) for index in range(12)]
        models.extend([aa_model(20, name='Different Model (Preview)'), aa_model(21, name='Dated Model (0902)'), aa_model(22, name='Example Model 22', modelCreatorName='Anthropic')])
        documents[sources.AA_URL] = flight(models)
        documents[LB_MAIN] = live_script(23).replace('Example Model 20', 'Different Model').replace('Example Model 21', 'Dated Model (1017)')
        documents[LB_TABLE] = live_csv(23)
        snapshot = sources.collect_rankings(get, '2026-10-28')
        self.assertEqual(len(snapshot['models']), 12)


if __name__ == '__main__':
    unittest.main()

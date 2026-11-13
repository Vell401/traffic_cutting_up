"""Run: python3 -m unittest discover -s tests -p 'test_moscow_clearance.py'."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from moscow_clearance import clearance, clearance_status, radius, ribbon_constraints


def way(identifier, nodes, level, **tags):
    return {'id': identifier, 'nodes': nodes, 'tags': {'highway': 'primary', 'oneway': 'yes', 'lanes': '2', 'layer': str(level), **tags}}


class RibbonClearanceTests(unittest.TestCase):
    def test_parallel_edge_overlap_without_centerline_intersection(self):
        coords = {1: (0, 0), 2: (100, 0), 3: (0, 8), 4: (100, 8)}
        records, ambiguous, excluded = ribbon_constraints([way(10, [1, 2], 1), way(20, [3, 4], 0)], coords)
        self.assertEqual(len(records), 1)
        self.assertEqual((ambiguous, excluded), ([], 0))
        self.assertEqual(clearance(records[0], {1: 8, 2: 4, 3: 0, 4: 0}.__getitem__), 4)

    def test_grade_edge_worse_than_center(self):
        coords = {1: (-100, 0), 2: (100, 0), 3: (0, -100), 4: (0, 100)}
        records, _, _ = ribbon_constraints([way(10, [1, 2], 1), way(20, [3, 4], 0)], coords)
        gap = clearance(records[0], {1: 0, 2: 12, 3: 0, 4: 0}.__getitem__)
        self.assertLess(gap, 6)  # centerline alone reports exactly 6 m
        self.assertAlmostEqual(gap, 6 - radius(way(20, [3, 4], 0)) * .06)

    def test_two_way_offsets_and_directional_lanes(self):
        one = way(1, [1, 2], 0)
        two = way(1, [1, 2], 0, oneway='no', lanes='4', **{'lanes:backward': '3'})
        self.assertGreater(radius(two), radius(one) * 2)
        self.assertAlmostEqual(radius(two), (3 * 1.8 + 1.5) * 1.02 + 3 * 1.8 + .25)

    def test_same_layer_and_shared_node_not_claimed_clear(self):
        coords = {1: (0, 0), 2: (100, 0), 3: (0, 8), 4: (100, 8)}
        records, ambiguous, excluded = ribbon_constraints([way(10, [1, 2], 0), way(20, [3, 4], 0), way(30, [2, 4], 1)], coords)
        self.assertEqual(records, [])
        self.assertEqual(len(ambiguous), 1)
        self.assertEqual(excluded, 2)

    def test_disjoint_width_envelopes(self):
        coords = {1: (0, 0), 2: (100, 0), 3: (0, 100), 4: (100, 100)}
        self.assertEqual(ribbon_constraints([way(10, [1, 2], 1), way(20, [3, 4], 0)], coords), ([], [], 0))

    def test_finite_caps_do_not_create_crossings_beyond_endpoint(self):
        coords = {1: (0, 0), 2: (10, 0), 3: (14, -10), 4: (14, 10)}
        ways = [way(10, [1, 2], 1), way(20, [3, 4], 0)]
        # A narrower vertical road leaves a genuine longitudinal gap.
        ways[1]['tags']['lanes'] = '1'
        self.assertEqual(ribbon_constraints(ways, coords)[0], [])
        self.assertEqual(len(ribbon_constraints(ways, coords, expanded=True)[0]), 1)

    def test_local_merge_has_topological_evidence(self):
        coords = {1: (0, 0), 2: (20, 0), 3: (20, 5), 4: (100, 0), 5: (100, 5)}
        junctions = []
        ribbons, _, _ = ribbon_constraints([way(10, [1, 2, 4], 1), way(20, [1, 3, 5], 0)], coords, junctions=junctions)
        self.assertTrue(junctions)
        self.assertTrue(all(r['sharedNodes'] == [1] for r in junctions))
        # Connected ways that overlap far beyond their shared node are not
        # blanket-exempted just because they belong to the same junction.
        self.assertTrue(ribbons)

    def test_reversed_order_is_not_an_absolute_collision(self):
        record = {'upperNodes': [1, 2], 'lowerNodes': [3, 4], 'samples': [(0, 0), (1, 1)]}
        status = clearance_status(record, {1: -8, 2: -7, 3: 0, 4: 0}.__getitem__)
        self.assertEqual(status['classification'], 'reversed-layer-order')
        self.assertEqual(status['minimumAbsoluteSeparation'], 7)

    def test_sign_reversal_inside_overlap_is_collision(self):
        record = {'upperNodes': [1, 2], 'lowerNodes': [3, 4], 'samples': [(0, 0), (1, 1)]}
        status = clearance_status(record, {1: -8, 2: 8, 3: 0, 4: 0}.__getitem__)
        self.assertEqual(status['classification'], 'insufficient-absolute-separation')
        self.assertEqual(status['minimumAbsoluteSeparation'], 0)

    def test_generated_audit_matches_serialized_heights(self):
        data = json.loads((ROOT / 'data/moscow/network.json').read_text())
        self.assertEqual(data['crossingAudit']['unresolved'], [])
        self.assertGreaterEqual(data['crossingAudit']['minimumClearance'], 5.999)
        coords = {int(n): (p[0], p[2]) for n, p in data['nodes'].items()}
        heights = {int(n): p[1] for n, p in data['nodes'].items()}
        junctions = []
        records, ambiguous, excluded = ribbon_constraints(data['ways'], coords, junctions=junctions)
        gaps = [clearance(record, heights.__getitem__) for record in records]
        audit = data['ribbonAudit']
        self.assertEqual(len(records), audit['checkedDistinctLayerPairs'])
        self.assertEqual(len(ambiguous), len(audit['ambiguousSameLayerPairs']))
        self.assertEqual(excluded, audit['excludedConnectedOrSameWayPairs'])
        self.assertEqual(junctions, audit['localMergeCandidates'])
        self.assertTrue(audit['runtimeValidationRequired'])
        self.assertLessEqual(audit['maximumUpCorrectionFromLayerEnvelope'],
                             audit['centrelineCorrectionLimit'] + audit['extraCorrectionLimit'] + .0001)
        self.assertLessEqual(audit['maximumLowerCorrectionFromLayerEnvelope'], audit['extraCorrectionLimit'] + .0001)
        self.assertAlmostEqual(min(gaps), audit['minimumClearance'], places=3)
        unresolved = [(record, gap) for record, gap in zip(records, gaps) if gap < 6.399]
        self.assertEqual(len(unresolved), len(audit['unresolved']))
        self.assertLess(len(unresolved), audit['initialDeficientPairs'])
        classifications = {}
        for (record, gap), reported in zip(unresolved, audit['unresolved']):
            self.assertEqual(record['upperNodes'], reported['upperNodes'])
            self.assertEqual(record['lowerNodes'], reported['lowerNodes'])
            self.assertAlmostEqual(gap, reported['clearance'], places=3)
            self.assertEqual(clearance_status(record, heights.__getitem__),
                             {k: reported[k] for k in clearance_status(record, heights.__getitem__)})
            classification = reported['classification']
            classifications[classification] = classifications.get(classification, 0) + 1
        self.assertEqual(classifications, audit['unresolvedClassifications'])


if __name__ == '__main__':
    unittest.main()

"""Treats use real persisted progression, not renderer-only rewards."""

import unittest
from unittest.mock import patch

import test_companion


class TreatContracts(unittest.TestCase):
    tearDown = test_companion.CompanionContracts.tearDown
    hatch = test_companion.CompanionContracts.hatch
    adopt = test_companion.CompanionContracts.adopt
    def test_pets_are_limited_across_restarts_and_companions(self):
        ident = self.adopt()
        with patch('observatory.companion.engine.time.time', return_value=2000):
            for _ in range(10):
                self.engine.command('pet', {})
            snapshot = self.engine.snapshot()
            self.assertAlmostEqual(snapshot['active']['xp'], 7.3)
            self.assertEqual(snapshot['active']['active_seconds'], 0)
            self.assertEqual(snapshot['treats']['pets_left'], 0)
            before = self.engine.state.copy()
            with self.assertRaisesRegex(ValueError, 'hour'):
                self.engine.command('pet', {})
            self.assertEqual(self.engine.state, before)
            self.engine.close()
            self.engine = self.engine_class(self.path, self.engine_catalog, now=2000)
            with self.assertRaisesRegex(ValueError, 'hour'):
                self.engine.command('pet', {})
            self.engine._adopt(1)
            with self.assertRaisesRegex(ValueError, 'hour'):
                self.engine.command('pet', {})
            self.engine.command('switch', {'id': ident})
        with patch('observatory.companion.engine.time.time', return_value=5599):
            with self.assertRaisesRegex(ValueError, 'hour'):
                self.engine.command('pet', {})
        with patch('observatory.companion.engine.time.time', return_value=5600):
            self.engine.command('pet', {})
            self.assertEqual(self.engine.snapshot()['treats']['pets_left'], 9)

    def test_level_rewards_and_berry_consumption_persist(self):
        self.adopt()
        self.engine.credit(1120, 1193)  # 73 XP: level 2. Next level costs 113 XP.
        self.assertEqual(self.engine.snapshot()['treats']['berries'], 1)
        self.engine.command('berry', {})
        snapshot = self.engine.snapshot()
        self.assertAlmostEqual(snapshot['active']['xp'], 95.6)
        self.assertEqual(snapshot['active']['active_seconds'], 73)
        self.assertEqual(snapshot['treats']['berries'], 0)
        with self.assertRaisesRegex(ValueError, 'berry|berries'):
            self.engine.command('berry', {})
        self.engine.close()
        self.engine = self.engine_class(self.path, self.engine_catalog, now=2000)
        self.assertEqual(self.engine.snapshot()['treats']['berries'], 0)
        self.assertAlmostEqual(self.engine.snapshot()['active']['xp'], 95.6)

    def test_berry_crossing_level_awards_once_and_cannot_loop(self):
        self.adopt()
        self.engine.credit(1120, 1295)  # 175 XP, near level 3 (186 XP).
        self.engine.command('berry', {})
        self.assertEqual(self.engine.snapshot()['active']['level'], 3)
        self.assertEqual(self.engine.snapshot()['treats']['berries'], 1)
        self.engine.command('berry', {})
        self.assertEqual(self.engine.snapshot()['treats']['berries'], 0)
        with self.assertRaises(ValueError):
            self.engine.command('berry', {})

    def test_old_save_gets_no_retroactive_berries(self):
        self.adopt()
        self.engine.credit(1120, 1295)
        self.engine.state.pop('berries', None)
        self.engine.state.pop('pet_times', None)
        for individual in self.engine.state['collection']:
            individual.pop('berry_level', None)
        self.engine._save()
        self.engine.close()
        self.engine = self.engine_class(self.path, self.engine_catalog, now=2000)
        self.assertEqual(self.engine.snapshot()['treats']['berries'], 0)
        self.engine.credit(1295, 1315)
        self.assertEqual(self.engine.snapshot()['treats']['berries'], 1)

    def test_egg_and_level_100_reject_treats_without_spending(self):
        for action in ('pet', 'berry'):
            with self.assertRaisesRegex(ValueError, 'Hatch'):
                self.engine.command(action, {})
        self.adopt()
        self.engine.credit(1120, 37120)
        before = self.engine.snapshot()['treats']['berries']
        for action in ('pet', 'berry'):
            with self.assertRaisesRegex(ValueError, '100'):
                self.engine.command(action, {})
        self.assertEqual(self.engine.snapshot()['treats']['berries'], before)

    def setUp(self):
        test_companion.CompanionContracts.setUp(self)
        self.engine_catalog = test_companion.CATALOG

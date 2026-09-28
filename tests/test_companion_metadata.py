"""Protect the two metadata helpers extracted from the older dashboard."""

import unittest

from observatory.companion.metadata import counter_values, local_project


class MetadataTests(unittest.TestCase):
    def test_counter_order_and_missing_fields(self):
        self.assertEqual(counter_values({"input_tokens": 12, "output_tokens": 3, "total_tokens": 15}), [12, 0, 0, 3, 0, 15])

    def test_invalid_counters_are_rejected(self):
        for value in (True, -1, 1.5, "12", None):
            with self.subTest(value=value):
                self.assertIsNone(counter_values({"input_tokens": value}))

    def test_project_does_not_retain_parent_paths(self):
        for value in ("C:\\private\\project\\", "/private/project/", "project"):
            with self.subTest(value=value):
                self.assertEqual(local_project(value), "project")


if __name__ == "__main__":
    unittest.main()

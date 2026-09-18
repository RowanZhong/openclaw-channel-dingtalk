"""Local duration validation and final-send timeout guards; no DWS calls."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / "skills/dingtalk-form/scripts"
sys.path.insert(0, str(SCRIPTS))
from form_timeout import duration, validate_minutes  # noqa: E402
from dws_directory import ResolutionError  # noqa: E402
spec = importlib.util.spec_from_file_location("form_resolver", SCRIPTS / "resolve-targets.py")
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)


class TimeoutTests(unittest.TestCase):
    def test_one_minute_and_exactly_24_hours_are_allowed(self):
        for value, unit, expected in [(1, "minutes", 1), (1440, "minutes", 1440),
                                      ("24", "hours", 1440), (1.5, "hours", 90),
                                      (" 30 ", "minutes", 30), ("60.0", "minutes", 60)]:
            with self.subTest(value=value, unit=unit):
                result = duration({"value": value, "unit": unit})
                self.assertEqual(expected, result["timeoutMinutes"])
                self.assertEqual("design_only", result["purpose"])
                self.assertNotIn("toolArguments", result)

    def test_invalid_values_are_not_clamped_rounded_or_defaulted(self):
        cases = [(v, "minutes") for v in [0, -1, 1441, True, None, "", "abc", "1e3", "nan", float("inf"),
                                           1.5, "1439.9999999999999999999999999999999", [], {}]]
        cases += [(v, "hours") for v in [25, 24.1, "24.0000000000000000000000000000001", 0.001, 0.025]]
        for value, unit in cases:
            with self.subTest(value=value, unit=unit), self.assertRaises(ResolutionError) as caught:
                duration({"value": value, "unit": unit})
            self.assertEqual("invalid_timeout", caught.exception.result["code"])
            self.assertNotIn("timeoutMinutes", caught.exception.result)

    def test_bad_contract_cannot_produce_valid_duration(self):
        for request in [None, {}, {"value": 30}, {"value": 30, "unit": "days"},
                        {"value": 30, "unit": "minutes", "target": "someone"}]:
            with self.subTest(request=request), self.assertRaises(ResolutionError) as caught:
                duration(request)
            self.assertEqual("invalid_request", caught.exception.result["code"])

    def test_final_guard_requires_integer(self):
        for value in [None, True, "30", 30.0, 0, 1441]:
            with self.subTest(value=value), self.assertRaises(ResolutionError):
                validate_minutes(value)

    def test_final_resolver_rejects_timeout_before_any_directory_lookup(self):
        for kind in ["current", "user", "group"]:
            for value in [None, 1441, 25 * 60, -1, 1.5]:
                with self.subTest(kind=kind, value=value), self.assertRaises(ResolutionError) as caught:
                    resolver.resolve({"origin": {"type": "direct"}, "audience": {"type": kind},
                                      "timeoutMinutes": value},
                                     lambda corp: self.fail("Invalid duration queried directory"))
                self.assertEqual("invalid_timeout", caught.exception.result["code"])

    def test_correcting_duration_preserves_the_valid_value(self):
        with self.assertRaises(ResolutionError):
            duration({"value": 25, "unit": "hours"})
        self.assertEqual(120, duration({"value": 2, "unit": "hours"})["timeoutMinutes"])

    def test_cli_invalid_duration_exits_blocked_without_send_arguments(self):
        proc = subprocess.run([sys.executable, "-B", str(SCRIPTS / "form_timeout.py"), "--request", "-"],
                              input='{"value":1441,"unit":"minutes"}', text=True, capture_output=True)
        self.assertEqual(2, proc.returncode)
        result = json.loads(proc.stdout)
        self.assertEqual("blocked", result["status"])
        self.assertNotIn("timeoutMinutes", result)
        self.assertNotIn("toolArguments", result)

    def test_cli_exactly_24_hours_succeeds(self):
        proc = subprocess.run([sys.executable, "-B", str(SCRIPTS / "form_timeout.py"), "--request", "-"],
                              input='{"value":"24","unit":"hours"}', text=True, capture_output=True)
        self.assertEqual(0, proc.returncode)
        self.assertEqual(1440, json.loads(proc.stdout)["timeoutMinutes"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

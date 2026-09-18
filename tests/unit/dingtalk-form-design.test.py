"""Behavioral checks for the read-only design picker; no real directory calls."""

import importlib.util
from pathlib import Path
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / "skills/dingtalk-form/scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("design_members", SCRIPTS / "design-members.py")
design = importlib.util.module_from_spec(spec)
spec.loader.exec_module(design)
from dws_directory import ResolutionError, fail  # noqa: E402


class FakeDirectory:
    corp_id = "test-corp"
    profile = "test-corp:operator"

    def __init__(self):
        self.rows = [{"name": "甲", "staffId": "staff-a", "openDingtalkId": "open-a"},
                     {"name": "乙", "staffId": "staff-b", "openDingtalkId": "open-b"}]
        self.calls = []
        self.incomplete = False

    def group(self, group, origin):
        self.calls.append(("group", group, origin))
        return {"id": "cidCase+==", "name": "测试群"}

    def members(self, group_id):
        self.calls.append(("members", group_id))
        if self.incomplete:
            fail("incomplete_result", "not complete")
        return self.rows

    def member_person(self, member):
        self.calls.append(("person", member["name"]))
        if not member.get("staffId"):
            fail("identity_unresolved", "unknown identity")
        return member


class DesignTests(unittest.TestCase):
    def setUp(self):
        self.directory = FakeDirectory()
        self.request = {"origin": {"type": "direct"}, "group": {"groupName": "测试群"}}

    def run_picker(self, binding=None):
        return design.picker(self.request, lambda corp: self.directory, binding)

    def blocked(self, code):
        with self.assertRaises(ResolutionError) as caught:
            self.run_picker()
        self.assertEqual(code, caught.exception.result["code"])
        self.assertNotIn("field", caught.exception.result)
        self.assertNotIn("toolArguments", caught.exception.result)
        return caught.exception.result

    def test_candidates_are_not_a_send_request(self):
        result = self.run_picker()
        self.assertEqual("design_only", result["purpose"])
        self.assertEqual("choose", result["mode"])
        self.assertNotIn("target", result)
        self.assertNotIn("toolArguments", result)

    def test_picker_uses_real_staff_ids_and_human_names(self):
        field = self.run_picker()["field"]
        self.assertEqual([{"value": "staff-a", "text": "甲"}, {"value": "staff-b", "text": "乙"}], field["options"])
        self.assertEqual("MULTI_SELECT", field["type"])
        self.assertTrue(field["required"])
        self.assertNotIn("defaultValue", field)

    def test_large_group_is_not_truncated_or_fully_resolved(self):
        self.directory.rows *= 7
        result = self.run_picker()
        self.assertEqual("narrow", result["mode"])
        self.assertEqual(14, result["memberCount"])
        self.assertNotIn("field", result)
        self.assertNotIn("members", result)
        self.assertFalse(any(call[0] == "person" for call in self.directory.calls))

    def test_twelve_members_fit_the_picker(self):
        self.directory.rows = [{"name": f"成员{i}", "staffId": f"staff-{i}"} for i in range(12)]
        self.assertEqual(12, len(self.run_picker()["field"]["options"]))

    def test_empty_group_has_no_picker(self):
        self.directory.rows = []
        self.blocked("no_members")

    def test_same_name_members_cannot_be_confused_in_callback(self):
        self.directory.rows[1]["name"] = "甲"
        result = self.blocked("ambiguous_names")
        self.assertEqual(2, len(result["candidates"]))

    def test_unknown_member_is_not_silently_omitted(self):
        self.directory.rows[1]["staffId"] = None
        result = self.blocked("members_unresolved")
        self.assertEqual("乙", result["issues"][0]["member"])

    def test_staff_id_conflicts_stop_selection(self):
        self.directory.rows[1]["staffId"] = "STAFF-A"
        self.blocked("identity_conflict")

    def test_incomplete_directory_has_no_picker(self):
        self.directory.incomplete = True
        self.blocked("incomplete_result")

    def test_organization_mismatch_precedes_directory_query(self):
        self.request["corpId"] = "other-corp"
        with self.assertRaises(ResolutionError) as caught:
            self.run_picker({"corpId": "test-corp"})
        self.assertEqual("organization_mismatch", caught.exception.result["code"])
        self.assertEqual([], self.directory.calls)

    def test_invalid_context_and_conflicting_groups_are_rejected(self):
        for group in [{}, {"currentGroup": False}, {"groupName": "群", "conversationId": "id"}]:
            self.request["group"] = group
            self.blocked("invalid_group")
        self.request["origin"]["type"] = "web"
        self.blocked("dingtalk_context_required")

    def test_current_group_context_is_forwarded_without_changing_destination(self):
        self.request = {"origin": {"type": "group", "conversationId": "cidCase+=="},
                        "group": {"currentGroup": True}}
        result = self.run_picker()
        self.assertEqual("cidCase+==", result["group"]["id"])
        self.assertEqual(("group", self.request["group"], self.request["origin"]), self.directory.calls[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""Group picker behavior against anonymous, complete and partial DWS ledgers."""

import copy
import importlib.util
from pathlib import Path
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / "skills/dingtalk-form/scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("design_groups", SCRIPTS / "design-groups.py")
design = importlib.util.module_from_spec(spec)
spec.loader.exec_module(design)
from dws_directory import Directory, ResolutionError  # noqa: E402


class GroupTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.profiles = [{"corpId": "corp-a", "isOrgCurrent": True, "profile": "corp-a:user"}]
        self.data = {"complete": True, "hasMore": False, "paginationKnown": True,
                     "partial": False, "failedCount": 0, "failures": [], "groups": [
                         {"conversationId": "cidA+==", "name": "项目群", "memberCount": 4},
                         {"conversationId": "cidB+==", "name": "活动群", "memberCount": 8}]}
        self.request = {"origin": {"type": "direct"}}

    def runner(self, args):
        self.calls.append(args)
        if args == ["profile", "list"]:
            return {"profiles": self.profiles}
        self.assertEqual(["chat", "+my-groups", "--page-all", "--page-limit", "50",
                          "--profile", "corp-a:user"], args)
        return copy.deepcopy(self.data)

    def picker(self):
        return design.picker(self.request, lambda corp: Directory(corp, self.runner), {"corpId": "corp-a"})

    def blocked(self, code):
        with self.assertRaises(ResolutionError) as caught:
            self.picker()
        self.assertEqual(code, caught.exception.result["code"])
        self.assertNotIn("field", caught.exception.result)
        self.assertNotIn("toolArguments", caught.exception.result)

    def test_full_list_is_single_select_without_implicit_choice_or_send(self):
        result = self.picker()
        self.assertEqual("design_only", result["purpose"])
        self.assertEqual("dws_account_joined_groups", result["scope"])
        self.assertEqual(2, result["groupCount"])
        self.assertNotIn("target", result)
        self.assertNotIn("toolArguments", result)
        self.assertEqual({"name": "design_group", "label": "选择目标群", "type": "SELECT",
                          "required": True, "options": [
                              {"value": "cidA+==", "text": "项目群"},
                              {"value": "cidB+==", "text": "活动群"}]}, result["field"])

    def test_large_list_keeps_every_group(self):
        self.data["groups"] = [{"conversationId": f"cid{i}==", "name": f"群{i}"} for i in range(250)]
        result = self.picker()
        self.assertEqual(250, result["groupCount"])
        self.assertEqual(250, len(result["field"]["options"]))

    def test_single_group_still_requires_selection(self):
        self.data["groups"] = self.data["groups"][:1]
        result = self.picker()
        self.assertEqual(1, len(result["field"]["options"]))
        self.assertNotIn("defaultValue", result["field"])

    def test_duplicate_pages_deduplicate_by_exact_id(self):
        self.data["groups"] *= 2
        self.assertEqual(2, self.picker()["groupCount"])

    def test_case_sensitive_ids_are_not_merged(self):
        self.data["groups"][1]["conversationId"] = "cida+=="
        self.assertEqual(2, self.picker()["groupCount"])

    def test_conflicting_same_id_blocks_entire_picker(self):
        self.data["groups"][1]["conversationId"] = "cidA+=="
        self.blocked("group_conflict")

    def test_same_name_is_disambiguated_by_actual_member_count(self):
        self.data["groups"][1]["name"] = "项目群"
        self.assertEqual(["项目群（4 人）", "项目群（8 人）"],
                         [x["text"] for x in self.picker()["field"]["options"]])

    def test_indistinguishable_groups_are_not_guessed_or_omitted(self):
        self.data["groups"][1].update(name="项目群", memberCount=4)
        self.blocked("ambiguous_groups")

    def test_empty_list_has_clear_failure(self):
        self.data["groups"] = []
        self.blocked("no_groups")

    def test_missing_names_or_ids_do_not_silently_drop_groups(self):
        self.data["groups"][1]["name"] = " "
        self.blocked("group_name_required")
        self.data["groups"][1]["name"] = "群"
        self.data["groups"][1]["conversationId"] = None
        self.blocked("invalid_id")

    def test_partial_or_truncated_results_are_never_presented_as_all(self):
        baseline = copy.deepcopy(self.data)
        for key, value in [("complete", False), ("hasMore", True), ("paginationKnown", False),
                           ("partial", True), ("truncated", True), ("truncatedByPageLimit", True),
                           ("truncatedByResultLimit", True), ("failedCount", 1), ("failures", ["denied"])]:
            with self.subTest(key=key):
                self.data = {**baseline, key: value}
                self.blocked("incomplete_result")

    def test_malformed_response_has_no_picker(self):
        for rows in [None, {}, [None]]:
            with self.subTest(rows=rows):
                self.data["groups"] = rows
                self.blocked("invalid_response")

    def test_mismatched_organization_does_not_query(self):
        self.request["corpId"] = "corp-b"
        self.blocked("organization_mismatch")
        self.assertEqual([], self.calls)

    def test_no_default_account_does_not_query_groups(self):
        self.profiles[0]["isOrgCurrent"] = False
        self.blocked("profile_required")
        self.assertEqual([["profile", "list"]], self.calls)

    def test_invalid_origin_or_extra_fields_do_not_query(self):
        self.request["origin"]["type"] = "web"
        self.blocked("dingtalk_context_required")
        self.request["send"] = True
        self.blocked("invalid_request")
        self.assertEqual([], self.calls)


if __name__ == "__main__":
    unittest.main(verbosity=2)

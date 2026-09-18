"""Offline behavioral tests; no real DWS processes, identities, or network calls."""

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / "skills/dingtalk-form/scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("form_resolver", SCRIPTS / "resolve-targets.py")
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)
from dws_directory import Directory, ResolutionError, run_dws  # noqa: E402


def person(name="甲", staff="staff-a", oid="open-a"):
    return {"sourceType": "person", "title": name, "userId": staff,
            "meta": {"name": name, "staffId": staff}, "openDingTalkId": oid}


def ledger(**kwargs):
    return {"complete": True, "hasMore": False, "partial": False,
            "failedCount": 0, "failures": [], **kwargs}


class FakeDws:
    def __init__(self):
        self.calls = []
        self.profiles = [{"corpId": "corp-a", "corpName": "测试组织",
                          "profile": "corp-a:operator", "isOrgCurrent": True}]
        self.people = {"甲": [person()], "乙": [person("乙", "staff-b", "open-b")]}
        self.chats = ledger(chats=[{"name": "项目群", "openConversationId": "cidCase+=="}])
        self.members = ledger(conversationId="cidCase+==", buckets={"users": ledger()}, users=[
            {"name": "甲", "openDingtalkId": "open-a"},
            {"name": "乙", "openDingtalkId": "open-b"}])
        self.contact = {"staff-a": {"orgUserId": "staff-a", "orgUserName": "甲"},
                        "staff-b": {"orgUserId": "staff-b", "orgUserName": "乙"}}

    def __call__(self, args):
        self.calls.append(args)
        if args == ["profile", "list"]:
            return {"success": True, "profiles": copy.deepcopy(self.profiles)}
        assert args[-2:] == ["--profile", "corp-a:operator"], args
        if args[:2] == ["aisearch", "person"]:
            return {"success": True, "result": copy.deepcopy(self.people.get(args[3], []))}
        if args[:3] == ["contact", "user", "get"]:
            result = self.contact.get(args[4])
            return {"success": True, "result": [{"orgEmployeeModel": result}] if result else []}
        if args[:2] == ["chat", "+chat-search"]:
            return copy.deepcopy(self.chats)
        if args[:2] == ["chat", "+chat-members-list"]:
            return copy.deepcopy(self.members)
        raise AssertionError(f"Unexpected command: {args}")


class ResolverTests(unittest.TestCase):
    def setUp(self):
        self.dws = FakeDws()

    def resolve(self, audience=None, origin="direct", **extra):
        request = {"origin": {"type": origin, "senderStaffId": "staff-b", "conversationId": "cidCase+=="},
                   "audience": audience or {"type": "group", "groupName": "项目群",
                                             "respondents": [{"name": "甲"}, {"name": "乙"}]}, **extra}
        return resolver.resolve(request, lambda corp: Directory(corp, self.dws), {"corpId": "corp-a"})

    def blocked(self, code, **kwargs):
        with self.assertRaises(ResolutionError) as caught:
            self.resolve(**kwargs)
        self.assertEqual(code, caught.exception.result["code"])
        self.assertNotIn("toolArguments", caught.exception.result)
        return caught.exception.result

    def test_six_scenarios_preserve_delivery_and_return_location(self):
        for origin in ["direct", "group"]:
            for kind in ["current", "user", "group"]:
                with self.subTest(origin=origin, audience=kind):
                    audience = {"type": kind}
                    if kind == "user":
                        audience["name"] = "甲"
                    if kind == "group":
                        audience.update(groupName="项目群", respondents=[{"name": "甲"}])
                    result = self.resolve(audience, origin)
                    self.assertEqual("ready", result["status"])
                    self.assertEqual(origin, result["originType"])
                    self.assertEqual("initiating_conversation", result["returnTo"])
                    self.assertEqual(origin if kind == "current" else "direct" if kind == "user" else "group",
                                     result["delivery"])
                    target = result["toolArguments"].get("target")
                    if kind == "current":
                        self.assertIsNone(target)
                    else:
                        self.assertEqual(kind, target["type"])

    def test_current_user_default_never_queries_login_identity(self):
        self.resolve({"type": "current"})
        self.assertEqual([], self.dws.calls)

    def test_current_group_with_timeout_does_not_move_to_dm(self):
        result = self.resolve({"type": "current"}, "group", timeoutMinutes=30)
        self.assertEqual({"type": "group", "id": "cidCase+==", "respondentUserIds": ["staff-b"]},
                         result["toolArguments"]["target"])
        self.assertEqual([], self.dws.calls)

    def test_current_dm_independent_uses_sender_not_dws_operator(self):
        result = self.resolve({"type": "current"}, independent=True)
        self.assertEqual({"target": {"type": "user", "id": "staff-b"}, "timeoutMinutes": 5}, result["toolArguments"])

    def test_id_type_and_group_id_case_are_preserved(self):
        result = self.resolve()
        self.assertEqual({"type": "group", "id": "cidCase+==", "respondentUserIds": ["staff-a", "staff-b"]},
                         result["toolArguments"]["target"])

    def test_user_target_omits_respondent_list(self):
        result = self.resolve({"type": "user", "name": "甲"}, timeoutMinutes=1440)
        self.assertEqual({"type": "user", "id": "staff-a"}, result["toolArguments"]["target"])
        self.assertEqual(1440, result["toolArguments"]["timeoutMinutes"])

    def test_lookup_userid_is_not_used_as_staffid_without_mapping(self):
        self.dws.people["甲"][0]["meta"].pop("staffId")
        self.dws.people["甲"][0]["userId"] = "directory-lookup-id"
        self.dws.contact["directory-lookup-id"] = {"orgUserId": "actual-staff", "orgUserName": "甲"}
        result = self.resolve({"type": "user", "name": "甲"})
        self.assertEqual("actual-staff", result["toolArguments"]["target"]["id"])

    def test_open_id_only_blocks_instead_of_sending(self):
        self.dws.people["甲"][0]["meta"].pop("staffId")
        self.dws.people["甲"][0].pop("userId")
        self.blocked("identity_unresolved", audience={"type": "user", "name": "甲"})

    def test_claimed_staffid_must_match_directory_field(self):
        self.dws.contact["open-a"] = self.dws.contact["staff-a"]
        self.blocked("id_type_mismatch", audience={"type": "user", "staffId": "open-a"})

    def test_conflicting_identities_are_not_silently_deduplicated(self):
        self.dws.people["甲"].append(person("甲", "staff-a", "other-person"))
        self.blocked("identity_conflict", audience={"type": "user", "name": "甲"})

    def test_two_members_cannot_collapse_to_the_same_staffid(self):
        self.dws.people["乙"][0]["meta"]["staffId"] = "staff-a"
        self.blocked("identity_conflict")

    def test_self_target_without_sender_cannot_fall_back_to_operator(self):
        with self.assertRaises(ResolutionError):
            resolver.resolve({"origin": {"type": "direct"}, "audience": {"type": "current"}, "timeoutMinutes": 1})
        self.assertEqual([], self.dws.calls)

    def test_same_name_is_not_first_candidate_selection(self):
        self.dws.people["甲"].append(person("甲", "staff-other", "open-other"))
        result = self.blocked("choose_candidate", audience={"type": "user", "name": "甲"})
        self.assertEqual(2, len(result["candidates"]))

    def test_same_named_groups_require_selection(self):
        self.dws.chats["chats"].append({"name": "项目群", "openConversationId": "cidOther=="})
        self.blocked("choose_candidate")

    def test_unique_exact_group_can_exclude_keyword_matches(self):
        self.dws.chats["chats"].insert(0, {"name": "工作通知:项目群", "openConversationId": "cidOther=="})
        self.assertEqual("cidCase+==", self.resolve()["toolArguments"]["target"]["id"])

    def test_fuzzy_name_requires_user_selection(self):
        self.dws.people["甲"] = [person("甲甲")]
        self.blocked("choose_candidate", audience={"type": "user", "name": "甲"})

    def test_partial_name_resolution_never_returns_partial_target(self):
        del self.dws.people["乙"]
        result = self.blocked("members_unresolved")
        self.assertEqual("乙", result["issues"][0]["member"])

    def test_same_name_different_openid_is_not_group_membership(self):
        self.dws.people["甲"][0]["openDingTalkId"] = "other-person"
        result = self.blocked("members_unresolved")
        self.assertEqual("not_a_group_member", result["issues"][0]["code"])

    def test_all_members_matches_openid_even_when_names_repeat(self):
        self.dws.members["users"][1]["name"] = "甲"
        self.dws.people["甲"].append(person("甲", "staff-b", "open-b"))
        result = self.resolve({"type": "group", "groupName": "项目群", "allMembers": True})
        self.assertEqual(["staff-a", "staff-b"], result["toolArguments"]["target"]["respondentUserIds"])

    def test_unknown_external_member_prevents_all_members_send(self):
        self.dws.members["users"].append({"name": "外部人员", "openDingtalkId": "open-external"})
        result = self.blocked("members_unresolved", audience={"type": "group", "groupName": "项目群", "allMembers": True})
        self.assertEqual("外部人员", result["issues"][0]["member"])

    def test_incomplete_top_level_and_bucket_are_rejected(self):
        for level in ["top", "bucket"]:
            with self.subTest(level=level):
                self.setUp()
                data = self.dws.members if level == "top" else self.dws.members["buckets"]["users"]
                data["hasMore"] = True
                self.blocked("incomplete_result")

    def test_truncated_group_search_is_not_treated_as_unique(self):
        self.dws.chats["truncatedByPageLimit"] = True
        self.blocked("incomplete_result")

    def test_over_1000_members_are_not_truncated(self):
        self.dws.members["users"] = [{"name": str(i), "openDingtalkId": f"open-{i}"} for i in range(1001)]
        self.blocked("respondent_limit", audience={"type": "group", "groupName": "项目群", "allMembers": True})

    def test_all_1000_members_are_resolved_without_truncation(self):
        self.dws.members["users"] = [{"name": f"成员{i}", "openDingtalkId": f"open-{i}"} for i in range(1000)]
        self.dws.people = {f"成员{i}": [person(f"成员{i}", f"staff-{i}", f"open-{i}")] for i in range(1000)}
        audience = {"type": "group", "groupName": "项目群", "allMembers": True}
        result = self.resolve(audience, timeoutMinutes=4320)
        self.assertEqual([f"staff-{i}" for i in range(1000)], result["toolArguments"]["target"]["respondentUserIds"])
        self.assertEqual(4320, result["toolArguments"]["timeoutMinutes"])
        self.dws.people["成员999"] = []
        blocked = self.blocked("members_unresolved", audience=audience)
        self.assertEqual("成员999", blocked["issues"][0]["member"])

    def test_repeated_resolved_staffid_is_deduplicated(self):
        result = self.resolve({"type": "group", "groupName": "项目群", "respondents": [{"name": "甲"}, {"name": "甲"}]})
        self.assertEqual(["staff-a"], result["toolArguments"]["target"]["respondentUserIds"])

    def test_current_group_requires_group_context(self):
        self.blocked("not_in_group", audience={"type": "group", "currentGroup": True, "respondents": [{"name": "甲"}]})

    def test_self_in_named_group_is_sender_not_login_account(self):
        result = self.resolve({"type": "group", "groupName": "项目群", "respondents": [{"self": True}]})
        self.assertEqual(["staff-b"], result["toolArguments"]["target"]["respondentUserIds"])

    def test_missing_binding_and_organization_mismatch_stop_before_query(self):
        self.blocked("organization_mismatch", corpId="corp-b")
        with self.assertRaises(ResolutionError) as caught:
            resolver.resolve({"origin": {"type": "direct"}, "audience": {"type": "user", "name": "甲"}},
                             lambda corp: Directory(corp, self.dws))
        self.assertEqual("organization_required", caught.exception.result["code"])
        self.assertEqual([], self.dws.calls)

    def test_no_unique_default_profile_does_not_pick_first(self):
        self.dws.profiles *= 2
        self.blocked("profile_required")

    def test_invalid_timeout_and_conflicting_audience_are_blocked(self):
        for value in [0, 4321, True, 1.5, "5"]:
            with self.subTest(value=value):
                self.blocked("invalid_timeout", timeoutMinutes=value)
        self.blocked("invalid_audience", audience={"type": "group", "groupName": "项目群", "allMembers": True, "respondents": []})
        self.blocked("invalid_request", audience={"type": "user", "name": "甲", "respondentUserIds": ["staff-a"]})

    def test_failure_payload_is_not_exposed_to_model(self):
        with patch("dws_directory.subprocess.run", return_value=subprocess.CompletedProcess([], 1, '{"error":{"category":"auth","message":"token=SECRET"}}', 'SECRET')):
            with self.assertRaises(ResolutionError) as caught:
                run_dws(["profile", "list"])
        self.assertNotIn("SECRET", json.dumps(caught.exception.result))

    def test_subprocess_does_not_interpret_names_as_shell(self):
        name = "甲'; $(touch /tmp/should-not-exist)"
        with patch("dws_directory.subprocess.run", return_value=subprocess.CompletedProcess([], 0, '{"success":true,"result":[]}', '')) as proc:
            run_dws(["aisearch", "person", "--keyword", name])
            args, kwargs = proc.call_args
            self.assertEqual(name, args[0][4])
            self.assertFalse(kwargs.get("shell", False))

    def test_query_timeout_is_a_clear_failure(self):
        with patch("dws_directory.subprocess.run", side_effect=subprocess.TimeoutExpired("dws", 65)):
            with self.assertRaises(ResolutionError) as caught:
                run_dws(["profile", "list"])
        self.assertEqual("query_timeout", caught.exception.result["code"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

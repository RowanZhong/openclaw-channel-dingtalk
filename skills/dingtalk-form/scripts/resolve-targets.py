#!/usr/bin/env python3
"""Resolve six DingTalk form scenarios without sending messages or creating cards."""

import argparse
import json
from pathlib import Path
import sys

from dws_directory import Directory, ResolutionError, fail, raw_id
from form_timeout import validate_minutes
from form_limits import MAX_RESPONDENTS


def keys(value, allowed):
    if not isinstance(value, dict) or set(value) - set(allowed):
        fail("invalid_request", "请求包含未知字段或不是对象。")


def resolve(request, directory_factory=Directory, binding=None):
    keys(request, {"origin", "audience", "timeoutMinutes", "independent", "corpId"})
    origin = request.get("origin")
    keys(origin, {"type", "senderStaffId", "conversationId"})
    if origin.get("type") not in {"direct", "group"}:
        fail("dingtalk_context_required", "需要当前钉钉私聊或群聊的可信上下文。")
    audience = request.get("audience")
    keys(audience, {"type", "name", "staffId", "groupName", "conversationId",
                    "currentGroup", "respondents", "allMembers"})
    kind = audience.get("type")
    if kind not in {"current", "user", "group"}:
        fail("invalid_audience", "填写对象必须为 current、user 或 group。")
    timeout = request.get("timeoutMinutes")
    if "timeoutMinutes" in request:
        validate_minutes(timeout)
    independent = request.get("independent", False)
    if type(independent) is not bool:
        fail("invalid_request", "independent 必须为布尔值。")
    result = {"status": "ready", "originType": origin["type"],
              "returnTo": "initiating_conversation", "toolArguments": {}}
    if kind == "current":
        keys(audience, {"type"})
        if timeout is None and not independent:
            return {**result, "mode": "current", "delivery": origin["type"]}
        staff_id = raw_id(origin.get("senderStaffId"))
        target = {"type": "user", "id": staff_id}
        if origin["type"] == "group":
            target = {"type": "group", "id": raw_id(origin.get("conversationId")),
                      "respondentUserIds": [staff_id]}
        return {**result, "mode": "targeted", "delivery": origin["type"],
                "toolArguments": {"target": target, "timeoutMinutes": timeout or 5}}

    if kind == "user":
        keys(audience, {"type", "name", "staffId"})
        if ("name" in audience) == ("staffId" in audience):
            fail("invalid_audience", "指定用户需提供 name 或已核实的 staffId，二选一。")
    else:
        keys(audience, {"type", "groupName", "conversationId", "currentGroup", "respondents", "allMembers"})
        selectors = ["groupName" in audience, "conversationId" in audience,
                     audience.get("currentGroup") is True]
        if sum(selectors) != 1:
            fail("invalid_audience", "目标群需明确选择 groupName、conversationId 或 currentGroup。")
        if "currentGroup" in audience and audience["currentGroup"] is not True:
            fail("invalid_audience", "currentGroup 只能为 true。")
        if "allMembers" in audience and type(audience["allMembers"]) is not bool:
            fail("invalid_audience", "allMembers 必须为布尔值。")
        if (audience.get("allMembers") is True) == ("respondents" in audience):
            fail("invalid_audience", "明确指定 respondents 或 allMembers:true，二选一。")
        if "respondents" in audience:
            specs = audience["respondents"]
            if not isinstance(specs, list) or not 1 <= len(specs) <= MAX_RESPONDENTS:
                fail("respondent_limit", f"单张表单需要 1–{MAX_RESPONDENTS} 位填写人。")
            for spec in specs:
                keys(spec, {"name", "staffId", "self"})
                if len(spec) != 1 or ("self" in spec and spec["self"] is not True):
                    fail("invalid_audience", "每位填写人仅可指定 name、staffId 或 self:true。")

    binding = binding or {}
    bound_corp = binding.get("corpId")
    corp_id = request.get("corpId") or bound_corp
    if bound_corp and corp_id != bound_corp:
        fail("organization_mismatch", "请求组织与已确认的机器人组织绑定不一致。")
    directory = directory_factory(corp_id)
    if kind == "user":
        person = directory.person(audience)
        target = {"type": "user", "id": person["staffId"]}
        people = [person]
        delivery = "direct"
    else:
        group = directory.group(audience, origin)
        members = directory.members(group["id"])
        open_ids = {m["openDingtalkId"] for m in members}
        people, errors = [], []
        if audience.get("allMembers"):
            if not 1 <= len(members) <= MAX_RESPONDENTS:
                fail("respondent_limit", f"群真人成员需为 1–{MAX_RESPONDENTS} 人；不会静默截取或自动拆分。")
            for member in members:
                try:
                    people.append(directory.member_person(member))
                except ResolutionError as e:
                    errors.append({"member": member.get("name") or member.get("nick"), **e.result})
        else:
            for spec in audience["respondents"]:
                try:
                    lookup = {"staffId": raw_id(origin.get("senderStaffId"))} if spec.get("self") else spec
                    person = directory.person(lookup)
                    # A contact-only staffId needs a person-search link to the member open ID.
                    if not person.get("openDingtalkId"):
                        matches = [p for p in directory.people(person["name"])
                                   if p["staffId"] == person["staffId"] and p["openDingtalkId"] in open_ids]
                        if len(matches) != 1:
                            fail("membership_unresolved", "无法确认该身份属于目标群。")
                        person = matches[0]
                    if person["openDingtalkId"] not in open_ids:
                        fail("not_a_group_member", "查询到的成员不在目标群中。")
                    people.append(person)
                except ResolutionError as e:
                    errors.append({"member": spec.get("name") or spec.get("staffId") or "当前发起人", **e.result})
        if errors:
            fail("members_unresolved", "部分填写人无法确定，整张表单暂不发送。", issues=errors)
        identities = {}
        for person in people:
            key = person["staffId"].lower()
            identity = (person["staffId"], person["openDingtalkId"])
            if key in identities and identities[key] != identity:
                fail("identity_conflict", "不同群成员解析为相互冲突的 staffId。")
            identities[key] = identity
        target = {"type": "group", "id": group["id"],
                  "respondentUserIds": list(dict.fromkeys(p["staffId"] for p in people))}
        delivery = "group"
    return {**result, "mode": "targeted", "delivery": delivery,
            "corpId": directory.corp_id, "profile": directory.profile,
            "respondents": list({p["staffId"]: p for p in people}.values()),
            "toolArguments": {"target": target, "timeoutMinutes": timeout or 5}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, help="JSON request file; '-' reads stdin")
    args = parser.parse_args()
    try:
        request = json.load(sys.stdin) if args.request == "-" else json.loads(Path(args.request).read_text())
        path = Path(__file__).resolve().parent.parent / "organization.json"
        binding = json.loads(path.read_text()) if path.exists() else None
        result = resolve(request, binding=binding)
    except ResolutionError as e:
        result = e.result
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        result = {"status": "blocked", "code": "invalid_input_or_response",
                  "message": "输入或 DWS 返回结构不符合约定，本次未发送表单。"}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "ready" else 2


if __name__ == "__main__":
    sys.exit(main())

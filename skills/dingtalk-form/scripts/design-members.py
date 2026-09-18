#!/usr/bin/env python3
"""Read-only small-group picker for form design; never returns send arguments."""

import argparse
import json
from pathlib import Path
import sys

from dws_directory import Directory, ResolutionError, fail

PICKER_LIMIT = 12


def picker(request, directory_factory=Directory, binding=None):
    if not isinstance(request, dict) or set(request) - {"origin", "group", "corpId"}:
        fail("invalid_request", "选人请求仅接受 origin、group、corpId。")
    origin, group = request.get("origin"), request.get("group")
    if (not isinstance(origin, dict) or origin.get("type") not in {"direct", "group"}
            or set(origin) - {"type", "senderStaffId", "conversationId"}):
        fail("dingtalk_context_required", "需要当前钉钉会话的可信上下文。")
    if (not isinstance(group, dict)
            or set(group) - {"groupName", "conversationId", "currentGroup"}
            or len(group) != 1
            or ("currentGroup" in group and group["currentGroup"] is not True)):
        fail("invalid_group", "目标群需明确选择 groupName、conversationId 或 currentGroup:true。")
    binding = binding or {}
    corp_id = request.get("corpId") or binding.get("corpId")
    if binding.get("corpId") and corp_id != binding["corpId"]:
        fail("organization_mismatch", "请求组织与机器人绑定不一致。")
    directory = directory_factory(corp_id)
    target_group = directory.group(group, origin)
    rows = directory.members(target_group["id"])
    base = {"status": "ready", "purpose": "design_only", "group": target_group,
            "memberCount": len(rows), "corpId": directory.corp_id, "profile": directory.profile}
    if not rows:
        fail("no_members", "未找到可供选择的真人成员。")
    if len(rows) > PICKER_LIMIT:
        return {**base, "mode": "narrow",
                "message": "群成员较多，请提供姓名或部门线索缩小范围；没有截取部分名单。"}
    members, issues = [], []
    for row in rows:
        try:
            person = directory.member_person(row)
            if not isinstance(person.get("name"), str) or not person["name"].strip():
                fail("name_required", "缺少可展示的成员姓名。")
            members.append(person)
        except ResolutionError as exc:
            issues.append({"member": row.get("name") or row.get("nick"), **exc.result})
    if issues:
        fail("members_unresolved", "部分成员无法确认；请明确缩小人选范围后重新查询。", issues=issues)
    if len({p["staffId"].lower() for p in members}) != len(members):
        fail("identity_conflict", "不同群成员返回了冲突的 staffId。")
    if len({p["name"].strip() for p in members}) != len(members):
        fail("ambiguous_names", "存在同名成员，请补充部门等信息后消歧。", candidates=members)
    return {**base, "mode": "choose", "members": members,
            "field": {"name": "design_members", "label": "选择填写人", "type": "MULTI_SELECT",
                      "required": True,
                      "options": [{"value": p["staffId"], "text": p["name"]} for p in members]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, help="JSON request file; '-' reads stdin")
    args = parser.parse_args()
    try:
        request = json.load(sys.stdin) if args.request == "-" else json.loads(Path(args.request).read_text())
        path = Path(__file__).resolve().parent.parent / "organization.json"
        binding = json.loads(path.read_text()) if path.exists() else None
        result = picker(request, binding=binding)
    except ResolutionError as exc:
        result = exc.result
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        result = {"status": "blocked", "code": "invalid_input_or_response",
                  "message": "输入或目录返回不符合约定，本次未发送表单。"}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "ready" else 2


if __name__ == "__main__":
    sys.exit(main())

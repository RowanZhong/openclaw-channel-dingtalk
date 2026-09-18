#!/usr/bin/env python3
"""List all readable joined groups for a design-only single-select card."""

import argparse
from collections import Counter
import json
from pathlib import Path
import sys

from dws_directory import Directory, ResolutionError, complete, fail, raw_id


def picker(request, directory_factory=Directory, binding=None):
    if not isinstance(request, dict) or set(request) - {"origin", "corpId"}:
        fail("invalid_request", "选群请求仅接受 origin、corpId。")
    origin = request.get("origin")
    if (not isinstance(origin, dict) or origin.get("type") not in {"direct", "group"}
            or set(origin) - {"type", "senderStaffId", "conversationId"}):
        fail("dingtalk_context_required", "需要当前钉钉会话的可信上下文。")
    binding = binding or {}
    corp_id = request.get("corpId") or binding.get("corpId")
    if binding.get("corpId") and corp_id != binding["corpId"]:
        fail("organization_mismatch", "请求组织与机器人绑定不一致。")
    directory = directory_factory(corp_id)
    data = directory.query("chat", "+my-groups", "--page-all", "--page-limit", "50")
    complete(data)
    if (data.get("paginationKnown") is not True or data.get("truncated")
            or data.get("truncatedByResultLimit")):
        fail("incomplete_result", "群名单未完整读取，不能展示为全部可选群。")
    if not isinstance(data.get("groups"), list):
        fail("invalid_response", "群名单返回结构不符合当前适配版本。")
    groups = {}
    for row in data["groups"]:
        if not isinstance(row, dict):
            fail("invalid_response", "群名单包含无法识别的记录。")
        group_id = raw_id(row.get("conversationId"))
        name = row.get("name")
        if not isinstance(name, str) or not name.strip():
            fail("group_name_required", "部分群缺少名称，无法生成完整群名选项。")
        group = {"id": group_id, "name": name}
        count = row.get("memberCount")
        if type(count) is int and count >= 0:
            group["memberCount"] = count
        if group_id in groups and groups[group_id] != group:
            fail("group_conflict", "同一群 ID 返回了冲突资料，请稍后重查。")
        groups[group_id] = group
    if not groups:
        fail("no_groups", "当前 DWS 账号未查询到可选群，请检查账号或指定群名查询。")
    names = Counter(g["name"] for g in groups.values())
    options = []
    for group in groups.values():
        label = group["name"]
        if names[label] > 1 and "memberCount" in group:
            label += f"（{group['memberCount']} 人）"
        options.append({"value": group["id"], "text": label})
    # Keep the entire list. Indistinguishable names need more context before selection.
    if len({o["text"] for o in options}) != len(options):
        fail("ambiguous_groups", "存在名称及人数仍相同的群，请补充群信息后消歧。",
             candidates=list(groups.values()))
    return {"status": "ready", "purpose": "design_only", "mode": "choose",
            "scope": "dws_account_joined_groups", "groupCount": len(groups),
            "corpId": directory.corp_id, "profile": directory.profile,
            "groups": list(groups.values()),
            "field": {"name": "design_group", "label": "选择目标群", "type": "SELECT",
                      "required": True, "options": options}}


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
                  "message": "输入或群名单返回不符合约定，本次未发送表单。"}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "ready" else 2


if __name__ == "__main__":
    sys.exit(main())

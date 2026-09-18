"""Read-only DWS 1.0.58 adapter. No message/card writes or credential access."""

import json
import subprocess


class ResolutionError(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.result = {"status": "blocked", "code": code, "message": message, **details}


def fail(code, message, **details):
    raise ResolutionError(code, message, **details)


def raw_id(value):
    if not isinstance(value, str) or not value or value != value.strip():
        fail("invalid_id", "ID 必须是查询或可信上下文提供的非空原始字符串。")
    if len(value) > 256 or any(c.isspace() or ord(c) < 32 or c == ":" for c in value):
        fail("invalid_id", "ID 不得含前缀、空白或控制字符。")
    return value


def run_dws(args):
    # Arguments stay separate: names can contain shell punctuation without execution.
    try:
        result = subprocess.run(
            ["dws", *args, "--format", "json"],
            capture_output=True, text=True, timeout=65, check=False,
        )
    except FileNotFoundError:
        fail("dws_unavailable", "未找到 dws，请先安装并授权 DWS。")
    except subprocess.TimeoutExpired:
        fail("query_timeout", "DWS 查询超时，本次未发送表单。")
    try:
        data = json.loads(result.stdout)
    except (ValueError, TypeError):
        fail("invalid_response", "DWS 未返回有效 JSON，本次未发送表单。")
    if not isinstance(data, dict):
        fail("invalid_response", "DWS 返回结构不符合当前适配版本。")
    if (result.returncode or data.get("success") is False or data.get("error")
            or data.get("errorCode") or data.get("errcode")):
        # Never forward raw stdout/stderr: an auth failure can contain credentials.
        error = data.get("error")
        category = error.get("category") if isinstance(error, dict) else None
        category = category if category in {"auth", "permission", "validation", "network"} else "query"
        fail("dws_query_failed", f"DWS {category} 查询失败；检查授权、权限及连接，未发送表单。")
    return data


def complete(data):
    if (not isinstance(data, dict) or data.get("complete") is not True
            or data.get("hasMore") is not False or data.get("partial") is True
            or data.get("failedCount", 0) or data.get("failures")
            or data.get("truncatedByPageLimit")):
        fail("incomplete_result", "群或成员查询不完整，不能据此发送表单。")


def unique_exact(items, query, key, label):
    # Prefer a unique exact name to unrelated keyword matches, never first match.
    exact = [x for x in items if x.get("name") == query]
    candidates = exact or items
    by_id = {x[key]: x for x in candidates}
    if len(by_id) != 1 or not exact:
        fail("choose_candidate" if by_id else "not_found",
             f"请明确选择{label}；不能自动采用模糊匹配或同名结果。",
             candidates=list(by_id.values()))
    return next(iter(by_id.values()))


class Directory:
    def __init__(self, corp_id, runner=run_dws):
        if not corp_id:
            fail("organization_required", "需先绑定与机器人相同的 DWS 组织，不能以登录账号猜测组织。")
        self.runner = runner
        data = runner(["profile", "list"])
        profiles = [p for p in data.get("profiles", []) if p.get("corpId") == corp_id
                    and p.get("isOrgCurrent") is True]
        if len(profiles) != 1 or not profiles[0].get("profile"):
            fail("profile_required", "该组织没有唯一默认 DWS 账号，请明确配置默认账号。")
        p = profiles[0]
        self.profile = p["profile"]
        self.corp_id = corp_id
        self.corp_name = p.get("corpName")
        self.cache = {}

    def query(self, *args):
        return self.runner([*args, "--profile", self.profile])

    def by_staff_id(self, staff_id):
        staff_id = raw_id(staff_id)
        data = self.query("contact", "user", "get", "--ids", staff_id)
        rows = data.get("result")
        if not isinstance(rows, list) or len(rows) != 1:
            fail("identity_unresolved", "无法查询到唯一的组织成员。")
        employee = rows[0].get("orgEmployeeModel") or {}
        if employee.get("orgUserId") != staff_id:
            fail("id_type_mismatch", "输入不是已确认的 staffId，不能直接用于表单。")
        return {"name": employee.get("orgUserName", staff_id), "staffId": staff_id,
                "openDingtalkId": None, "source": "contact.orgEmployeeModel.orgUserId"}

    def people(self, name):
        if not isinstance(name, str) or not name.strip():
            fail("name_required", "请提供完整成员姓名。")
        if name in self.cache:
            return self.cache[name]
        data = self.query("aisearch", "person", "--keyword", name, "--dimension", "name")
        rows = data.get("result")
        if not isinstance(rows, list):
            fail("invalid_response", "人员搜索返回结构不符合当前适配版本。")
        people = []
        for row in rows:
            if not isinstance(row, dict) or row.get("sourceType") != "person":
                fail("invalid_response", "人员搜索返回了无法识别的候选类型。")
            meta = row.get("meta") or {}
            staff_id = meta.get("staffId")
            source = "aisearch.meta.staffId"
            if not staff_id:
                # userId is not assumed to be staffId. Require an actual directory mapping.
                user_id = row.get("userId")
                if user_id:
                    details = self.query("contact", "user", "get", "--ids", raw_id(user_id))
                    matches = details.get("result")
                    if isinstance(matches, list) and len(matches) == 1:
                        staff_id = (matches[0].get("orgEmployeeModel") or {}).get("orgUserId")
                        source = "contact.orgEmployeeModel.orgUserId"
            people.append({
                "name": meta.get("name") or row.get("title") or row.get("author"),
                "staffId": raw_id(staff_id) if staff_id else None,
                "openDingtalkId": row.get("openDingTalkId"),
                "source": source if staff_id else None,
            })
        identities = {}
        for p in people:
            if not p["staffId"]:
                continue
            key = p["staffId"].lower()
            identity = (p["staffId"], p["openDingtalkId"])
            if key in identities and identities[key] != identity:
                fail("identity_conflict", "同一 staffId 返回了冲突的人员映射。")
            identities[key] = identity
        self.cache[name] = people
        return people

    def person(self, spec):
        if "staffId" in spec:
            return self.by_staff_id(spec["staffId"])
        name = spec.get("name")
        people = self.people(name)
        if any(not p["staffId"] for p in people):
            fail("identity_unresolved", "人员候选缺少可靠的 staffId。", member=name)
        person = unique_exact(people, name, "staffId", "成员")
        return person

    def group(self, spec, origin):
        if spec.get("currentGroup") is True:
            if origin["type"] != "group":
                fail("not_in_group", "当前不是群聊，请指定目标群。")
            return {"id": raw_id(origin.get("conversationId")), "name": "当前群"}
        if "conversationId" in spec:
            return {"id": raw_id(spec["conversationId"]), "name": None}
        name = spec.get("groupName")
        if not isinstance(name, str) or not name.strip():
            fail("group_required", "请明确目标群。")
        data = self.query("chat", "+chat-search", "--query", name, "--page-all", "--page-limit", "50")
        complete(data)
        rows = data.get("chats")
        if not isinstance(rows, list):
            fail("invalid_response", "群搜索返回结构不符合当前适配版本。")
        candidates = [{"name": r.get("name") or r.get("title"),
                       "id": raw_id(r.get("openConversationId"))} for r in rows]
        return unique_exact(candidates, name, "id", "群")

    def members(self, group_id):
        data = self.query("chat", "+chat-members-list", "--conversation-id", group_id,
                          "--member-types", "user", "--page-limit", "50")
        complete(data)
        complete((data.get("buckets") or {}).get("users"))
        if data.get("conversationId") != group_id or not isinstance(data.get("users"), list):
            fail("invalid_response", "群成员结果不属于目标群或结构不匹配。")
        members = {}
        for row in data["users"]:
            oid = raw_id(row.get("openDingtalkId"))
            if oid in members and members[oid] != row:
                fail("identity_conflict", "同一成员 ID 返回冲突资料。")
            members[oid] = row
        return list(members.values())

    def member_person(self, member):
        name = member.get("name") or member.get("nick")
        people = [p for p in self.people(name)
                  if p["openDingtalkId"] == member["openDingtalkId"] and p["staffId"]]
        by_id = {p["staffId"]: p for p in people}
        if len(by_id) != 1:
            fail("identity_unresolved", "无法将该群成员可靠关联到组织 staffId。", member=name)
        return next(iter(by_id.values()))

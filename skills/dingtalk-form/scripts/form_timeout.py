#!/usr/bin/env python3
"""Validate design duration locally, before directory lookup or publication."""

import argparse
from decimal import Decimal, InvalidOperation, localcontext
import json
from pathlib import Path
import re
import sys

from dws_directory import ResolutionError, fail
from form_limits import MAX_TIMEOUT_MINUTES

TIMEOUT_MESSAGE = f"请填写 1–{MAX_TIMEOUT_MINUTES} 的整数分钟数，最长不超过 3 天；未发送表单，请修改时长。"


def validate_minutes(value):
    # Final tool arguments must remain strict integers, including rejecting bool/null.
    if type(value) is not int or not 1 <= value <= MAX_TIMEOUT_MINUTES:
        fail("invalid_timeout", TIMEOUT_MESSAGE)
    return value


def duration(request):
    if (not isinstance(request, dict) or set(request) != {"value", "unit"}
            or request["unit"] not in ("minutes", "hours", "days")):
        fail("invalid_request", "时长校验需提供原始 value 和 unit（minutes、hours 或 days）。")
    value = request["value"]
    if (type(value) not in (str, int, float)
            or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", str(value).strip())):
        fail("invalid_timeout", TIMEOUT_MESSAGE)
    try:
        number = Decimal(str(value).strip())
        # Check before multiplication/int conversion, including very large inputs.
        factor = {"minutes": 1, "hours": 60, "days": 1440}[request["unit"]]
        maximum = MAX_TIMEOUT_MINUTES // factor
        if not number.is_finite() or not 0 < number <= maximum:
            fail("invalid_timeout", TIMEOUT_MESSAGE)
        with localcontext() as context:
            context.prec = max(28, len(number.as_tuple().digits) + 4)
            minutes = number * factor
        if minutes != minutes.to_integral_value():
            fail("invalid_timeout", TIMEOUT_MESSAGE)
        result = validate_minutes(int(minutes))
    except InvalidOperation:
        fail("invalid_timeout", TIMEOUT_MESSAGE)
    return {"status": "ready", "purpose": "design_only", "timeoutMinutes": result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, help="JSON request file; '-' reads stdin")
    args = parser.parse_args()
    try:
        request = json.load(sys.stdin) if args.request == "-" else json.loads(Path(args.request).read_text())
        result = duration(request)
    except ResolutionError as exc:
        result = exc.result
    except (OSError, ValueError, TypeError):
        result = {"status": "blocked", "code": "invalid_input", "message": TIMEOUT_MESSAGE}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "ready" else 2


if __name__ == "__main__":
    sys.exit(main())

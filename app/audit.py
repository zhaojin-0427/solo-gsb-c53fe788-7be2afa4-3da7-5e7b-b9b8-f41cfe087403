"""实测核查:把巡场记录与某次排班保存的快照/assignment 对照。

核查只依据排班历史里保存的 **输入快照与 assignment**,不读取当前设置、
藏品或锁定——排班生成之后再改配置不影响这份核查。

每条实测记录为某件藏品在某个一小时槽位的观察结果:
    {"artifact_id", "slot", "location", "lux"}
其中 location 为 "storage" 或快照中的展位序号,lux 为该位置实测照度。

核查结论分四类报告:
- 超预算 (over_budget):已测剂量超过快照预算即告警;有缺测时只能得到
  「预算 - 已测剂量」的余额上界,上界为负说明即使缺测槽位全在库房
  (零剂量)也必然超预算,同样告警。
- 计划外展位 (deviations):该槽位实测位置与 assignment 计划位置不一致。
- 跨展位未隔库 (cross_booth):仅对相邻两个槽位都有实测的位置做判断,
  两个不同展位即违规;任一端缺测则不判断(以 incomplete 表达未知)。
- 缺测 (missing_slots):未提交实测的槽位。缺测不补零,完整剂量与真实
  余额未知,报告标记为 incomplete。
"""
from __future__ import annotations

import math


def _is_real_number(v) -> bool:
    """JSON 意义上的有限数字:bool 不算数字,NaN/Infinity 不接受。"""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate_records(records: list[dict], snapshot: dict) -> None:
    """校验实测记录,失败抛 ValueError(由路由层转成 400)。

    藏品、槽位以快照为界;location 只能是 storage 或快照展位;
    库房 lux 必须为 0,展位 lux 必须为有限非负;(藏品, 槽位) 不得重复。
    """
    num_slots = snapshot["num_slots"]
    num_booths = len(snapshot["booths"])
    artifact_ids = {a["id"] for a in snapshot["artifacts"]}

    seen: set[tuple[int, int]] = set()
    for i, r in enumerate(records):
        aid = r.get("artifact_id")
        slot = r.get("slot")
        loc = r.get("location")
        lux = r.get("lux")

        if not isinstance(aid, int) or isinstance(aid, bool):
            raise ValueError(f"第 {i + 1} 条记录:artifact_id 须为整数")
        if not isinstance(slot, int) or isinstance(slot, bool):
            raise ValueError(f"第 {i + 1} 条记录:slot 须为整数")
        if aid not in artifact_ids:
            raise ValueError(f"第 {i + 1} 条记录:藏品 {aid} 不在该排班快照中")
        if not 0 <= slot < num_slots:
            raise ValueError(f"第 {i + 1} 条记录:槽位 {slot} 超出快照范围 0~{num_slots - 1}")

        if loc != "storage" and not (isinstance(loc, int) and not isinstance(loc, bool)
                                     and 0 <= loc < num_booths):
            raise ValueError(
                f"第 {i + 1} 条记录:location 只能是 'storage' 或快照展位 0~{num_booths - 1}"
            )
        if not _is_real_number(lux):
            raise ValueError(f"第 {i + 1} 条记录:lux 须为有限数字")
        if loc == "storage":
            if lux != 0:
                raise ValueError(f"第 {i + 1} 条记录:库房照度必须为 0")
        elif lux < 0:
            raise ValueError(f"第 {i + 1} 条记录:展位照度必须非负")

        key = (aid, slot)
        if key in seen:
            raise ValueError(f"第 {i + 1} 条记录:藏品 {aid} 槽位 {slot} 重复记录")
        seen.add(key)


def build_audit_report(schedule: dict, records: list[dict]) -> dict:
    """依据排班(含 snapshot/result)与已校验的实测记录生成核查报告。

    返回结构:
    {
      "schedule_id", "incomplete": bool,
      "artifacts": [{
        "artifact_id", "name", "budget",
        "planned_location": [..num_slots],      # 原样取自 assignment
        "measured_slots": [{slot, location, lux, planned_location}],
        "missing_slots": [slot, ...],
        "measured_count",
        "measured_dose",                         # 仅已测槽位剂量之和
        "planned_dose",                          # assignment 计划全量剂量
        "balance_upper_bound",                   # budget - measured_dose
        "over_budget": bool,                     # 超预算告警
        "deviations": [{slot, planned_location, actual_location, lux}],
        "cross_booth": [{slot, from_location, to_location}],
      }, ...]
    }
    """
    snapshot = schedule["snapshot"]
    result = schedule["result"] or {}
    assignment = result.get("assignment") or {}
    num_slots = snapshot["num_slots"]
    booths = snapshot["booths"]

    # (artifact_id, slot) -> 实测记录,便于逐槽取数
    observed: dict[tuple[int, int], dict] = {(r["artifact_id"], r["slot"]): r for r in records}

    any_missing = False
    any_over = False
    artifacts_out = []

    for a in snapshot["artifacts"]:
        aid = a["id"]
        budget = a["budget"]
        planned = [
            ("storage" if loc == "storage" else int(loc))
            for loc in assignment.get(str(aid), [])
        ]
        # 防御:快照与 assignment 槽位数不一致时以快照为界补齐
        if len(planned) < num_slots:
            planned += ["storage"] * (num_slots - len(planned))
        planned = planned[:num_slots]

        measured_slots = []
        missing_slots = []
        deviations = []
        measured_dose = 0.0

        for t in range(num_slots):
            r = observed.get((aid, t))
            planned_loc = planned[t]
            if r is None:
                missing_slots.append(t)
                continue
            loc = r["location"]
            lux = float(r["lux"])
            if loc != "storage":
                measured_dose += lux
            measured_slots.append({
                "slot": t,
                "location": loc,
                "lux": lux,
                "planned_location": planned_loc,
            })
            # 计划外展位:实测位置与 assignment 不符
            if loc != planned_loc:
                deviations.append({
                    "slot": t,
                    "planned_location": planned_loc,
                    "actual_location": loc,
                    "lux": lux,
                })

        # 计划全量剂量(按快照展位照度,与 solver.doses 口径一致)
        planned_dose = sum(
            float(booths[b]) for b in planned if isinstance(b, int)
        )

        # 跨展位未隔库:只判相邻两槽都有实测的位置,两端展位且不同即违规
        cross_booth = []
        for t in range(num_slots - 1):
            r1 = observed.get((aid, t))
            r2 = observed.get((aid, t + 1))
            if r1 is None or r2 is None:
                continue
            l1, l2 = r1["location"], r2["location"]
            if l1 != "storage" and l2 != "storage" and l1 != l2:
                cross_booth.append({
                    "slot": t,
                    "from_location": l1,
                    "to_location": l2,
                })

        incomplete = bool(missing_slots)
        # 余额上界 = 预算 - 已测剂量;为负说明缺测槽即使全在库房也已超预算
        balance_upper_bound = budget - measured_dose
        over_budget = balance_upper_bound < 0

        any_missing = any_missing or incomplete
        any_over = any_over or over_budget

        artifacts_out.append({
            "artifact_id": aid,
            "name": a["name"],
            "budget": budget,
            "planned_location": planned,
            "measured_slots": measured_slots,
            "missing_slots": missing_slots,
            "measured_count": len(measured_slots),
            "measured_dose": measured_dose,
            "planned_dose": planned_dose,
            "balance_upper_bound": balance_upper_bound,
            "over_budget": over_budget,
            "deviations": deviations,
            "cross_booth": cross_booth,
        })

    return {
        "schedule_id": schedule["id"],
        "incomplete": any_missing,
        "over_budget": any_over,
        "artifacts": artifacts_out,
    }

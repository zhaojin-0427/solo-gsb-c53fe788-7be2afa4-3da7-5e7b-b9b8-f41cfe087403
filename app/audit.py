"""实测核查:用排班快照核对实测记录,不读取当前配置。

核查口径:
- 只使用排班保存时的输入快照(预算、展位照度、一小时时段)与求解结果
  assignment;配置此后如何修改与核查无关。
- 缺测时段不补零:完整剂量与余额未知,只给出已测剂量与余额上界
  (预算 - 已测剂量);已测剂量超过预算即告警,与是否缺测无关。
- 跨展位未隔库仅依据相邻两个时段的实测位置判定:两者都已测且为两个
  不同展位才告警;任一缺测则该对时段无法判定。
- 任一藏品存在缺测时段,整份报告标记为不完整(complete = False)。
"""
from __future__ import annotations

# 告警类型
ALARM_OVER_BUDGET = "over_budget"        # 超预算:已测剂量 > 预算
ALARM_UNPLANNED_BOOTH = "unplanned_booth"  # 计划外展位:实测在计划外的展位
ALARM_CROSS_BOOTH = "cross_booth"        # 跨展位未隔库:相邻两槽实测为不同展位
ALARM_MISSING = "missing"                # 缺测:存在无实测记录的时段


def run_audit(snapshot: dict, assignment: dict, measurements: list[dict]) -> dict:
    """核查实测记录,返回报告(不含 audit_id 等存储字段,由调用方补充)。

    snapshot: 排班输入快照 {"num_slots", "booths", "artifacts", ...}
    assignment: 求解结果 assignment {str(artifact_id): [location, ...]},
                location 为 "storage" 或展位序号 int
    measurements: 已校验的实测记录
                  [{"artifact_id", "slot", "location", "lux"}]
    """
    num_slots = snapshot["num_slots"]
    booths = snapshot["booths"]

    measured_by_artifact: dict[int, dict[int, dict]] = {}
    for m in measurements:
        measured_by_artifact.setdefault(m["artifact_id"], {})[m["slot"]] = m

    artifacts_report = []
    alarms = []
    complete = True

    for art in snapshot["artifacts"]:
        aid = art["id"]
        name = art["name"]
        budget = art["budget"]
        plan = assignment[str(aid)]
        measured = measured_by_artifact.get(aid, {})

        slots = []
        missing = []
        differences = []
        measured_dose = 0
        planned_dose = 0

        for t in range(num_slots):
            planned_loc = plan[t]
            planned_lux = 0 if planned_loc == "storage" else booths[planned_loc]
            planned_dose += planned_lux
            m = measured.get(t)
            if m is None:
                # 缺测不补零:该时段不参与剂量累加,只记入缺测清单
                missing.append(t)
                slots.append({
                    "slot": t,
                    "planned_location": planned_loc,
                    "planned_lux": planned_lux,
                    "measured_location": None,
                    "measured_lux": None,
                    "status": "missing",
                })
                continue
            m_loc = m["location"]
            m_lux = m["lux"]
            measured_dose += m_lux
            if m_loc == planned_loc:
                status = "ok"
            else:
                status = "different"
                differences.append({
                    "slot": t,
                    "planned_location": planned_loc,
                    "measured_location": m_loc,
                    "planned_lux": planned_lux,
                    "measured_lux": m_lux,
                })
            slots.append({
                "slot": t,
                "planned_location": planned_loc,
                "planned_lux": planned_lux,
                "measured_location": m_loc,
                "measured_lux": m_lux,
                "status": status,
            })

        # 跨展位未隔库:仅看相邻两槽的实测位置,两者都已测且为不同展位
        cross_booth = []
        for t in range(num_slots - 1):
            m1 = measured.get(t)
            m2 = measured.get(t + 1)
            if m1 is None or m2 is None:
                continue
            l1, l2 = m1["location"], m2["location"]
            if l1 != "storage" and l2 != "storage" and l1 != l2:
                cross_booth.append({"slots": [t, t + 1], "from": l1, "to": l2})

        dose_complete = not missing
        if not dose_complete:
            complete = False
        # 余额上界 = 预算 - 已测剂量;缺测时完整剂量与余额均未知
        balance_upper = budget - measured_dose
        over_budget = measured_dose > budget

        # 告警顺序:超预算 → 计划外展位 → 跨展位未隔库 → 缺测
        if over_budget:
            alarms.append({
                "type": ALARM_OVER_BUDGET,
                "artifact_id": aid,
                "artifact_name": name,
                "measured_dose": measured_dose,
                "budget": budget,
            })
        for d in differences:
            if d["measured_location"] != "storage":
                alarms.append({
                    "type": ALARM_UNPLANNED_BOOTH,
                    "artifact_id": aid,
                    "artifact_name": name,
                    "slot": d["slot"],
                    "planned_location": d["planned_location"],
                    "measured_location": d["measured_location"],
                })
        for cb in cross_booth:
            alarms.append({
                "type": ALARM_CROSS_BOOTH,
                "artifact_id": aid,
                "artifact_name": name,
                "slots": cb["slots"],
                "from": cb["from"],
                "to": cb["to"],
            })
        if missing:
            alarms.append({
                "type": ALARM_MISSING,
                "artifact_id": aid,
                "artifact_name": name,
                "slots": missing,
            })

        artifacts_report.append({
            "artifact_id": aid,
            "name": name,
            "budget": budget,
            "planned_dose": planned_dose,
            "measured_dose": measured_dose,
            "dose_complete": dose_complete,
            # 缺测时余额未知,为 null;余额上界始终给出
            "balance": balance_upper if dose_complete else None,
            "balance_upper": balance_upper,
            "over_budget": over_budget,
            "measured_slots": num_slots - len(missing),
            "missing_slots": missing,
            "differences": differences,
            "cross_booth": cross_booth,
            "slots": slots,
        })

    return {
        "complete": complete,
        # 核查所用的计划(快照要点 + assignment)与实测原样存档,供事后复查
        "plan": {
            "num_slots": num_slots,
            "booths": booths,
            "artifacts": [
                {"id": a["id"], "name": a["name"], "budget": a["budget"]}
                for a in snapshot["artifacts"]
            ],
            "assignment": assignment,
        },
        "measurements": measurements,
        "artifacts": artifacts_report,
        "alarms": alarms,
    }

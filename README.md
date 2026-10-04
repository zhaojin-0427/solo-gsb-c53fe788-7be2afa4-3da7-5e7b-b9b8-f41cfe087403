# 藏品光照轮换台

面向博物馆策展人员的藏品光照排班工具:在光照预算约束下,为最多 8 件藏品在最多 3 个单件展位与库房之间安排最多 72 个连续一小时时段,由 OR-Tools CP-SAT 求解(限时 10 秒),结果以原生 JavaScript 页面展示并持久保存。另提供**实测核查**:把巡场记录与某次排班保存的快照/计划逐槽对照,报告超预算、计划外展位、跨展位未隔库与缺测。

## 一键启动(Docker Compose)

```bash
docker compose up --build
```

启动后在浏览器访问:**http://localhost:8000**

- 页面依次为:① 排班设置 → ② 藏品 → ③ 时段锁定 → ④ 求解与结果 → ⑤ 历史排班 → ⑥ 实测核查。
- 数据保存在名为 `scheduler-data` 的 Docker 卷中(SQLite),容器重启、页面刷新后历史排班与核查报告仍可查看。

## 本地开发(不用 Docker)

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

同样访问 http://localhost:8000 。SQLite 数据库默认写入 `./data/scheduler.db`(可用环境变量 `DATA_DIR` 修改)。

## 功能与规则

- **排班设置**:1~72 个连续一小时时段;1~3 个单件展位,每个展位照度 1~10000 lx。
- **藏品**:最多 8 件,每件设置剩余光照预算(0~720000 lx·h)、优先级(1~10)、最低展出时数(0~72 h)。
- **时段锁定**:可将某件藏品在指定时段锁定到某展位或库房。
- **约束**:
  - 每件藏品每时段恰好处于一个展位或库房;
  - 库房不消耗光照;展位剂量 = 照度 × 小时,逐时段累加且不得超过剩余预算;
  - 每个展位每时段最多一件藏品;
  - 跨展位移动须间隔至少一小时库房(相邻时段不得处于两个不同展位)。
- **目标**(字典序):先满足最低展出时数与锁定(硬约束),再最大化优先级加权的展出小时数,最后最小化相邻时段出入库次数。
- **求解状态**:限时 10 秒,明确区分
  - `最优解(已证最优)`
  - `可行但未证最优`
  - `无解`(约束冲突)
  - `超时未找到方案`
- **输入快照一致性**:点击“开始求解”后,本次求解使用的设置、藏品与锁定在一个数据库事务中一次性读取,构成输入快照;**求解期间(最长 10 秒)仍可继续编辑配置或发起另一次求解**,不会互相阻塞。无论结果是有解、无解还是超时,历史记录保存的都是求解结果与**它自己的那份输入快照**,因此求解中途修改时段数、展位照度、藏品或锁定,不会造成旧结果错配新快照(时间轴截断、剂量说明错误);并发的多次求解也各自保持输入与结果对应。
- **结果展示**:展位时间轴(各展位/库房逐时段占用)、逐件已用剂量与余额、加权展出小时与出入库次数;历史排班保存在 SQLite 中,刷新后仍可查看,升级前生成的旧历史记录同样可以打开。

## 实测核查

在页面 **⑥ 实测核查** 中选择一份历史排班(须为 `optimal`/`feasible`),逐槽录入巡场实测(藏品、槽位、实测位置、实测照度),提交后得到并持久保存一份核查报告;也可输入已有 `audit_id` 原样回看。核查只依据该排班**保存时的输入快照与 assignment,不读取当前配置**,且不会改动排班。

- **记录约束**:`藏品`、`slot`(0 起的一小时槽)以快照为界;`location` 只能是 `"storage"` 或快照中的展位序号;库房实测 `lux` 必须为 0,展位 `lux` 为有限非负数;同一 `(藏品, slot)` 重复记录一律拒绝(400)。
- **超预算**:剂量 = 各已测槽的实测照度之和(库房为 0)。**缺测不补零**,完整剂量与真实余额未知;报告给出已测剂量与余额上界 `budget − measured_dose`。上界为负意味着即使所有缺测槽都在库房(零剂量)也必然超预算,触发 `over_budget` 告警。
- **计划外展位**:该槽实测位置与 assignment 计划位置不一致即列入 `deviations`。
- **跨展位未隔库**:只对**相邻两槽都有实测**的位置判断,两端为不同展位即列入 `cross_booth`;任一端缺测则不判断,以报告 `incomplete` 表达信息不完整。
- **缺测**:未提交实测的槽位列入 `missing_slots`,报告顶层 `incomplete=true`。
- **状态码**:未知排班 / 未知 audit → 404;排班无 assignment 或状态非 `optimal`/`feasible`(如 `infeasible`、`unknown`)→ **409**;记录越界、库房照度非 0、重复等 → 400。

### 请求示例

```bash
curl -X POST http://localhost:8000/api/schedules/1/audit \
  -H 'Content-Type: application/json' \
  -d '{
    "records": [
      {"artifact_id": 1, "slot": 0, "location": 1, "lux": 200},
      {"artifact_id": 1, "slot": 1, "location": "storage", "lux": 0}
    ]
  }'
```

### 响应示例(节选)

```json
{
  "audit_id": 1,
  "schedule_id": 1,
  "created_at": "2026-10-04T03:00:45",
  "records": [
    {"artifact_id": 1, "slot": 0, "location": 1, "lux": 200.0},
    {"artifact_id": 1, "slot": 1, "location": "storage", "lux": 0.0}
  ],
  "report": {
    "schedule_id": 1,
    "incomplete": true,
    "over_budget": false,
    "artifacts": [
      {
        "artifact_id": 1,
        "name": "青铜鼎",
        "budget": 600000,
        "planned_location": [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        "measured_count": 2,
        "measured_dose": 200.0,
        "planned_dose": 2400.0,
        "balance_upper_bound": 599800.0,
        "over_budget": false,
        "missing_slots": [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        "deviations": [
          {"slot": 1, "planned_location": 1, "actual_location": "storage", "lux": 0.0}
        ],
        "cross_booth": []
      }
    ]
  }
}
```

回看:`GET /api/audits/1` 返回与上面完全一致的内容(记录与报告原样保存,不重新计算)。

## 项目结构

```
app/
├── main.py        # FastAPI 路由与校验
├── db.py          # SQLite 数据访问(设置/藏品/锁定/排班历史/核查报告)
├── solver.py      # OR-Tools CP-SAT 模型与求解
├── audit.py       # 实测记录校验与核查报告(基于排班快照与 assignment)
└── static/        # 原生 JS 页面(index.html / app.js / style.css)
Dockerfile
docker-compose.yml
requirements.txt
```

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 设置、藏品、锁定、历史排班汇总 |
| PUT | `/api/settings` | 更新时段数 / 展位数 / 各展位照度 |
| POST / PUT / DELETE | `/api/artifacts[/{id}]` | 藏品增改删 |
| PUT | `/api/locks` | 设置或清除某藏品某时段的锁定 |
| POST | `/api/solve` | 求解并保存排班(限时 10 秒) |
| GET / DELETE | `/api/schedules[/{id}]` | 查看 / 删除历史排班 |
| POST | `/api/schedules/{id}/audit` | 按排班快照/计划核查实测,返回 `audit_id`(非 optimal/feasible → 409) |
| GET | `/api/audits/{id}` | 原样查看已保存的实测记录与核查报告 |

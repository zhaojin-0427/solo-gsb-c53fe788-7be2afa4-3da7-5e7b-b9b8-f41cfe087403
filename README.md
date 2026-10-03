# 藏品光照轮换台

面向博物馆策展人员的藏品光照排班工具:在光照预算约束下,为最多 8 件藏品在最多 3 个单件展位与库房之间安排最多 72 个连续一小时时段,由 OR-Tools CP-SAT 求解(限时 10 秒),结果以原生 JavaScript 页面展示并持久保存。排班执行后可录入逐时段实测(位置 + 照度)进行**实测核查**:以排班快照为基准核对超预算、计划外展位、跨展位未隔库与缺测,核查记录独立保存,不回改排班。

## 一键启动(Docker Compose)

```bash
docker compose up --build
```

启动后在浏览器访问:**http://localhost:8000**

数据保存在名为 `scheduler-data` 的 Docker 卷中(SQLite),容器重启、页面刷新后历史排班与核查记录仍可查看。

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
- **实测核查**(页面⑥或 `POST /api/schedules/{id}/audit`):对一条有效排班(状态为最优解 / 可行且含 assignment)录入逐时段实测 `{slot, location, lux}`,系统**只依据该排班保存时的快照**(预算、展位照度、一小时时段)与 assignment 核查,不读取当前配置:
  - **超预算**:已测剂量超过快照预算即告警,与是否缺测无关;
  - **计划外展位**:实测位置与计划位置不符且实测位于展位;
  - **跨展位未隔库**:仅依据相邻两个时段的**实测位置**判定,两者都已测且为不同展位才告警,任一缺测则该对时段无法判定;
  - **缺测**:缺测时段**不补零**——完整剂量与余额未知,报告只给出已测剂量与余额上界(预算 − 已测剂量);任一藏品有缺测,整份报告标记为不完整(`complete: false`)。
  - 校验:藏品与时段须在快照范围内;位置仅允许 `storage` 或快照展位序号;库房照度必须为 0,展位照度为有限非负数;同一藏品同一时段重复记录拒绝(400)。排班不存在返回 404;状态为未知 / 超时、无解或无 assignment 返回 409。
  - 核查所用的计划与实测随报告一并保存并返回 `audit_id`,`GET /api/audits/{id}` 原样查看;核查不修改排班。页面展示逐件剂量、未知项、计划/实测差异与告警。

## 项目结构

```
app/
├── main.py        # FastAPI 路由与校验
├── db.py          # SQLite 数据访问(设置/藏品/锁定/排班历史/核查记录)
├── solver.py      # OR-Tools CP-SAT 模型与求解
├── audit.py       # 实测核查逻辑(纯函数,基于排班快照)
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
| POST | `/api/schedules/{id}/audit` | 提交实测记录并核查(201,返回 `audit_id` 与报告) |
| GET | `/api/schedules/{id}/audits` | 该排班的核查记录摘要列表 |
| GET | `/api/audits/{id}` | 按 `audit_id` 原样查看核查报告 |

## 实测核查 API 示例

先求解得到排班(假设 `id = 2`),再提交实测记录。`location` 为 `"storage"` 或展位序号(0 起);库房 `lux` 必须为 0,展位 `lux` 为有限非负数:

```bash
curl -X POST http://localhost:8000/api/schedules/2/audit \
  -H 'Content-Type: application/json' \
  -d '{
    "measurements": [
      {"artifact_id": 1, "slot": 0, "location": 1, "lux": 200},
      {"artifact_id": 1, "slot": 1, "location": 0, "lux": 250},
      {"artifact_id": 2, "slot": 0, "location": 0, "lux": 200}
    ]
  }'
```

响应 `201 Created`(节选,长数组以 `…` 略):

```json
{
  "audit_id": 3,
  "schedule_id": 2,
  "created_at": "2026-10-03T23:21:38",
  "complete": false,
  "plan": {
    "num_slots": 12,
    "booths": [200, 200],
    "artifacts": [{"id": 1, "name": "青铜鼎", "budget": 600000}, …],
    "assignment": {"1": [1, 1, …], …}
  },
  "measurements": [
    {"artifact_id": 1, "slot": 0, "location": 1, "lux": 200},
    {"artifact_id": 1, "slot": 1, "location": 0, "lux": 250},
    {"artifact_id": 2, "slot": 0, "location": 0, "lux": 200}
  ],
  "artifacts": [
    {
      "artifact_id": 1,
      "name": "青铜鼎",
      "budget": 600000,
      "planned_dose": 2400,
      "measured_dose": 450,
      "dose_complete": false,
      "balance": null,
      "balance_upper": 599550,
      "over_budget": false,
      "measured_slots": 2,
      "missing_slots": [2, 3, …],
      "differences": [
        {"slot": 1, "planned_location": 1, "measured_location": 0,
         "planned_lux": 200, "measured_lux": 250}
      ],
      "cross_booth": [{"slots": [0, 1], "from": 1, "to": 0}],
      "slots": [ …逐时段计划/实测明细… ]
    },
    …
  ],
  "alarms": [
    {"type": "unplanned_booth", "artifact_id": 1, "artifact_name": "青铜鼎",
     "slot": 1, "planned_location": 1, "measured_location": 0},
    {"type": "cross_booth", "artifact_id": 1, "artifact_name": "青铜鼎",
     "slots": [0, 1], "from": 1, "to": 0},
    {"type": "missing", "artifact_id": 1, "artifact_name": "青铜鼎", "slots": [2, 3, …]},
    …
  ]
}
```

要点:

- `complete: false`:存在缺测时段,整份报告不完整;`balance` 为 `null`(余额未知),`balance_upper = 预算 − 已测剂量` 始终给出。
- 告警类型:`over_budget`(超预算)、`unplanned_booth`(计划外展位)、`cross_booth`(跨展位未隔库)、`missing`(缺测)。
- 之后可随时原样取回这份报告:

```bash
curl http://localhost:8000/api/audits/3
```

错误响应:`404` 排班 / 核查记录不存在;`409` 排班状态为未知(超时)、无解或无 assignment;`400` 藏品 / 时段超出快照范围、位置非法、库房照度非 0、重复记录;`422` 请求体格式错误(如照度为负、NaN 或无穷)。

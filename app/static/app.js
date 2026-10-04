/* 藏品光照轮换台 —— 原生 JavaScript 前端 */
"use strict";

const PALETTE = ["#8c5b2f", "#2f6f8c", "#7a3b8c", "#3b8c4e", "#b03a2e", "#5d6d7e", "#a04000", "#117a65"];

let state = {
  settings: null,
  artifacts: [],
  locks: [],
  schedules: [],
  limits: {},
};
let currentSchedule = null; // 当前在结果区查看的排班

const $ = (sel) => document.querySelector(sel);

async function api(path, method = "GET", body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`;
    try {
      const data = await resp.json();
      if (data.detail) {
        detail = typeof data.detail === "string"
          ? data.detail
          : (data.detail[0] && data.detail[0].msg ? data.detail[0].msg : JSON.stringify(data.detail));
      }
    } catch (_) { /* ignore */ }
    const err = new Error(detail);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

function fmt(n) {
  return n === null || n === undefined ? "—" : Number(n).toLocaleString("zh-CN");
}

function colorFor(id, artifacts) {
  const idx = artifacts.findIndex((a) => a.id === id);
  return PALETTE[(idx < 0 ? 0 : idx) % PALETTE.length];
}

function chip(name, color) {
  const span = document.createElement("span");
  span.className = "chip";
  span.style.background = color;
  span.textContent = name;
  span.title = name;
  return span;
}

/* ---------------- 设置 ---------------- */

function renderSettings() {
  const s = state.settings;
  const L = state.limits;
  const box = $("#settings-form");
  box.innerHTML = "";

  const slotField = document.createElement("div");
  slotField.className = "field";
  slotField.innerHTML = `<label>时段数(连续 1 小时/段,1~${L.max_slots})</label>`;
  const slotInput = document.createElement("input");
  slotInput.type = "number"; slotInput.className = "num";
  slotInput.min = 1; slotInput.max = L.max_slots; slotInput.value = s.num_slots;
  slotField.appendChild(slotInput);

  const boothField = document.createElement("div");
  boothField.className = "field";
  boothField.innerHTML = `<label>展位数(1~${L.max_booths},单件展位)</label>`;
  const boothSel = document.createElement("select");
  for (let i = 1; i <= L.max_booths; i++) {
    const opt = document.createElement("option");
    opt.value = i; opt.textContent = `${i} 个`;
    boothSel.appendChild(opt);
  }
  boothSel.value = s.num_booths;
  boothField.appendChild(boothSel);

  const luxWrap = document.createElement("div");
  luxWrap.className = "form-row";

  function renderLuxInputs() {
    luxWrap.innerHTML = "";
    const n = Number(boothSel.value);
    for (let b = 0; b < n; b++) {
      const f = document.createElement("div");
      f.className = "field";
      f.innerHTML = `<label>展位 ${b + 1} 照度 (1~${fmt(L.max_lux)} lx)</label>`;
      const inp = document.createElement("input");
      inp.type = "number"; inp.className = "num lux-input";
      inp.min = 1; inp.max = L.max_lux;
      const prev = luxWrap.dataset["lux" + b];
      inp.value = prev !== undefined ? prev : (s.lux[b] !== undefined ? s.lux[b] : 200);
      inp.dataset.idx = b;
      f.appendChild(inp);
      luxWrap.appendChild(f);
    }
  }
  boothSel.addEventListener("change", () => {
    luxWrap.querySelectorAll(".lux-input").forEach((inp) => {
      luxWrap.dataset["lux" + inp.dataset.idx] = inp.value;
    });
    renderLuxInputs();
  });
  renderLuxInputs();

  const saveBtn = document.createElement("button");
  saveBtn.className = "primary";
  saveBtn.textContent = "保存设置";
  saveBtn.addEventListener("click", async () => {
    const lux = [...luxWrap.querySelectorAll(".lux-input")].map((i) => Number(i.value));
    try {
      await api("/api/settings", "PUT", {
        num_slots: Number(slotInput.value),
        num_booths: Number(boothSel.value),
        lux,
      });
      await refresh();
    } catch (e) {
      alert("保存失败:" + e.message);
    }
  });

  box.append(slotField, boothField, luxWrap, saveBtn);
}

/* ---------------- 藏品 ---------------- */

function renderArtifacts() {
  const L = state.limits;
  const tbody = $("#artifacts-table tbody");
  const tfoot = $("#artifacts-table tfoot");
  tbody.innerHTML = "";
  tfoot.innerHTML = "";

  state.artifacts.forEach((a) => {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    const nameInp = document.createElement("input");
    nameInp.className = "name-input"; nameInp.value = a.name; nameInp.maxLength = 50;
    tdName.appendChild(nameInp);

    const tdBudget = document.createElement("td");
    const budgetInp = document.createElement("input");
    budgetInp.type = "number"; budgetInp.className = "num";
    budgetInp.min = 0; budgetInp.max = L.max_budget; budgetInp.value = a.budget;
    tdBudget.appendChild(budgetInp);

    const tdPri = document.createElement("td");
    const priInp = document.createElement("input");
    priInp.type = "number"; priInp.className = "num"; priInp.style.width = "70px";
    priInp.min = 1; priInp.max = L.max_priority; priInp.value = a.priority;
    tdPri.appendChild(priInp);

    const tdMin = document.createElement("td");
    const minInp = document.createElement("input");
    minInp.type = "number"; minInp.className = "num"; minInp.style.width = "70px";
    minInp.min = 0; minInp.max = L.max_slots; minInp.value = a.min_hours;
    tdMin.appendChild(minInp);

    const tdOps = document.createElement("td");
    const saveBtn = document.createElement("button");
    saveBtn.className = "small"; saveBtn.textContent = "保存";
    saveBtn.addEventListener("click", async () => {
      try {
        await api(`/api/artifacts/${a.id}`, "PUT", {
          name: nameInp.value.trim(),
          budget: Number(budgetInp.value),
          priority: Number(priInp.value),
          min_hours: Number(minInp.value),
        });
        await refresh();
      } catch (e) { alert("保存失败:" + e.message); }
    });
    const delBtn = document.createElement("button");
    delBtn.className = "small danger"; delBtn.textContent = "删除";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`删除藏品「${a.name}」?其锁定也会一并删除。`)) return;
      await api(`/api/artifacts/${a.id}`, "DELETE");
      await refresh();
    });
    tdOps.append(saveBtn, " ", delBtn);

    tr.append(tdName, tdBudget, tdPri, tdMin, tdOps);
    tbody.appendChild(tr);
  });

  // 新增行
  if (state.artifacts.length < L.max_artifacts) {
    const tr = document.createElement("tr");
    const nameInp = document.createElement("input");
    nameInp.className = "name-input"; nameInp.placeholder = "新藏品名称";
    const budgetInp = document.createElement("input");
    budgetInp.type = "number"; budgetInp.className = "num";
    budgetInp.min = 0; budgetInp.max = L.max_budget; budgetInp.value = 100000;
    const priInp = document.createElement("input");
    priInp.type = "number"; priInp.className = "num"; priInp.style.width = "70px";
    priInp.min = 1; priInp.max = L.max_priority; priInp.value = 5;
    const minInp = document.createElement("input");
    minInp.type = "number"; minInp.className = "num"; minInp.style.width = "70px";
    minInp.min = 0; minInp.max = L.max_slots; minInp.value = 0;
    const addBtn = document.createElement("button");
    addBtn.className = "small primary"; addBtn.textContent = "添加";
    addBtn.addEventListener("click", async () => {
      if (!nameInp.value.trim()) { alert("请填写藏品名称"); return; }
      try {
        await api("/api/artifacts", "POST", {
          name: nameInp.value.trim(),
          budget: Number(budgetInp.value),
          priority: Number(priInp.value),
          min_hours: Number(minInp.value),
        });
        await refresh();
      } catch (e) { alert("添加失败:" + e.message); }
    });
    const tds = [nameInp, budgetInp, priInp, minInp, addBtn].map((el) => {
      const td = document.createElement("td");
      td.appendChild(el);
      return td;
    });
    tr.append(...tds);
    tfoot.appendChild(tr);
  } else {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.textContent = `已达藏品上限 ${L.max_artifacts} 件`;
    td.style.color = "var(--muted)";
    tr.appendChild(td);
    tfoot.appendChild(tr);
  }
}

/* ---------------- 锁定 ---------------- */

function lockValue(artifactId, slot) {
  const lk = state.locks.find((l) => l.artifact_id === artifactId && l.slot === slot);
  return lk ? lk.location : null;
}

function lockLabel(loc) {
  if (loc === null || loc === undefined) return "";
  return loc === "storage" ? "库" : `展${loc + 1}`;
}

function renderLocks() {
  const box = $("#locks-grid");
  box.innerHTML = "";
  const s = state.settings;
  if (state.artifacts.length === 0) {
    box.innerHTML = '<p class="hint">暂无藏品。</p>';
    return;
  }
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  const th0 = document.createElement("th");
  th0.textContent = "藏品 \\ 时段";
  hr.appendChild(th0);
  for (let t = 0; t < s.num_slots; t++) {
    const th = document.createElement("th");
    th.textContent = t + 1;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  // 循环顺序: null -> 0..B-1 -> 'storage' -> null
  const cycle = [null];
  for (let b = 0; b < s.num_booths; b++) cycle.push(b);
  cycle.push("storage");

  state.artifacts.forEach((a) => {
    const tr = document.createElement("tr");
    const head = document.createElement("td");
    head.className = "row-head";
    head.appendChild(chip(a.name, colorFor(a.id, state.artifacts)));
    tr.appendChild(head);
    for (let t = 0; t < s.num_slots; t++) {
      const td = document.createElement("td");
      td.className = "lock-cell";
      const cur = lockValue(a.id, t);
      td.innerHTML = `<span class="lock-tag">${lockLabel(cur)}</span>`;
      if (cur !== null && cur !== undefined) {
        td.style.background = cur === "storage" ? "#dfe5ec" : "#f3e2c7";
      }
      td.addEventListener("click", async () => {
        const now = lockValue(a.id, t);
        const idx = cycle.findIndex((v) => v === now || (v !== null && now !== null && String(v) === String(now)));
        const next = cycle[(idx + 1) % cycle.length];
        try {
          await api("/api/locks", "PUT", { artifact_id: a.id, slot: t, location: next });
          state.locks = state.locks.filter((l) => !(l.artifact_id === a.id && l.slot === t));
          if (next !== null) state.locks.push({ artifact_id: a.id, slot: t, location: next });
          renderLocks();
        } catch (e) { alert("锁定失败:" + e.message); }
      });
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  box.appendChild(table);
}

/* ---------------- 求解与结果 ---------------- */

const STATUS_TEXT = {
  optimal: "最优解(已证最优)",
  feasible: "可行但未证最优",
  infeasible: "无解:约束冲突(最低时数 / 预算 / 锁定无法满足)",
  unknown: "超时未找到方案(10 秒内未找到可行解)",
  error: "求解器错误",
};

function statusBadge(status) {
  const span = document.createElement("span");
  span.className = `badge ${status}`;
  span.textContent = STATUS_TEXT[status] || status;
  return span;
}

function renderResult(sched) {
  currentSchedule = sched;
  const area = $("#result-area");
  area.innerHTML = "";
  if (!sched) {
    area.innerHTML = '<p class="hint">尚未求解。设置参数后点击“开始求解”。</p>';
    return;
  }
  const snap = sched.snapshot;
  const res = sched.result || {};

  const banner = document.createElement("div");
  banner.className = "result-banner";
  banner.appendChild(statusBadge(sched.status));
  const meta = document.createElement("div");
  meta.className = "result-meta";
  meta.innerHTML =
    `<span>排班 #${sched.id} · ${sched.created_at}</span>` +
    (res.wall_time !== undefined ? `<span>求解耗时 <b>${res.wall_time}s</b></span>` : "") +
    (sched.weighted_hours !== null && sched.weighted_hours !== undefined
      ? `<span>优先级加权展出小时 <b>${fmt(sched.weighted_hours)}</b></span>` : "") +
    (sched.transitions !== null && sched.transitions !== undefined
      ? `<span>出入库次数 <b>${fmt(sched.transitions)}</b></span>` : "");
  banner.appendChild(meta);
  area.appendChild(banner);

  if (!res.assignment) return; // 无解 / 超时:无排班可展示

  // ---- 展位时间轴 ----
  const h3 = document.createElement("h3");
  h3.textContent = "展位时间轴";
  h3.style.fontSize = "15px";
  area.appendChild(h3);

  const T = snap.num_slots;
  const B = snap.booths.length;
  const arts = snap.artifacts;
  const byId = {};
  arts.forEach((a) => { byId[a.id] = a; });

  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "timeline";
  const hr = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "row-head";
  corner.textContent = "位置 \\ 时段";
  hr.appendChild(corner);
  for (let t = 0; t < T; t++) {
    const th = document.createElement("th");
    th.textContent = t + 1;
    hr.appendChild(th);
  }
  table.appendChild(hr);

  // 每个 (展位, 时段) 被谁占用;库房行列出所有在库房的藏品
  const boothCell = {}; // "b,t" -> artifact id
  const storageCell = {}; // t -> [artifact id]
  arts.forEach((a) => {
    const locs = res.assignment[String(a.id)] || [];
    locs.forEach((loc, t) => {
      if (loc === "storage") {
        (storageCell[t] = storageCell[t] || []).push(a.id);
      } else {
        boothCell[`${loc},${t}`] = a.id;
      }
    });
  });

  for (let b = 0; b < B; b++) {
    const tr = document.createElement("tr");
    const head = document.createElement("td");
    head.className = "row-head";
    head.textContent = `展位 ${b + 1}(${fmt(snap.booths[b])} lx)`;
    tr.appendChild(head);
    for (let t = 0; t < T; t++) {
      const td = document.createElement("td");
      const id = boothCell[`${b},${t}`];
      if (id !== undefined) {
        td.appendChild(chip(byId[id].name, colorFor(id, arts)));
      } else {
        td.className = "empty";
        td.textContent = "—";
      }
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  const trS = document.createElement("tr");
  const headS = document.createElement("td");
  headS.className = "row-head";
  headS.textContent = "库房(0 lx)";
  trS.appendChild(headS);
  for (let t = 0; t < T; t++) {
    const td = document.createElement("td");
    (storageCell[t] || []).forEach((id) => td.appendChild(chip(byId[id].name, colorFor(id, arts))));
    if (!(storageCell[t] || []).length) { td.className = "empty"; td.textContent = "—"; }
    trS.appendChild(td);
  }
  table.appendChild(trS);
  wrap.appendChild(table);
  area.appendChild(wrap);

  // ---- 逐件剂量与余额 ----
  const h3b = document.createElement("h3");
  h3b.textContent = "逐件剂量与余额";
  h3b.style.fontSize = "15px";
  h3b.style.marginTop = "16px";
  area.appendChild(h3b);

  const wrap2 = document.createElement("div");
  wrap2.className = "table-wrap";
  const t2 = document.createElement("table");
  t2.innerHTML =
    "<thead><tr><th>藏品</th><th>展出小时</th><th>优先级加权小时</th><th>已用剂量 (lx·h)</th>" +
    "<th>预算 (lx·h)</th><th>余额 (lx·h)</th><th>剂量占比</th></tr></thead>";
  const tb = document.createElement("tbody");
  arts.forEach((a) => {
    const dose = res.doses[String(a.id)] || 0;
    const hours = res.hours[String(a.id)] || 0;
    const balance = a.budget - dose;
    const pct = a.budget > 0 ? Math.min(100, (dose / a.budget) * 100) : (dose > 0 ? 100 : 0);
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.appendChild(chip(a.name, colorFor(a.id, arts)));
    const bar = document.createElement("div");
    bar.className = "dose-bar" + (balance < 0 ? " over" : "");
    const fill = document.createElement("div");
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    const tdBar = document.createElement("td");
    tdBar.appendChild(bar);
    const tdPct = document.createElement("span");
    tdPct.textContent = ` ${pct.toFixed(1)}%`;
    tdPct.style.fontSize = "12px";
    tdPct.style.color = "var(--muted)";
    tdBar.appendChild(tdPct);
    [tdName,
     td(`${hours} h`),
     td(fmt(a.priority * hours)),
     td(fmt(dose)),
     td(fmt(a.budget)),
     td(fmt(balance)),
     tdBar,
    ].forEach((c) => tr.appendChild(c));
    tb.appendChild(tr);
  });
  t2.appendChild(tb);
  wrap2.appendChild(t2);
  area.appendChild(wrap2);
}

async function solve() {
  const btn = $("#solve-btn");
  const msg = $("#solve-msg");
  btn.disabled = true;
  msg.textContent = "求解中…(限时 10 秒)";
  try {
    const sched = await api("/api/solve", "POST");
    renderResult(sched);
    msg.textContent = "";
    state.schedules = await api("/api/schedules");
    renderSchedules();
  } catch (e) {
    msg.textContent = "求解失败:" + e.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 历史排班 ---------------- */

function renderSchedules() {
  const box = $("#schedules-list");
  box.innerHTML = "";
  if (!state.schedules.length) {
    box.innerHTML = '<p class="hint">暂无历史排班。</p>';
    return;
  }
  state.schedules.forEach((s) => {
    const item = document.createElement("div");
    item.className = "sched-item";
    const title = document.createElement("span");
    title.innerHTML = `<b>#${s.id}</b> <span class="meta">${s.created_at}</span>`;
    const meta = document.createElement("span");
    meta.className = "meta";
    const parts = [];
    if (s.weighted_hours !== null && s.weighted_hours !== undefined) parts.push(`加权小时 ${fmt(s.weighted_hours)}`);
    if (s.transitions !== null && s.transitions !== undefined) parts.push(`出入库 ${fmt(s.transitions)}`);
    meta.textContent = parts.join(" · ");
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    const viewBtn = document.createElement("button");
    viewBtn.className = "small";
    viewBtn.textContent = "查看";
    viewBtn.addEventListener("click", async () => {
      const sched = await api(`/api/schedules/${s.id}`);
      renderResult(sched);
      $("#solve-card").scrollIntoView({ behavior: "smooth" });
    });
    const delBtn = document.createElement("button");
    delBtn.className = "small danger";
    delBtn.textContent = "删除";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`删除排班 #${s.id}?`)) return;
      await api(`/api/schedules/${s.id}`, "DELETE");
      if (currentSchedule && currentSchedule.id === s.id) renderResult(null);
      await refresh();
    });
    item.append(title, statusBadge(s.status), meta, spacer, viewBtn, delBtn);
    box.appendChild(item);
  });
}

/* ---------------- 实测核查 ---------------- */

let auditScheduleId = null;          // 当前选中要核查的排班
let auditScheduleCache = {};         // id -> 完整排班(含 snapshot)
let pendingRecords = [];             // 待提交的实测记录
let currentAudit = null;             // 当前展示的核查报告

function locLabel(loc) {
  return loc === "storage" ? "库房" : `展位${loc + 1}`;
}

function fmtDose(n) {
  if (n === null || n === undefined) return "—";
  return Number.isInteger(n) ? fmt(n) : Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function td(text) {
  const c = document.createElement("td");
  c.textContent = text;
  return c;
}

async function loadAuditSchedule(id) {
  if (!auditScheduleCache[id]) auditScheduleCache[id] = await api(`/api/schedules/${id}`);
  return auditScheduleCache[id];
}

async function renderAuditForm() {
  const box = $("#audit-form");
  box.innerHTML = "";
  const wrap = $("#audit-pending-wrap");
  wrap.innerHTML = "";
  if (!state.schedules.length) {
    box.innerHTML = '<p class="hint">暂无排班,请先求解并保存一份 optimal / feasible 排班。</p>';
    return;
  }
  const auditable = state.schedules.filter((s) => s.status === "optimal" || s.status === "feasible");
  if (!auditable.length) {
    box.innerHTML = '<p class="hint">现有排班均为无解/超时状态,没有可核查的 assignment,请先求得一份 optimal / feasible 排班。</p>';
    return;
  }
  const auditableIds = new Set(auditable.map((s) => s.id));
  if (auditScheduleId === null || !auditableIds.has(auditScheduleId)) {
    const cur = currentSchedule && currentSchedule.id;
    auditScheduleId = cur && auditableIds.has(cur) ? cur : auditable[0].id;
  }

  // 排班选择
  const selField = document.createElement("div");
  selField.className = "field";
  selField.innerHTML = "<label>核查排班(按其保存快照)</label>";
  const schedSel = document.createElement("select");
  state.schedules.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.id;
    const auditable = s.status === "optimal" || s.status === "feasible";
    opt.textContent = `#${s.id} ${STATUS_TEXT[s.status] || s.status}${auditable ? "" : "(不可核查)"}`;
    if (!auditable) opt.disabled = true;
    schedSel.appendChild(opt);
  });
  schedSel.value = auditScheduleId;
  selField.appendChild(schedSel);

  const sched = await loadAuditSchedule(auditScheduleId);
  const snap = sched.snapshot;
  const arts = snap.artifacts;

  // 藏品选择
  const artField = document.createElement("div");
  artField.className = "field";
  artField.innerHTML = "<label>藏品</label>";
  const artSel = document.createElement("select");
  arts.forEach((a) => {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.name;
    artSel.appendChild(opt);
  });
  artField.appendChild(artSel);

  // 槽位选择
  const slotField = document.createElement("div");
  slotField.className = "field";
  slotField.innerHTML = `<label>槽位(1~${snap.num_slots},1 小时/槽)</label>`;
  const slotSel = document.createElement("select");
  for (let t = 0; t < snap.num_slots; t++) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = `第 ${t + 1} 槽`;
    slotSel.appendChild(opt);
  }
  slotField.appendChild(slotSel);

  // 位置选择
  const locField = document.createElement("div");
  locField.className = "field";
  locField.innerHTML = "<label>实测位置</label>";
  const locSel = document.createElement("select");
  const locStorage = document.createElement("option");
  locStorage.value = "storage";
  locStorage.textContent = "库房";
  locSel.appendChild(locStorage);
  snap.booths.forEach((lx, b) => {
    const opt = document.createElement("option");
    opt.value = b;
    opt.textContent = `展位${b + 1}(${fmt(lx)} lx)`;
    locSel.appendChild(opt);
  });
  locField.appendChild(locSel);

  // 实测照度
  const luxField = document.createElement("div");
  luxField.className = "field";
  luxField.innerHTML = '<label>实测照度 (lx,非负;库房为 0)</label>';
  const luxInput = document.createElement("input");
  luxInput.type = "number";
  luxInput.className = "num";
  luxInput.min = 0;
  luxInput.value = 0;
  luxInput.disabled = true; // 默认库房:强制 0
  luxField.appendChild(luxInput);

  locSel.addEventListener("change", () => {
    if (locSel.value === "storage") {
      luxInput.value = 0;
      luxInput.disabled = true;
    } else {
      luxInput.disabled = false;
      const b = Number(locSel.value);
      luxInput.value = snap.booths[b];
    }
  });

  const addBtn = document.createElement("button");
  addBtn.className = "primary";
  addBtn.textContent = "加入记录";

  addBtn.addEventListener("click", () => {
    const aid = Number(artSel.value);
    const slot = Number(slotSel.value);
    const isStorage = locSel.value === "storage";
    const location = isStorage ? "storage" : Number(locSel.value);
    const lux = isStorage ? 0 : Number(luxInput.value);
    if (!isStorage && (!Number.isFinite(lux) || lux < 0)) {
      alert("展位实测照度须为非负有限数字");
      return;
    }
    if (pendingRecords.some((r) => r.artifact_id === aid && r.slot === slot)) {
      alert(`「${arts.find((a) => a.id === aid).name}」第 ${slot + 1} 槽已记录,请勿重复提交`);
      return;
    }
    pendingRecords.push({ artifact_id: aid, slot, location, lux: isStorage ? 0 : lux });
    renderPending();
  });

  schedSel.addEventListener("change", async () => {
    auditScheduleId = Number(schedSel.value);
    pendingRecords = []; // 待提交记录只对当前快照有效
    await renderAuditForm();
  });

  box.append(selField, artField, slotField, locField, luxField, addBtn);
  renderPending();
}

function renderPending() {
  const wrap = $("#audit-pending-wrap");
  wrap.innerHTML = "";
  if (!pendingRecords.length) return;
  const sched = auditScheduleCache[auditScheduleId];
  const nameOf = (id) => {
    const a = sched.snapshot.artifacts.find((x) => x.id === id);
    return a ? a.name : `#${id}`;
  };
  const table = document.createElement("table");
  table.innerHTML =
    "<thead><tr><th>藏品</th><th>槽位</th><th>实测位置</th><th>照度 (lx)</th><th>操作</th></tr></thead>";
  const tb = document.createElement("tbody");
  pendingRecords
    .slice()
    .sort((a, b) => a.artifact_id - b.artifact_id || a.slot - b.slot)
    .forEach((r) => {
      const tr = document.createElement("tr");
      const del = document.createElement("button");
      del.className = "small danger";
      del.textContent = "移除";
      del.addEventListener("click", () => {
        pendingRecords = pendingRecords.filter(
          (x) => !(x.artifact_id === r.artifact_id && x.slot === r.slot)
        );
        renderPending();
      });
      const opTd = document.createElement("td");
      opTd.appendChild(del);
      [nameOf(r.artifact_id), `第 ${r.slot + 1} 槽`, locLabel(r.location), fmtDose(r.lux)]
        .forEach((v) => {
          const td = document.createElement("td");
          td.textContent = v;
          tr.appendChild(td);
        });
      tr.appendChild(opTd);
      tb.appendChild(tr);
    });
  table.appendChild(tb);
  wrap.appendChild(table);
}

async function submitAudit() {
  const btn = $("#audit-submit");
  const msg = $("#audit-msg");
  if (!pendingRecords.length) {
    alert("请先加入至少一条实测记录");
    return;
  }
  btn.disabled = true;
  msg.textContent = "核查中…";
  try {
    const data = await api(`/api/schedules/${auditScheduleId}/audit`, "POST", {
      records: pendingRecords,
    });
    pendingRecords = [];
    renderPending();
    renderAuditReport(data);
    msg.textContent = "";
  } catch (e) {
    msg.textContent = "核查失败:" + e.message;
  } finally {
    btn.disabled = false;
  }
}

function renderAuditReport(data) {
  currentAudit = data;
  const area = $("#audit-result");
  area.innerHTML = "";
  const rep = data.report;

  const banner = document.createElement("div");
  banner.className = "result-banner";
  const idTag = document.createElement("span");
  idTag.className = "badge optimal";
  idTag.textContent = `audit #${data.audit_id}`;
  banner.appendChild(idTag);

  const inc = document.createElement("span");
  inc.className = `badge ${rep.incomplete ? "feasible" : "optimal"}`;
  inc.textContent = rep.incomplete ? "不完整:存在缺测(真实余额未知)" : "完整:全部槽位已实测";
  banner.appendChild(inc);

  if (rep.over_budget) {
    const over = document.createElement("span");
    over.className = "badge infeasible";
    over.textContent = "⚠ 超预算告警";
    banner.appendChild(over);
  }

  const meta = document.createElement("div");
  meta.className = "result-meta";
  meta.innerHTML = `<span>排班 <b>#${data.schedule_id}</b></span><span>${data.created_at}</span>`;
  banner.appendChild(meta);
  area.appendChild(banner);

  // ---- 逐件剂量 ----
  const h3d = document.createElement("h3");
  h3d.textContent = "剂量与余额上界";
  h3d.style.fontSize = "15px";
  area.appendChild(h3d);

  const doseWrap = document.createElement("div");
  doseWrap.className = "table-wrap";
  const tDose = document.createElement("table");
  tDose.innerHTML =
    "<thead><tr><th>藏品</th><th>已测/总槽数</th><th>已测剂量 (lx·h)</th>" +
    "<th>预算 (lx·h)</th><th>余额上界=预算−已测</th><th>计划全量剂量 (参考)</th><th>状态</th></tr></thead>";
  const tbDose = document.createElement("tbody");
  rep.artifacts.forEach((a) => {
    const tr = document.createElement("tr");
    if (a.over_budget) tr.style.background = "#fbe9e7";

    const tdName = document.createElement("td");
    tdName.appendChild(chip(a.name, colorFor(a.artifact_id, rep.artifacts.map((x) => ({ id: x.artifact_id })))));

    const tdStatus = document.createElement("td");
    const flags = [];
    if (a.over_budget) {
      const b = document.createElement("span");
      b.className = "badge infeasible";
      b.textContent = "超预算";
      tdStatus.appendChild(b);
      flags.push(1);
    }
    if (a.missing_slots.length) {
      if (flags.length) tdStatus.appendChild(document.createTextNode(" "));
      const b = document.createElement("span");
      b.className = "badge unknown";
      b.textContent = `缺测 ${a.missing_slots.length} 槽`;
      tdStatus.appendChild(b);
    }
    if (!flags.length && !a.missing_slots.length) tdStatus.textContent = "正常";

    const tdBal = document.createElement("td");
    tdBal.textContent = fmtDose(a.balance_upper_bound);
    if (a.over_budget) tdBal.style.color = "var(--bad)";
    tdBal.style.fontWeight = "600";
    if (a.missing_slots.length) tdBal.title = "存在缺测,真实余额 ≤ 此上界(未知)";

    [tdName,
     td(`${a.measured_count}/${a.planned_location.length}`),
     td(fmtDose(a.measured_dose)),
     td(fmt(a.budget)),
     tdBal,
     td(fmtDose(a.planned_dose)),
     tdStatus,
    ].forEach((c) => tr.appendChild(c));
    tbDose.appendChild(tr);
  });
  tDose.appendChild(tbDose);
  doseWrap.appendChild(tDose);
  area.appendChild(doseWrap);

  // ---- 差异与告警 ----
  const h3f = document.createElement("h3");
  h3f.textContent = "差异与告警(计划外展位 / 跨展位未隔库 / 缺测)";
  h3f.style.fontSize = "15px";
  h3f.style.marginTop = "16px";
  area.appendChild(h3f);

  rep.artifacts.forEach((a) => {
    if (!a.deviations.length && !a.cross_booth.length && !a.missing_slots.length) return;
    const card = document.createElement("div");
    card.className = "audit-finding";
    const title = document.createElement("div");
    title.style.marginBottom = "6px";
    title.appendChild(chip(a.name, colorFor(a.artifact_id, rep.artifacts.map((x) => ({ id: x.artifact_id })))));
    card.appendChild(title);
    const ul = document.createElement("ul");
    ul.style.margin = "0";
    ul.style.paddingLeft = "20px";

    a.deviations.forEach((d) => {
      const li = document.createElement("li");
      li.innerHTML =
        `<b class="audit-warn">计划外展位</b>:第 ${d.slot + 1} 槽计划在 ${locLabel(d.planned_location)},` +
        `实测在 ${locLabel(d.actual_location)}(${fmtDose(d.lux)} lx)`;
      ul.appendChild(li);
    });
    a.cross_booth.forEach((x) => {
      const li = document.createElement("li");
      li.innerHTML =
        `<b class="audit-bad">跨展位未隔库</b>:第 ${x.slot + 1}→${x.slot + 2} 槽实测` +
        ` ${locLabel(x.from_location)} → ${locLabel(x.to_location)},中间无库房间隔`;
      ul.appendChild(li);
    });
    if (a.missing_slots.length) {
      const li = document.createElement("li");
      const slots = a.missing_slots.map((t) => t + 1).join(", ");
      li.innerHTML = `<b class="audit-unknown">缺测(未知,不补零)</b>:第 ${slots} 槽`;
      ul.appendChild(li);
    }
    card.appendChild(ul);
    area.appendChild(card);
  });
  if (!rep.artifacts.some((a) =>
    a.deviations.length || a.cross_booth.length || a.missing_slots.length)) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "全部槽位已实测,且与计划一致、无跨展位违规。";
    area.appendChild(p);
  }

  // ---- 计划 vs 实测 时间轴 ----
  const h3t = document.createElement("h3");
  h3t.textContent = "计划 vs 实测(逐槽)";
  h3t.style.fontSize = "15px";
  h3t.style.marginTop = "16px";
  area.appendChild(h3t);

  const wrapT = document.createElement("div");
  wrapT.className = "table-wrap";
  const tableT = document.createElement("table");
  tableT.className = "timeline";
  const T = rep.artifacts[0] ? rep.artifacts[0].planned_location.length : 0;
  const hr = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "row-head";
  corner.textContent = "藏品 \\ 槽";
  hr.appendChild(corner);
  for (let t = 0; t < T; t++) {
    const th = document.createElement("th");
    th.textContent = t + 1;
    hr.appendChild(th);
  }
  tableT.appendChild(hr);

  rep.artifacts.forEach((a) => {
    const measured = {};
    a.measured_slots.forEach((m) => { measured[m.slot] = m; });

    const trP = document.createElement("tr");
    const hp = document.createElement("td");
    hp.className = "row-head";
    hp.appendChild(chip(a.name, colorFor(a.artifact_id, rep.artifacts.map((x) => ({ id: x.artifact_id })))));
    hp.appendChild(document.createTextNode(" 计划"));
    trP.appendChild(hp);
    const trM = document.createElement("tr");
    const hm = document.createElement("td");
    hm.className = "row-head";
    hm.appendChild(chip(a.name, colorFor(a.artifact_id, rep.artifacts.map((x) => ({ id: x.artifact_id })))));
    hm.appendChild(document.createTextNode(" 实测"));
    trM.appendChild(hm);

    for (let t = 0; t < T; t++) {
      const tdP = document.createElement("td");
      tdP.textContent = locLabel(a.planned_location[t]);
      trP.appendChild(tdP);

      const tdM = document.createElement("td");
      const m = measured[t];
      if (!m) {
        tdM.className = "empty";
        tdM.textContent = "缺测";
        tdM.style.color = "var(--unknown)";
      } else {
        tdM.textContent = `${locLabel(m.location)}`;
        if (m.location !== m.planned_location) tdM.style.background = "#fde7e4";
      }
      trM.appendChild(tdM);
    }
    tableT.appendChild(trP);
    tableT.appendChild(trM);
  });
  wrapT.appendChild(tableT);
  area.appendChild(wrapT);
}

/* ---------------- 启动 ---------------- */

function renderAll() {
  renderSettings();
  renderArtifacts();
  renderLocks();
  renderSchedules();
  renderAuditForm();
}

async function refresh() {
  const data = await api("/api/state");
  state.settings = data.settings;
  state.artifacts = data.artifacts;
  state.locks = data.locks;
  state.schedules = data.schedules;
  state.limits = data.limits;
  renderAll();
}

document.addEventListener("DOMContentLoaded", async () => {
  $("#solve-btn").addEventListener("click", solve);
  $("#audit-submit").addEventListener("click", submitAudit);
  $("#audit-load-btn").addEventListener("click", async () => {
    const id = Number($("#audit-load-id").value);
    if (!Number.isInteger(id) || id <= 0) { alert("请输入有效的 audit_id"); return; }
    const msg = $("#audit-msg");
    msg.textContent = "读取中…";
    try {
      const data = await api(`/api/audits/${id}`);
      // 同步核查排班选择器到该报告所属排班
      auditScheduleId = data.schedule_id;
      if (state.schedules.some((s) => s.id === data.schedule_id)) {
        await loadAuditSchedule(data.schedule_id);
        await renderAuditForm();
      }
      renderAuditReport(data);
      msg.textContent = "";
    } catch (e) {
      msg.textContent = "读取失败:" + e.message;
    }
  });
  await refresh();
  // 刷新后自动展示最近一次保存的排班
  if (state.schedules.length) {
    const sched = await api(`/api/schedules/${state.schedules[0].id}`);
    renderResult(sched);
  }
});

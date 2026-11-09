import { add, getRecords, remove, subscribe, update } from "../store.js";
import { formatDate, localDateString } from "../utils/dates.js";
import { ensureDefaultLifeAreas } from "../utils/life-areas.js";
import { showToast } from "../utils/notifications.js";
import { requestCompletionDetails } from "../utils/completion-dialog.js";

const DAY_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const DAYS = 84;

let unsubscribe;
let eventController;
let records = { habits: [], objectives: [], lifeAreas: [] };
const expandedHabitDetails = new Set();

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function dateOffset(offset, from = new Date()) {
  const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
  return localDateString(date);
}

function selectedDateFilter() {
  const date = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("date") ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function normalizedHistory(habit) {
  const history = habit.history ?? {};
  if (Array.isArray(history)) return Object.fromEntries(history.map((date) => [date, true]));
  return { ...history };
}

function isCompleted(habit, date) {
  return Boolean(normalizedHistory(habit)[date]);
}

function habitMode(habit) {
  if (habit.mode === "items" && (habit.items ?? []).length) return "items";
  if (habit.mode === "count") return "count";
  return "check";
}

function requiresAllItems(habit) {
  if (habit.requireAllItems !== undefined) return Boolean(habit.requireAllItems);
  return /صلاة|الصلوات/.test(habit.title ?? "");
}

export function dayProgress(habit, date) {
  const mode = habitMode(habit);
  if (mode === "count") {
    const target = Math.max(1, Number(habit.targetPerDay) || 1);
    const value = Number(habit.progress?.[date]) || 0;
    return { mode, done: value, total: target, complete: value >= target, percent: Math.min(100, Math.round((value / target) * 100)) };
  }
  if (mode === "items") {
    const logged = new Set(habit.itemLog?.[date] ?? []);
    const items = habit.items;
    const requiredPrayerItems = /صلاة|الصلوات/.test(habit.title ?? "")
      ? items.filter((item) => item.category === "فرض")
      : [];
    if (requiredPrayerItems.length) {
      const done = requiredPrayerItems.filter((item) => logged.has(item.id)).length;
      return {
        mode, logged, done, loggedCount: logged.size, total: requiredPrayerItems.length,
        target: requiredPrayerItems.length, itemsTotal: items.length,
        complete: done >= requiredPrayerItems.length,
        amountDetails: [],
        percent: Math.min(100, Math.round((done / requiredPrayerItems.length) * 100)),
      };
    }
    const done = items.filter((item) => logged.has(item.id));
    const target = requiresAllItems(habit)
      ? items.length
      : Math.max(1, Number(habit.targetItemsPerDay) || items.length);
    const quantities = (list) => {
      const totals = new Map();
      for (const item of list) {
        if (!Number(item.amount)) continue;
        const unit = item.unit || habit.unit || "وحدة";
        totals.set(unit, (totals.get(unit) ?? 0) + Number(item.amount));
      }
      return totals;
    };
    const totalByUnit = quantities(items);
    const doneByUnit = quantities(done);
    const amountDetails = [...totalByUnit].map(([unit, total]) =>
      `${doneByUnit.get(unit) ?? 0}/${total} ${escapeHtml(unit)}`);
    return {
      mode, logged, done: Math.min(done.length, target), loggedCount: done.length, total: target, target, itemsTotal: items.length,
      complete: items.length > 0 && done.length >= target,
      amountDetails,
      percent: Math.min(100, Math.round((done.length / target) * 100)),
    };
  }
  const complete = isCompleted(habit, date);
  return { mode, done: complete ? 1 : 0, total: 1, complete, percent: complete ? 100 : 0 };
}

function withProgress(habit, date, change) {
  const next = { ...habit, history: normalizedHistory(habit), updatedAt: new Date().toISOString() };
  change(next);
  if (dayProgress(next, date).complete) next.history[date] = true;
  else {
    delete next.history[date];
    if (next.completionLog) {
      next.completionLog = { ...next.completionLog };
      delete next.completionLog[date];
    }
  }
  return next;
}

export function setCompletionDetails(habit, date, details) {
  return {
    ...habit,
    completionLog: { ...(habit.completionLog ?? {}), [date]: details },
    updatedAt: new Date().toISOString(),
  };
}

export function setItemsLogged(habit, date, itemIds) {
  const logged = [...new Set(itemIds)];
  return withProgress(habit, date, (next) => {
    applyLoggedItems(next, habit, date, logged);
  });
}

function applyLoggedItems(next, habit, date, itemIds) {
  const logged = [...new Set(itemIds)];
  const previous = new Set(habit.itemLog?.[date] ?? []);
  const allTimestamps = { ...(habit.itemLogTimes ?? {}) };
  const timestamps = { ...(allTimestamps[date] ?? {}) };
  const now = date === localDateString() ? new Date().toISOString() : "";
  for (const id of logged) {
    if (!previous.has(id)) {
      if (now) timestamps[id] = now;
      else delete timestamps[id];
    }
  }
  for (const id of Object.keys(timestamps)) {
    if (!logged.includes(id)) delete timestamps[id];
  }
  next.itemLog = { ...(habit.itemLog ?? {}), [date]: logged };
  allTimestamps[date] = timestamps;
  next.itemLogTimes = allTimestamps;
}

export function setDayComplete(habit, date, complete) {
  return withProgress(habit, date, (next) => {
    const mode = habitMode(habit);
    if (mode === "count") {
      next.progress = { ...(habit.progress ?? {}), [date]: complete ? Math.max(1, Number(habit.targetPerDay) || 1) : 0 };
    } else if (mode === "items") {
      const requiredPrayerItems = /صلاة|الصلوات/.test(habit.title ?? "")
        ? habit.items.filter((item) => item.category === "فرض")
        : [];
      const targetItems = requiredPrayerItems.length
        ? requiredPrayerItems
        : habit.items.slice(0, requiresAllItems(habit)
          ? habit.items.length
          : Math.max(1, Number(habit.targetItemsPerDay) || habit.items.length));
      applyLoggedItems(next, habit, date, complete ? targetItems.map((item) => item.id) : []);
    } else if (complete) next.history[date] = true;
    else delete next.history[date];
  });
}

function parseItems(text, unit, existing = []) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split("|").map((part) => part.trim());
    const [category, name, rawAmount, itemUnit] = parts.length >= 3
      ? parts
      : ["عام", parts[0], parts[1], unit];
    const old = existing.find((item) => item.name === name);
    return {
      id: old?.id ?? crypto.randomUUID(),
      category: ["فرض", "سنة", "نافلة", "عام"].includes(category) ? category : "عام",
      name,
      amount: rawAmount ? Number(rawAmount) || 0 : 0,
      unit: itemUnit || unit,
    };
  });
}

const PRAYER_PRESET = [
  "فرض | صلاة الفجر | 2 | ركعة",
  "فرض | صلاة الظهر | 4 | ركعة",
  "فرض | صلاة العصر | 4 | ركعة",
  "فرض | صلاة المغرب | 3 | ركعة",
  "فرض | صلاة العشاء | 4 | ركعة",
  "سنة | سنة الفجر | 2 | ركعة",
  "سنة | سنة الظهر القبلية | 4 | ركعة",
  "سنة | سنة الظهر البعدية | 2 | ركعة",
  "سنة | سنة العصر القبلية | 4 | ركعة",
  "سنة | سنة المغرب البعدية | 2 | ركعة",
  "سنة | سنة العشاء البعدية | 2 | ركعة",
  "نافلة | صلاة الضحى | 2 | ركعة",
  "نافلة | قيام الليل | 2 | ركعة",
  "نافلة | صلاة الشفع | 2 | ركعة",
  "نافلة | الوتر | 1 | ركعة",
].join("\n");

export async function ensureDailyRitualHabits() {
  const habits = await getRecords("habits");
  const defaults = [
    {
      id: "mihwar-default-prayer-habit",
      title: "الصلاة بتفاصيلها",
      mode: "items",
      targetItemsPerDay: 5,
      items: parseItems(PRAYER_PRESET, "ركعة"),
      unit: "ركعة",
    },
    { id: "mihwar-default-dhuha-habit", title: "صلاة الضحى", mode: "check" },
    { id: "mihwar-default-morning-adhkar-habit", title: "أذكار الصباح", mode: "check" },
    { id: "mihwar-default-evening-adhkar-habit", title: "أذكار المساء", mode: "check" },
  ];
  const matches = (habit, item) => !habit.archived && (item.title.includes("الصلاة")
    ? /صلاة|الصلوات/.test(habit.title ?? "") && habit.mode === "items"
    : habit.title === item.title);
  for (const item of defaults) {
    if (habits.some((habit) => matches(habit, item))) continue;
    const now = new Date().toISOString();
    const habit = {
      id: habits.some((existing) => existing.id === item.id) ? crypto.randomUUID() : item.id,
      title: item.title,
      kind: "build",
      schedule: "daily",
      priority: 3,
      dailyTime: null,
      mode: item.mode,
      targetPerDay: 1,
      targetItemsPerDay: item.targetItemsPerDay ?? 1,
      requireAllItems: false,
      unit: item.unit ?? "",
      items: item.items ?? [],
      progress: {},
      itemLog: {},
      history: {},
      completionLog: {},
      focusSpentMin: 0,
      archived: false,
      order: habits.length,
      createdAt: now,
      updatedAt: now,
    };
    await add("habits", habit);
    habits.push(habit);
  }
}

function applyPrayerPreset(form) {
  form.elements.items.value = PRAYER_PRESET;
  form.elements.unit.value = "ركعة";
  form.elements.mode.value = "items";
  form.elements.requireAllItems.checked = false;
  form.elements.targetItemsPerDay.value = "5";
  if (!form.elements.title.value) form.elements.title.value = "الصلاة بتفاصيلها";
  form.elements.lifeAreaId.value = "mihwar-area-religion";
  syncModeFields(form);
}

function openPrayerPreset(app) {
  const form = app.querySelector("#habit-form");
  form.reset();
  form.elements.id.value = "";
  applyPrayerPreset(form);
  app.querySelector("#habit-dialog-title").textContent = "إضافة عادة الصلاة";
  app.querySelector("#habit-dialog").showModal();
}

function habitItemsMarkup(items, logged) {
  const categories = ["فرض", "سنة", "نافلة", "عام"];
  return categories.map((category) => {
    const grouped = items.filter((item) => (item.category ?? "عام") === category);
    if (!grouped.length) return "";
    return `<section class="habit-item-group">
      <h4><span>${category}</span><small>${grouped.filter((item) => logged.has(item.id)).length}/${grouped.length}</small></h4>
      <div class="habit-item-group-list">${grouped.map((item) => `<button type="button" class="habit-item${logged.has(item.id) ? " is-done" : ""}" data-action="toggle-item" data-item-id="${escapeHtml(item.id)}" aria-pressed="${logged.has(item.id)}">
        <span class="habit-item-state" aria-hidden="true">${logged.has(item.id) ? "✓" : ""}</span>
        <span class="habit-item-name">${escapeHtml(item.name)}</span>
        ${item.amount ? `<span class="habit-item-amount">${item.amount} ${escapeHtml(item.unit || "")}</span>` : ""}
      </button>`).join("")}</div>
    </section>`;
  }).join("");
}

function scheduleDays(habit) {
  const schedule = habit.schedule;
  if (schedule === "daily" || !schedule) return [0, 1, 2, 3, 4, 5, 6];
  if (schedule === "weekdays") return [1, 2, 3, 4, 5];
  if (schedule === "weekends") return [0, 6];
  if (Array.isArray(schedule)) return schedule.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return [0, 1, 2, 3, 4, 5, 6];
}

function isScheduled(habit, date) {
  const weekday = new Date(`${date}T12:00:00`).getDay();
  return scheduleDays(habit).includes(weekday);
}

function streaks(habit) {
  const completed = Object.keys(normalizedHistory(habit)).filter((date) => isCompleted(habit, date)).sort();
  const set = new Set(completed);
  let current = 0;
  let cursor = new Date(`${localDateString()}T12:00:00`);
  if (!set.has(localDateString())) cursor.setDate(cursor.getDate() - 1);
  while (set.has(localDateString(cursor))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  let longest = 0;
  let run = 0;
  let previous;
  for (const date of completed) {
    const currentDate = new Date(`${date}T12:00:00`);
    const expected = previous ? new Date(`${previous}T12:00:00`) : null;
    if (expected) expected.setDate(expected.getDate() + 1);
    run = expected && localDateString(expected) === date ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = localDateString(currentDate);
  }
  return { current, longest };
}

function consistency(habit) {
  let scheduled = 0;
  let completed = 0;
  for (let offset = 0; offset < DAYS; offset += 1) {
    const date = dateOffset(-offset);
    if (!isScheduled(habit, date)) continue;
    scheduled += 1;
    if (isCompleted(habit, date)) completed += 1;
  }
  return { completed, scheduled, percent: scheduled ? Math.round((completed / scheduled) * 100) : 0 };
}

function heatmap(habit) {
  return Array.from({ length: DAYS }, (_item, index) => {
    const date = dateOffset(-(DAYS - index - 1));
    const completed = isCompleted(habit, date);
    const scheduled = isScheduled(habit, date);
    const intensity = completed ? "done" : scheduled ? "missed" : "off";
    return `<button class="habit-heat-cell heat-${intensity}" type="button" title="${date}${completed ? " · أُنجزت" : scheduled ? " · يوم مجدول" : ""}" aria-label="${date}${completed ? " أُنجزت" : scheduled ? " لم تُنجز" : " غير مجدولة"}"></button>`;
  }).join("");
}

function renderHabit(habit, date) {
  const progress = dayProgress(habit, date);
  const checked = progress.complete;
  const unit = escapeHtml(habit.unit ?? "");
  const { current, longest } = streaks(habit);
  const stats = consistency(habit);
  const linkedObjective = records.objectives.find((objective) => objective.id === habit.objectiveId);
  const lifeArea = records.lifeAreas.find((area) => area.id === (habit.lifeAreaId ?? linkedObjective?.lifeAreaId));
  return `<article class="habit-card" data-habit-id="${escapeHtml(habit.id)}" data-date="${escapeHtml(date)}">
    <span class="habit-color-dot" aria-hidden="true"></span>
    <div class="habit-card-heading">
      <button class="habit-today-toggle${checked ? " is-checked" : ""}" type="button" data-action="toggle-today" aria-pressed="${checked}" aria-label="${checked ? "إلغاء تحقق" : "تحقق"} ${escapeHtml(habit.title)}">
        <span aria-hidden="true">${checked ? "✓" : "+"}</span>
      </button>
      <div class="habit-title-group"><h3>${escapeHtml(habit.title)}</h3><span>${progress.mode === "items" ? `${progress.done}/${progress.target} بند · ${progress.percent}%` : progress.mode === "count" ? `${progress.done}/${progress.total} ${unit}` : checked ? "مكتملة اليوم" : "لم تكتمل اليوم"}${lifeArea ? ` · ${escapeHtml(lifeArea.name)}` : ""}</span></div>
      <button class="icon-button" type="button" data-action="edit" aria-label="تعديل ${escapeHtml(habit.title)}">✎</button>
      <button class="icon-button" type="button" data-action="archive" aria-label="أرشفة ${escapeHtml(habit.title)}">×</button>
    </div>
    <details class="habit-details" data-habit-details="${escapeHtml(habit.id)}"${expandedHabitDetails.has(habit.id) ? " open" : ""}>
      <summary><span>سجل العادة وتفاصيلها</span></summary>
      <div class="habit-details-content">
    <div class="habit-focus-strip">
      <a class="habit-focus-link" href="#/focus?habit=${encodeURIComponent(habit.id)}">◉ ابدأ التركيز${habit.focusDurationMin ? ` · ${Number(habit.focusDurationMin)} د` : ""}</a>
      <span>وقت تركيز مسجل: ${Number(habit.focusSpentMin) || 0} د</span>
    </div>
    ${progress.mode === "count" ? `
    <div class="habit-counter">
      <button class="icon-button" type="button" data-action="count-dec" aria-label="إنقاص">−</button>
      <strong>${progress.done} / ${progress.total} ${unit}</strong>
      <button class="icon-button" type="button" data-action="count-inc" aria-label="زيادة">+</button>
    </div>
    <div class="subtask-progress"><span style="width:${progress.percent}%"></span></div>` : ""}
    ${progress.mode === "items" ? `
    <div class="habit-items${requiresAllItems(habit) ? " requires-all-items" : ""}">
      <div class="habit-items-heading"><div><strong>تفاصيل اليوم</strong><span>${requiresAllItems(habit) ? "أكمل كل البنود لتسجيل العادة" : "اختر البنود التي أنجزتها"}</span></div></div>
      ${habitItemsMarkup(habit.items, progress.logged)}
    </div>
    <div class="subtask-progress"><span style="width:${progress.percent}%"></span></div>` : ""}
    <div class="habit-metrics">
      <div><strong>${current}</strong><span>السلسلة الحالية</span></div>
      <div><strong>${longest}</strong><span>أطول سلسلة</span></div>
      <div><strong>${stats.percent}%</strong><span>الثبات · ${stats.completed}/${stats.scheduled} يوماً</span></div>
    </div>
    <div class="habit-heatmap-wrap">
      <div class="habit-heatmap-label"><span>آخر 12 أسبوعاً</span><span>${DAY_NAMES[0]} → ${DAY_NAMES[6]}</span></div>
      <div class="habit-heatmap" role="img" aria-label="خريطة إنجاز ${escapeHtml(habit.title)} لآخر 12 أسبوعاً">${heatmap(habit)}</div>
      <div class="habit-heatmap-legend"><span>غير مجدول</span><i class="heat-off"></i><span>مجدول</span><i class="heat-missed"></i><span>منجز</span><i class="heat-done"></i></div>
    </div>
      </div>
    </details>
  </article>`;
}

function render() {
  const app = document.querySelector("#app");
  if (!app) return;
  const date = selectedDateFilter();
  const habits = records.habits.filter((habit) => !habit.archived && (!date || isScheduled(habit, date)))
    .sort((a, b) => (Number(a.priority ?? 3) - Number(b.priority ?? 3)) || (a.order ?? 0) - (b.order ?? 0));
  app.innerHTML = `
    <section class="habits-page" aria-label="متابعة العادات">
      <header class="habits-heading">
        <div><p class="goals-kicker">${date ? `يوم ${escapeHtml(formatDate(date))}` : "مساحة الإنجاز"}</p><h2>${date ? "عادات اليوم" : "عاداتك"}</h2><p class="goals-subtitle">${habits.length} عادة · سجّل إنجازك بخطوة واحدة <span class="swipe-delete-hint">· اسحب البطاقة للحذف</span></p></div>
        <button class="habits-heading-add" type="button" data-action="new-habit" aria-label="إضافة عادة"><span aria-hidden="true">＋</span></button>
      </header>
      ${date ? `<a class="day-filter-back-link" href="#/today?date=${encodeURIComponent(date)}">↗ العودة إلى خارطة اليوم</a>` : ""}
      ${habits.length ? `<div class="habits-list">${habits.map((habit) => renderHabit(habit, date || localDateString())).join("")}</div>` : `<div class="goals-empty">${date ? "لا توجد عادات مجدولة لهذا اليوم." : "ابدأ بعادة صغيرة تريد بناءها. ويمكنك ربطها بهدف سنوي."}</div>`}
      <p class="habits-status" role="status" aria-live="polite"></p>
      <dialog class="goal-dialog" id="habit-dialog">
        <form id="habit-form">
          <div class="dialog-heading"><h2 id="habit-dialog-title">إضافة عادة</h2><button class="icon-button" type="button" data-action="close">×</button></div>
          <input type="hidden" name="id">
          <label>اسم العادة<input name="title" required maxlength="120"></label>
          <div class="goal-dialog-fields">
            <label>نوع العادة<select name="kind"><option value="build">بناء عادة</option><option value="quit">تقليل عادة</option></select></label>
            <label>الجدول<select name="schedule"><option value="daily">كل يوم</option><option value="weekdays">أيام العمل</option><option value="weekends">نهاية الأسبوع</option></select></label>
            <label>الأولوية<select name="priority"><option value="0">عاجلة ومهمة</option><option value="1">مهمة</option><option value="2">عاجلة</option><option value="3" selected>عادية</option></select></label>
            <label>وقتها المعتاد<input name="dailyTime" type="time"><small>يظهر هذا الوقت على خريطة يومك.</small></label>
            <label>طريقة التتبع<select name="mode"><option value="check">تأشير (تمت/لم تتم)</option><option value="count">عدّاد بهدف يومي</option><option value="items">بنود (مثل الصلوات)</option></select></label>
            <label data-mode-field="count">الهدف اليومي (العدد)<input name="targetPerDay" type="number" min="1" max="10000" value="1"></label>
            <label>مدة التركيز المستهدفة بالدقائق<input name="focusDurationMin" type="number" min="1" max="180" step="1" placeholder="المدة الافتراضية"></label>
            <label data-mode-field="items">هدف الإنجاز اليومي (عدد البنود)<input name="targetItemsPerDay" type="number" min="1" max="100" value="1"><small>تُحسب العادة منجزة عند بلوغ هذا العدد.</small></label>
            <label data-mode-field="count items">الوحدة (مثل: صفحة، ركعة، كوب)<input name="unit" maxlength="30"></label>
            <label class="habit-require-all-label" data-mode-field="items"><input name="requireAllItems" type="checkbox"><span><strong>لا تكتمل إلا بإكمال كل البنود</strong><small>مناسب للصلاة أو لأي عادة تتطلب إتمام جميع تفاصيلها.</small></span></label>
            <label>المجال<select name="lifeAreaId"><option value="">من الهدف أو دون مجال</option>${records.lifeAreas.filter((area) => !area.archived).map((area) => `<option value="${escapeHtml(area.id)}">${escapeHtml(area.name)}</option>`).join("")}</select></label>
            <label>الهدف المرتبط<select name="objectiveId"><option value="">بلا هدف</option>${records.objectives.filter((objective) => objective.status !== "archived").map((objective) => `<option value="${escapeHtml(objective.id)}">${escapeHtml(objective.title)}</option>`).join("")}</select></label>
          </div>
          <label data-mode-field="items">بنود العادة، سطر لكل بند بصيغة: النوع | الاسم | الكمية | الوحدة
            <small>النوع: فرض أو سنة أو نافلة أو عام. مثال: سنة | سنة الفجر | 2 | ركعة</small>
            <textarea name="items" rows="7" placeholder="فرض | الفجر | 2 | ركعة&#10;سنة | سنة الفجر | 2 | ركعة&#10;نافلة | الضحى | 4 | ركعة"></textarea></label>
          <button class="button button-secondary" type="button" data-action="prayer-preset" data-mode-field="items">قالب الصلاة (فروض وسنن ونوافل)</button>
          <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close">إلغاء</button><button class="button button-primary" type="submit">حفظ العادة</button></div>
        </form>
      </dialog>
    </section>`;
  bindEvents(app);
}

function setStatus(message, isError = false) {
  showToast(message, { isError });
  const status = document.querySelector(".habits-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = isError ? "error" : "success";
}

function syncModeFields(form) {
  const mode = form.elements.mode.value;
  form.querySelectorAll("[data-mode-field]").forEach((field) => {
    field.hidden = !field.dataset.modeField.split(" ").includes(mode);
  });
  const target = form.elements.targetItemsPerDay;
  target.disabled = mode === "items" && form.elements.requireAllItems.checked;
}

function bindEvents(app) {
  eventController?.abort();
  eventController = new AbortController();
  const { signal } = eventController;
  let swipeState = null;
  let suppressClickUntil = 0;
  app.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" || event.target.closest("a, input, label, summary, button, textarea, select")) return;
    const card = event.target.closest(".habit-card[data-habit-id]");
    if (!card) return;
    swipeState = { card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    card.classList.add("is-swipe-ready");
    card.setPointerCapture(event.pointerId);
  }, { signal });

  app.addEventListener("pointermove", (event) => {
    if (!swipeState || event.pointerId !== swipeState.pointerId) return;
    const deltaX = event.clientX - swipeState.startX;
    const deltaY = event.clientY - swipeState.startY;
    if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 10) {
      swipeState.card.classList.remove("is-swipe-ready", "is-swipe-delete");
      swipeState.card.style.transform = "";
      swipeState = null;
      return;
    }
    if (Math.abs(deltaX) < 8) return;
    swipeState.moved = true;
    const distance = Math.max(-150, Math.min(150, deltaX));
    swipeState.card.style.transform = `translateX(${distance}px)`;
    swipeState.card.classList.toggle("is-swipe-delete", Math.abs(distance) >= 90);
    event.preventDefault();
  }, { signal, passive: false });

  app.addEventListener("pointerup", async (event) => {
    if (!swipeState || event.pointerId !== swipeState.pointerId) return;
    const { card, moved } = swipeState;
    const shouldDelete = card.classList.contains("is-swipe-delete");
    const habit = records.habits.find((item) => item.id === card.dataset.habitId);
    swipeState = null;
    if (moved) suppressClickUntil = Date.now() + 700;
    card.classList.remove("is-swipe-ready", "is-swipe-delete");
    card.style.transform = "";
    if (!moved || !shouldDelete || !habit || !window.confirm(`حذف العادة «${habit.title}» نهائياً؟ سيُحذف سجل إنجازها أيضاً.`)) return;
    try {
      await remove("habits", habit.id);
      setStatus("حُذفت العادة وسجل إنجازها.");
    } catch (error) {
      console.error("تعذّر حذف العادة بالسحب:", error);
      setStatus(error.message, true);
    }
  }, { signal });

  app.addEventListener("pointercancel", (event) => {
    if (!swipeState || event.pointerId !== swipeState.pointerId) return;
    swipeState.card.classList.remove("is-swipe-ready", "is-swipe-delete");
    swipeState.card.style.transform = "";
    swipeState = null;
  }, { signal });

  app.addEventListener("click", (event) => {
    const summary = event.target.closest(".habit-details > summary");
    if (!summary) return;
    const details = summary.parentElement;
    const id = details.dataset.habitDetails;
    if (details.open) expandedHabitDetails.delete(id);
    else expandedHabitDetails.add(id);
  }, { capture: true, signal });
  const habitForm = app.querySelector("#habit-form");
  habitForm.elements.mode.addEventListener("change", () => syncModeFields(habitForm), { signal });
  habitForm.elements.requireAllItems.addEventListener("change", () => syncModeFields(habitForm), { signal });
  syncModeFields(habitForm);

  app.addEventListener("click", async (event) => {
    if (Date.now() < suppressClickUntil) return;
    const button = event.target.closest("[data-action]");
    const card = event.target.closest(".habit-card[data-habit-id]");
    if (!button && card && !event.target.closest("a, input, label, details, summary, button")) {
      const details = card.querySelector(":scope > .habit-details");
      if (details) details.open = !details.open;
      return;
    }
    if (!button) return;
    const action = button.dataset.action;
    const cardDate = button.closest("[data-habit-id]")?.dataset.date;
    const date = button.dataset.date && /^\d{4}-\d{2}-\d{2}$/.test(button.dataset.date)
      ? button.dataset.date
      : cardDate && /^\d{4}-\d{2}-\d{2}$/.test(cardDate) ? cardDate : localDateString();
    if (action === "new-habit") {
      app.querySelector("#habit-form").reset();
      app.querySelector("#habit-form").elements.id.value = "";
      syncModeFields(app.querySelector("#habit-form"));
      app.querySelector("#habit-dialog-title").textContent = "إضافة عادة";
      app.querySelector("#habit-dialog").showModal();
      return;
    }
    if (action === "prayer-preset") {
      applyPrayerPreset(app.querySelector("#habit-form"));
      return;
    }
    if (action === "close") {
      button.closest("dialog")?.close();
      return;
    }

    const habit = records.habits.find((item) => item.id === button.closest("[data-habit-id]")?.dataset.habitId);
    if (!habit) return;
    try {
      if (action === "toggle-today") {
        const nextComplete = !dayProgress(habit, date).complete;
        const details = nextComplete
          ? await requestCompletionDetails({ title: habit.title, date })
          : null;
        if (nextComplete && !details) return;
        let next = setDayComplete(habit, date, nextComplete);
        if (details) next = setCompletionDetails(next, date, details);
        await update("habits", next);
        setStatus(next.history[date] ? "تم تسجيل العادة لهذا اليوم." : "أُزيل تسجيل اليوم.");
      } else if (action === "count-inc" || action === "count-dec") {
        const wasComplete = dayProgress(habit, date).complete;
        const value = Math.max(0, (Number(habit.progress?.[date]) || 0) + (action === "count-inc" ? 1 : -1));
        let next = withProgress(habit, date, (updated) => { updated.progress = { ...(habit.progress ?? {}), [date]: value }; });
        if (!wasComplete && dayProgress(next, date).complete) {
          const details = await requestCompletionDetails({ title: habit.title, date });
          if (!details) return;
          next = setCompletionDetails(next, date, details);
        }
        await update("habits", next);
      } else if (action === "toggle-item") {
        const wasComplete = dayProgress(habit, date).complete;
        const id = button.dataset.itemId;
        const logged = new Set(habit.itemLog?.[date] ?? []);
        if (logged.has(id)) logged.delete(id);
        else logged.add(id);
        let next = setItemsLogged(habit, date, [...logged]);
        if (!wasComplete && dayProgress(next, date).complete) {
          const details = await requestCompletionDetails({ title: habit.title, date });
          if (!details) return;
          next = setCompletionDetails(next, date, details);
        }
        await update("habits", next);
        setStatus(`تقدّم ${habit.title}: ${dayProgress(next, date).done} من ${dayProgress(next, date).target} بند للهدف اليومي.`);
      } else if (action === "edit") {
        const form = app.querySelector("#habit-form");
        const linkedObjective = records.objectives.find((objective) => objective.id === habit.objectiveId);
        form.elements.id.value = habit.id;
        form.elements.title.value = habit.title;
        form.elements.kind.value = habit.kind ?? "build";
        form.elements.schedule.value = ["daily", "weekdays", "weekends"].includes(habit.schedule) ? habit.schedule : "daily";
        form.elements.priority.value = String(Number.isInteger(habit.priority) ? habit.priority : 3);
        form.elements.dailyTime.value = habit.dailyTime ?? "";
        form.elements.targetPerDay.value = habit.targetPerDay ?? 1;
        form.elements.focusDurationMin.value = habit.focusDurationMin ?? "";
        form.elements.targetItemsPerDay.value = habit.targetItemsPerDay ?? (habit.items?.length || 1);
        form.elements.mode.value = habitMode(habit);
        form.elements.unit.value = habit.unit ?? "";
        form.elements.requireAllItems.checked = requiresAllItems(habit);
        form.elements.items.value = (habit.items ?? []).map((item) =>
          `${item.category ?? "عام"} | ${item.name} | ${item.amount || ""} | ${item.unit ?? habit.unit ?? ""}`).join("\n");
        syncModeFields(form);
        form.elements.lifeAreaId.value = habit.lifeAreaId ?? linkedObjective?.lifeAreaId ?? "";
        form.elements.objectiveId.value = habit.objectiveId ?? "";
        app.querySelector("#habit-dialog-title").textContent = "تعديل العادة";
        app.querySelector("#habit-dialog").showModal();
      } else if (action === "archive") {
        if (!window.confirm(`أرشفة عادة «${habit.title}»؟ سيبقى سجلّها محفوظاً.`)) return;
        await update("habits", { ...habit, archived: true, updatedAt: new Date().toISOString() });
        setStatus("أُرشفت العادة.");
      }
    } catch (error) {
      console.error("تعذّر تحديث العادة:", error);
      setStatus(error.message, true);
    }
  }, { signal });

  app.addEventListener("click", async (event) => {
    const cell = event.target.closest(".habit-heat-cell");
    if (!cell) return;
    const card = cell.closest("[data-habit-id]");
    const habit = records.habits.find((item) => item.id === card?.dataset.habitId);
    const date = cell.title.split(" · ")[0];
    if (!habit || !date) return;
    try {
      const nextComplete = !isCompleted(habit, date);
      const details = nextComplete
        ? await requestCompletionDetails({ title: habit.title, date })
        : null;
      if (nextComplete && !details) return;
      let next = setDayComplete(habit, date, nextComplete);
      if (details) next = setCompletionDetails(next, date, details);
      const history = next.history;
      await update("habits", next);
      setStatus(history[date] ? `سُجّل إنجاز ${date}.` : `أُزيل إنجاز ${date}.`);
    } catch (error) {
      console.error("تعذّر تحديث سجل العادة:", error);
      setStatus(error.message, true);
    }
  }, { signal });

  app.addEventListener("submit", async (event) => {
    const form = event.target.closest("#habit-form");
    if (!form) return;
    event.preventDefault();
    const existing = records.habits.find((habit) => habit.id === form.elements.id.value);
    const now = new Date().toISOString();
    const habit = {
      ...(existing ?? {}),
      id: existing?.id ?? crypto.randomUUID(),
      title: form.elements.title.value.trim(),
      kind: form.elements.kind.value,
      schedule: form.elements.schedule.value,
      priority: Number(form.elements.priority.value),
      dailyTime: form.elements.dailyTime.value || null,
      mode: form.elements.mode.value,
      targetPerDay: Math.max(1, Number(form.elements.targetPerDay.value) || 1),
      focusDurationMin: form.elements.focusDurationMin.value ? Number(form.elements.focusDurationMin.value) : null,
      focusSpentMin: Number(existing?.focusSpentMin) || 0,
      targetItemsPerDay: form.elements.requireAllItems.checked
        ? parseItems(form.elements.items.value, form.elements.unit.value.trim(), existing?.items).length
        : Math.max(1, Number(form.elements.targetItemsPerDay.value) || 1),
      requireAllItems: form.elements.mode.value === "items" ? form.elements.requireAllItems.checked : false,
      unit: form.elements.unit.value.trim(),
      lifeAreaId: form.elements.lifeAreaId.value || null,
      items: form.elements.mode.value === "items"
        ? parseItems(form.elements.items.value, form.elements.unit.value.trim(), existing?.items) : (existing?.items ?? []),
      progress: existing?.progress ?? {},
      itemLog: existing?.itemLog ?? {},
      objectiveId: form.elements.objectiveId.value || null,
      history: existing?.history ?? {},
      archived: false,
      order: existing?.order ?? records.habits.length,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    try {
      if (!habit.title) throw new Error("أدخل اسم العادة.");
      if (habit.mode === "items" && !habit.items.length) throw new Error("أضف بنداً واحداً على الأقل.");
      if (habit.mode === "items" && !habit.requireAllItems && habit.targetItemsPerDay > habit.items.length) {
        throw new Error("هدف الإنجاز اليومي لا يمكن أن يتجاوز عدد البنود. أضف بنوداً أو خفّض الهدف.");
      }
      const saveButton = form.querySelector('button[type="submit"]');
      saveButton.disabled = true;
      if (existing) await update("habits", habit);
      else await add("habits", habit);
      form.closest("dialog").close();
      setStatus(existing ? "حُفظت تعديلات العادة." : "أُضيفت العادة.");
    } catch (error) {
      console.error("تعذّر حفظ العادة:", error);
      setStatus(error.message, true);
    } finally {
      const saveButton = form.querySelector('button[type="submit"]');
      if (saveButton) saveButton.disabled = false;
    }
  }, { signal });
}

async function refreshRecords() {
  const [habits, objectives, lifeAreas] = await Promise.all([
    getRecords("habits"),
    getRecords("objectives"),
    ensureDefaultLifeAreas(),
  ]);
  records = { habits, objectives, lifeAreas };
}

export async function mountHabitsView(isCurrent = () => true) {
  unsubscribe?.();
  await refreshRecords();
  if (!isCurrent()) return;
  document.querySelector("#page-title").textContent = "العادات";
  render();
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  if (params.get("preset") === "prayer") {
    const app = document.querySelector("#app");
    if (app) openPrayerPreset(app);
    const date = params.get("date");
    const cleanUrl = `${window.location.pathname}${window.location.search}#/habits${date ? `?date=${encodeURIComponent(date)}` : ""}`;
    window.history.replaceState(window.history.state, "", cleanUrl);
  }
  unsubscribe = subscribe(async (_state, change) => {
    if (!change.storeName || ["habits", "objectives", "lifeAreas"].includes(change.storeName)) {
      try {
        await refreshRecords();
        if (isCurrent() && window.location.hash.startsWith("#/habits")) render();
      } catch (error) {
        console.error("تعذّر تحديث العادات:", error);
        setStatus(error.message, true);
      }
    }
  });
}

export function unmountHabitsView() {
  unsubscribe?.();
  unsubscribe = undefined;
  eventController?.abort();
  eventController = undefined;
  expandedHabitDetails.clear();
}

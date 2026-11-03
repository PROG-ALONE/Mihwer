import { add, getRecords, subscribe, update } from "../store.js";
import { localDateString } from "../utils/dates.js";
import { showToast } from "../utils/notifications.js";

const DAY_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const DAYS = 84;

let unsubscribe;
let eventController;
let records = { habits: [], objectives: [] };
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
      mode, logged, done: done.length, total: items.length, target,
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
  else delete next.history[date];
  return next;
}

export function setItemsLogged(habit, date, itemIds) {
  const logged = [...new Set(itemIds)];
  return withProgress(habit, date, (next) => {
    next.itemLog = { ...(habit.itemLog ?? {}), [date]: logged };
  });
}

export function setDayComplete(habit, date, complete) {
  return withProgress(habit, date, (next) => {
    const mode = habitMode(habit);
    if (mode === "count") {
      next.progress = { ...(habit.progress ?? {}), [date]: complete ? Math.max(1, Number(habit.targetPerDay) || 1) : 0 };
    } else if (mode === "items") {
      next.itemLog = {
        ...(habit.itemLog ?? {}),
        [date]: complete
          ? habit.items.slice(0, requiresAllItems(habit) ? habit.items.length : Math.max(1, Number(habit.targetItemsPerDay) || habit.items.length)).map((item) => item.id)
          : [],
      };
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
  "نافلة | الوتر | 1 | ركعة",
  "نافلة | صلاة الضحى | 2 | ركعة",
].join("\n");

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

function renderHabit(habit) {
  const today = localDateString();
  const progress = dayProgress(habit, today);
  const checked = progress.complete;
  const unit = escapeHtml(habit.unit ?? "");
  const { current, longest } = streaks(habit);
  const stats = consistency(habit);
  const linkedObjective = records.objectives.find((objective) => objective.id === habit.objectiveId);
  return `<article class="habit-card" data-habit-id="${escapeHtml(habit.id)}">
    <span class="habit-color-dot" aria-hidden="true"></span>
    <div class="habit-card-heading">
      <button class="habit-today-toggle${checked ? " is-checked" : ""}" type="button" data-action="toggle-today" aria-pressed="${checked}" aria-label="${checked ? "إلغاء تحقق" : "تحقق"} ${escapeHtml(habit.title)}">
        <span aria-hidden="true">${checked ? "✓" : "+"}</span>
      </button>
      <div class="habit-title-group"><h3>${escapeHtml(habit.title)}</h3><span>${checked ? "مكتملة اليوم" : progress.mode === "count" ? `${progress.done}/${progress.total} ${unit}` : `${current} يوم متتالٍ`}</span></div>
      <button class="icon-button" type="button" data-action="edit" aria-label="تعديل ${escapeHtml(habit.title)}">✎</button>
      <button class="icon-button" type="button" data-action="archive" aria-label="أرشفة ${escapeHtml(habit.title)}">×</button>
    </div>
    <details class="habit-details" data-habit-details="${escapeHtml(habit.id)}"${expandedHabitDetails.has(habit.id) ? " open" : ""}>
      <summary><span>تفاصيل العادة</span><span class="habit-details-progress">${progress.mode === "items" ? `${progress.done}/${progress.total} بند` : progress.mode === "count" ? `${progress.done}/${progress.total} ${unit}` : checked ? "مكتملة اليوم" : "لم تكتمل اليوم"}</span></summary>
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
      <div class="habit-items-heading"><div><strong>تفاصيل اليوم</strong><span>${requiresAllItems(habit) ? "أكمل كل البنود لتسجيل العادة" : "اختر البنود التي أنجزتها"}</span></div><strong>${progress.done}/${progress.total}</strong></div>
      ${habitItemsMarkup(habit.items, progress.logged)}
    </div>
    <p class="habit-item-summary">${requiresAllItems(habit) ? "لا تكتمل العادة إلا بإكمال جميع التفاصيل." : `هدف اليوم: ${progress.done}/${progress.target} بند`}${progress.amountDetails.length ? ` · الكميات (منجز/إجمالي): ${progress.amountDetails.join("، ")}` : ""}</p>
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
  const habits = records.habits.filter((habit) => !habit.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  app.innerHTML = `
    <section class="habits-page" aria-label="متابعة العادات">
      <header class="habits-heading">
        <div><p class="goals-kicker">مساحة الإنجاز</p><h2>عاداتك</h2><p class="goals-subtitle">${habits.length} عادة · سجّل إنجازك بخطوة واحدة</p></div>
        <button class="habits-heading-add" type="button" data-action="new-habit" aria-label="إضافة عادة"><span aria-hidden="true">＋</span></button>
      </header>
      ${habits.length ? `<div class="habits-list">${habits.map(renderHabit).join("")}</div>` : `<div class="goals-empty">ابدأ بعادة صغيرة تريد بناءها. ويمكنك ربطها بهدف سنوي.</div>`}
      <p class="habits-status" role="status" aria-live="polite"></p>
      <dialog class="goal-dialog" id="habit-dialog">
        <form id="habit-form">
          <div class="dialog-heading"><h2 id="habit-dialog-title">إضافة عادة</h2><button class="icon-button" type="button" data-action="close">×</button></div>
          <input type="hidden" name="id">
          <label>اسم العادة<input name="title" required maxlength="120"></label>
          <div class="goal-dialog-fields">
            <label>نوع العادة<select name="kind"><option value="build">بناء عادة</option><option value="quit">تقليل عادة</option></select></label>
            <label>الجدول<select name="schedule"><option value="daily">كل يوم</option><option value="weekdays">أيام العمل</option><option value="weekends">نهاية الأسبوع</option></select></label>
            <label>طريقة التتبع<select name="mode"><option value="check">تأشير (تمت/لم تتم)</option><option value="count">عدّاد بهدف يومي</option><option value="items">بنود (مثل الصلوات)</option></select></label>
            <label data-mode-field="count">الهدف اليومي (العدد)<input name="targetPerDay" type="number" min="1" max="10000" value="1"></label>
            <label>مدة التركيز المستهدفة بالدقائق<input name="focusDurationMin" type="number" min="1" max="180" step="1" placeholder="المدة الافتراضية"></label>
            <label data-mode-field="items">هدف الإنجاز اليومي (عدد البنود)<input name="targetItemsPerDay" type="number" min="1" max="100" value="1"><small>تُحسب العادة منجزة عند بلوغ هذا العدد.</small></label>
            <label data-mode-field="count items">الوحدة (مثل: صفحة، ركعة، كوب)<input name="unit" maxlength="30"></label>
            <label class="habit-require-all-label" data-mode-field="items"><input name="requireAllItems" type="checkbox"><span><strong>لا تكتمل إلا بإكمال كل البنود</strong><small>مناسب للصلاة أو لأي عادة تتطلب إتمام جميع تفاصيلها.</small></span></label>
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
    const button = event.target.closest("[data-action]");
    const card = event.target.closest(".habit-card[data-habit-id]");
    if (!button && card && !event.target.closest("a, input, label, details, summary, button")) {
      const details = card.querySelector(":scope > .habit-details");
      if (details) details.open = !details.open;
      return;
    }
    if (!button) return;
    const action = button.dataset.action;
    if (action === "new-habit") {
      app.querySelector("#habit-form").reset();
      app.querySelector("#habit-form").elements.id.value = "";
      syncModeFields(app.querySelector("#habit-form"));
      app.querySelector("#habit-dialog-title").textContent = "إضافة عادة";
      app.querySelector("#habit-dialog").showModal();
      return;
    }
    if (action === "prayer-preset") {
      const form = app.querySelector("#habit-form");
      form.elements.items.value = PRAYER_PRESET;
      form.elements.unit.value = "ركعة";
      form.elements.mode.value = "items";
      form.elements.requireAllItems.checked = true;
      form.elements.targetItemsPerDay.value = String(PRAYER_PRESET.split("\n").length);
      if (!form.elements.title.value) form.elements.title.value = "الصلاة بتفاصيلها";
      syncModeFields(form);
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
        const today = localDateString();
        const next = setDayComplete(habit, today, !dayProgress(habit, today).complete);
        await update("habits", next);
        setStatus(next.history[today] ? "تم تسجيل العادة لهذا اليوم." : "أُزيل تسجيل اليوم.");
      } else if (action === "count-inc" || action === "count-dec") {
        const today = localDateString();
        const value = Math.max(0, (Number(habit.progress?.[today]) || 0) + (action === "count-inc" ? 1 : -1));
        await update("habits", withProgress(habit, today, (next) => { next.progress = { ...(habit.progress ?? {}), [today]: value }; }));
      } else if (action === "toggle-item") {
        const today = localDateString();
        const id = button.dataset.itemId;
        const logged = new Set(habit.itemLog?.[today] ?? []);
        if (logged.has(id)) logged.delete(id);
        else logged.add(id);
        const next = setItemsLogged(habit, today, [...logged]);
        await update("habits", next);
        setStatus(`تقدّم ${habit.title}: ${dayProgress(next, today).done} من ${dayProgress(next, today).target} بند للهدف اليومي.`);
      } else if (action === "edit") {
        const form = app.querySelector("#habit-form");
        form.elements.id.value = habit.id;
        form.elements.title.value = habit.title;
        form.elements.kind.value = habit.kind ?? "build";
        form.elements.schedule.value = ["daily", "weekdays", "weekends"].includes(habit.schedule) ? habit.schedule : "daily";
        form.elements.targetPerDay.value = habit.targetPerDay ?? 1;
        form.elements.focusDurationMin.value = habit.focusDurationMin ?? "";
        form.elements.targetItemsPerDay.value = habit.targetItemsPerDay ?? (habit.items?.length || 1);
        form.elements.mode.value = habitMode(habit);
        form.elements.unit.value = habit.unit ?? "";
        form.elements.requireAllItems.checked = requiresAllItems(habit);
        form.elements.items.value = (habit.items ?? []).map((item) =>
          `${item.category ?? "عام"} | ${item.name} | ${item.amount || ""} | ${item.unit ?? habit.unit ?? ""}`).join("\n");
        syncModeFields(form);
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
    const next = setDayComplete(habit, date, !isCompleted(habit, date));
    const history = next.history;
    try {
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
      mode: form.elements.mode.value,
      targetPerDay: Math.max(1, Number(form.elements.targetPerDay.value) || 1),
      focusDurationMin: form.elements.focusDurationMin.value ? Number(form.elements.focusDurationMin.value) : null,
      focusSpentMin: Number(existing?.focusSpentMin) || 0,
      targetItemsPerDay: form.elements.requireAllItems.checked
        ? parseItems(form.elements.items.value, form.elements.unit.value.trim(), existing?.items).length
        : Math.max(1, Number(form.elements.targetItemsPerDay.value) || 1),
      requireAllItems: form.elements.mode.value === "items" ? form.elements.requireAllItems.checked : false,
      unit: form.elements.unit.value.trim(),
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
      if (existing) await update("habits", habit);
      else await add("habits", habit);
      form.closest("dialog").close();
      setStatus(existing ? "حُفظت تعديلات العادة." : "أُضيفت العادة.");
    } catch (error) {
      console.error("تعذّر حفظ العادة:", error);
      setStatus(error.message, true);
    }
  }, { signal });
}

async function refreshRecords() {
  const [habits, objectives] = await Promise.all([getRecords("habits"), getRecords("objectives")]);
  records = { habits, objectives };
}

export async function mountHabitsView(isCurrent = () => true) {
  unsubscribe?.();
  await refreshRecords();
  if (!isCurrent()) return;
  document.querySelector("#page-title").textContent = "العادات";
  render();
  unsubscribe = subscribe(async (_state, change) => {
    if (!change.storeName || ["habits", "objectives"].includes(change.storeName)) {
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
}

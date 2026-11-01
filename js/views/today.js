import { dayProgress, setDayComplete, setItemsLogged } from "./habits.js";
import { add, getRecords, subscribe, update } from "../store.js";
import { formatDate, localDateString } from "../utils/dates.js";
import { nextOccurrence } from "../utils/recurrence.js";
import { showToast } from "../utils/notifications.js";

const PRIORITIES = [
  { important: true, urgent: true, label: "Q1" },
  { important: true, urgent: false, label: "Q2" },
  { important: false, urgent: true, label: "Q3" },
  { important: false, urgent: false, label: "Q4" },
];

let unsubscribe;
let eventController;
let records = { tasks: [], habits: [], objectives: [], keyResults: [], lifeAreas: [], sessions: [], journal: [] };
let statusMessage = "";
let statusIsError = false;
const expandedTodayHabitDetails = new Set();

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function priorityIndex(task) {
  if (task.important && task.urgent) return 0;
  if (task.important) return 1;
  if (task.urgent) return 2;
  return 3;
}

function priorityModeEnabled() {
  return localStorage.getItem("mihwar-task-priority-mode") === "true";
}

function tasksScheduledToday() {
  const today = localDateString();
  const usePriorities = priorityModeEnabled();
  return records.tasks
    .filter((task) => task.scheduled === today || task.due === today)
    .sort((first, second) => (usePriorities ? priorityIndex(first) - priorityIndex(second) : 0) ||
      (first.order ?? 0) - (second.order ?? 0));
}

function todayTasks() {
  return tasksScheduledToday().filter((task) => task.status !== "done");
}

function completedTasksToday() {
  return tasksScheduledToday().filter((task) => task.status === "done");
}

function isHabitScheduledOn(habit, date) {
  const schedule = habit.schedule;
  if (!schedule) return true;
  if (schedule === "daily" || schedule === "everyday") return true;
  const weekday = new Date(`${date}T12:00:00`).getDay();
  const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const arabicNames = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  if (schedule === "weekdays") return weekday >= 1 && weekday <= 5;
  if (schedule === "weekends") return weekday === 0 || weekday === 6;
  if (Array.isArray(schedule)) {
    return schedule.some((day) => Number(day) === weekday || String(day).toLowerCase() === names[weekday] || day === arabicNames[weekday]);
  }
  if (typeof schedule === "object") {
    return Boolean(schedule[weekday] ?? schedule[names[weekday]] ?? schedule[arabicNames[weekday]]);
  }
  return true;
}

function isHabitScheduledToday(habit) {
  return isHabitScheduledOn(habit, localDateString());
}

function habitCompletedToday(habit) {
  return dayProgress(habit, localDateString()).complete;
}

function habitStreak(habit) {
  const cursor = new Date(`${localDateString()}T12:00:00`);
  if (isHabitScheduledOn(habit, localDateString()) && !habitCompletedToday(habit)) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  for (let offset = 0; offset < 366; offset += 1) {
    const date = localDateString(cursor);
    if (isHabitScheduledOn(habit, date)) {
      if (!dayProgress(habit, date).complete) break;
      streak += 1;
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function habitProgressLabel(habit) {
  const progress = dayProgress(habit, localDateString());
  if (progress.mode === "check") return "";
  const denominator = progress.mode === "items" ? progress.target : progress.total;
  const detail = progress.mode === "items" ? ` من ${progress.total} بند` : habit.unit ? ` ${escapeHtml(habit.unit)}` : "";
  return ` <small>${progress.done}/${denominator}${detail}</small>`;
}

function renderTodayHabitItems(habit) {
  const logged = new Set(habit.itemLog?.[localDateString()] ?? []);
  return ["فرض", "سنة", "نافلة", "عام"].map((category) => {
    const items = (habit.items ?? []).filter((item) => (item.category ?? "عام") === category);
    if (!items.length) return "";
    return `<section class="today-habit-item-group">
      <h4>${category}</h4>
      ${items.map((item) => `<button type="button" class="today-habit-item${logged.has(item.id) ? " is-done" : ""}" data-action="toggle-habit-item" data-item-id="${escapeHtml(item.id)}" aria-pressed="${logged.has(item.id)}">
        <span class="habit-item-category">${category}</span>
        <span>${escapeHtml(item.name)}</span>
        ${item.amount ? `<small>${item.amount} ${escapeHtml(item.unit ?? "")}</small>` : ""}
      </button>`).join("")}
    </section>`;
  }).join("");
}

function todaySessions() {
  const today = localDateString();
  return records.sessions.filter((session) => session.start?.slice(0, 10) === today);
}

function focusMinutes() {
  return todaySessions().reduce((sum, session) => {
    if (session.status !== "completed" || session.type === "break") return sum;
    const duration = Number(session.durationMin);
    return sum + (Number.isFinite(duration) ? Math.max(0, duration) : 0);
  }, 0);
}

function monthlySummary(today = new Date()) {
  const monthStart = localDateString(new Date(today.getFullYear(), today.getMonth(), 1));
  const monthEnd = localDateString(today);
  const completedTasks = records.tasks.filter((task) =>
    task.status === "done" && task.completedAt?.slice(0, 10) >= monthStart && task.completedAt?.slice(0, 10) <= monthEnd).length;
  const focusMinutes = records.sessions.reduce((total, session) => {
    const date = session.start?.slice(0, 10);
    if (!date || session.status !== "completed" || session.type === "break" || date < monthStart || date > monthEnd) return total;
    const duration = Number(session.durationMin);
    return total + (Number.isFinite(duration) ? Math.max(0, duration) : 0);
  }, 0);
  const habits = records.habits.filter((habit) => !habit.archived).map((habit) => {
    let scheduledDays = 0;
    let completedDays = 0;
    const date = new Date(today.getFullYear(), today.getMonth(), 1);
    while (localDateString(date) <= monthEnd) {
      const dateString = localDateString(date);
      if (isHabitScheduledOn(habit, dateString)) {
        scheduledDays += 1;
        if (dayProgress(habit, dateString).complete) completedDays += 1;
      }
      date.setDate(date.getDate() + 1);
    }
    return {
      habit,
      scheduledDays,
      completedDays,
      percent: scheduledDays ? Math.round(completedDays / scheduledDays * 100) : 0,
    };
  });
  const scheduledDays = habits.reduce((total, item) => total + item.scheduledDays, 0);
  const completedDays = habits.reduce((total, item) => total + item.completedDays, 0);
  const bestHabit = habits
    .filter((item) => item.completedDays > 0)
    .sort((first, second) => second.percent - first.percent || second.completedDays - first.completedDays)[0];
  return {
    monthLabel: new Intl.DateTimeFormat("ar", { month: "long", year: "numeric" }).format(today),
    completedTasks,
    focusMinutes,
    habitPercent: scheduledDays ? Math.round(completedDays / scheduledDays * 100) : 0,
    scheduledDays,
    completedDays,
    bestHabit,
  };
}

function renderMonthlySummary() {
  const summary = monthlySummary();
  const focusHours = Math.floor(summary.focusMinutes / 60);
  const remainingFocusMinutes = summary.focusMinutes % 60;
  const focusValue = focusHours ? `${focusHours} س ${remainingFocusMinutes} د` : `${remainingFocusMinutes} د`;
  const bestHabit = summary.bestHabit;
  return `<section class="today-panel today-month-summary" aria-label="حصاد الشهر">
    <header class="today-month-heading">
      <div><p class="today-kicker">خطواتك تتراكم</p><h2>حصاد ${escapeHtml(summary.monthLabel)}</h2></div>
      <span class="today-month-caption">حتى اليوم</span>
    </header>
    <div class="today-month-stats">
      <article class="today-month-metric" data-tone="tasks"><span>مهام مكتملة</span><strong>${summary.completedTasks}</strong></article>
      <article class="today-month-metric" data-tone="habits"><span>ثبات العادات</span><strong>${summary.habitPercent}%</strong><small>${summary.completedDays} من ${summary.scheduledDays} يوماً مجدولاً</small></article>
      <article class="today-month-metric" data-tone="focus"><span>وقت التركيز</span><strong>${focusValue}</strong></article>
    </div>
    <div class="today-month-best">
      ${bestHabit ? `<div><span class="today-month-best-label">أفضل عادة هذا الشهر</span><strong>${escapeHtml(bestHabit.habit.title)}</strong><small>${bestHabit.completedDays} من ${bestHabit.scheduledDays} يوماً · ${bestHabit.percent}%</small></div>
        <div class="today-month-best-progress" role="progressbar" aria-label="ثبات ${escapeHtml(bestHabit.habit.title)} هذا الشهر" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${bestHabit.percent}"><span style="width:${bestHabit.percent}%"></span></div>` :
        `<span>ابدأ بتسجيل عادة لتظهر هنا أفضل عادة التزاماً.</span><a href="#/habits">إضافة عادة</a>`}
    </div>
  </section>`;
}

function highlightedObjective() {
  const year = new Date().getFullYear();
  return records.objectives
    .filter((objective) => Number(objective.year) === year && objective.status !== "done" && objective.status !== "archived")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
}

function objectiveProgress(objective) {
  const results = records.keyResults.filter((result) => result.objectiveId === objective.id);
  if (!results.length) return 0;
  const progress = results.map((result) => {
    const start = Number(result.start ?? 0);
    const current = Number(result.current ?? start);
    const target = Number(result.target ?? 0);
    if (!Number.isFinite(current) || !Number.isFinite(target) || target === start) return 0;
    return Math.max(0, Math.min(100, ((current - start) / (target - start)) * 100));
  });
  return Math.round(progress.reduce((sum, value) => sum + value, 0) / progress.length);
}

function objectiveCard() {
  const objective = highlightedObjective();
  if (!objective) {
    return `<article class="today-objective today-panel">
      <div><p class="today-kicker">محور السنة</p><h2>اختر هدفاً ليكون محورك</h2></div>
      <a class="button button-secondary" href="#/goals">عرض الأهداف</a>
    </article>`;
  }
  const progress = objectiveProgress(objective);
  const area = records.lifeAreas.find((item) => item.id === objective.lifeAreaId);
  return `<article class="today-objective today-panel">
    <div class="today-objective-copy">
      <p class="today-kicker">محور السنة${area ? ` · ${escapeHtml(area.name)}` : ""}</p>
      <h2>${escapeHtml(objective.title)}</h2>
      <p class="today-muted">${escapeHtml(objective.description ?? "")}</p>
    </div>
    <div class="objective-progress">
      <div class="objective-progress-label"><span>تقدّم النتائج الرئيسية</span><strong>${progress}%</strong></div>
      <div class="progress-track" role="progressbar" aria-label="تقدم الهدف" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
        <span style="width:${progress}%"></span>
      </div>
    </div>
  </article>`;
}

function renderTasks(tasks, emptyMessage = "لا توجد مهام مجدولة لهذا اليوم. يمكنك ترك المساحة فارغة أو إضافة مهمة من <a href=\"#/tasks\">قسم المهام</a>.") {
  if (!tasks.length) return `<p class="today-empty">${emptyMessage}</p>`;
  const renderTask = (task) => {
    const done = task.status === "done";
    return `<article class="today-task${done ? " is-done" : ""}" data-priority="${priorityIndex(task)}" data-task-id="${escapeHtml(task.id)}">
      <label class="today-checkbox" aria-label="${done ? "إعادة فتح" : "إنجاز"} ${escapeHtml(task.title)}">
        <input type="checkbox" data-action="complete-task" ${done ? "checked" : ""}>
        <span aria-hidden="true"></span>
      </label>
      <div class="today-task-copy">
        <span class="today-task-title">${escapeHtml(task.title)}</span>
        <span class="today-task-meta">${task.due ? escapeHtml(formatDate(task.due)) : ""}${task.dueTime ? ` · ${escapeHtml(task.dueTime)}` : ""}${task.estimateMin ? ` · ${task.estimateMin} دقيقة` : ""}</span>
      </div>
      <a class="today-task-open" href="#/tasks" aria-label="فتح المهام">↗</a>
    </article>`;
  };
  if (!priorityModeEnabled()) {
    return `<section class="today-task-group today-task-queue">${tasks.map(renderTask).join("")}</section>`;
  }
  return PRIORITIES.map((priority, index) => {
    const group = tasks.filter((task) => priorityIndex(task) === index);
    if (!group.length) return "";
    return `<section class="today-task-group">
      <h3><span class="today-priority-dot priority-dot-${index}" aria-hidden="true"></span>${priority.label} <span class="today-muted">${index === 0 ? "مهم وعاجل" : index === 1 ? "مهم" : index === 2 ? "عاجل" : "بلا استعجال"}</span></h3>
      ${group.map(renderTask).join("")}
    </section>`;
  }).join("");
}

function renderHabits(habits) {
  if (!habits.length) return `<p class="today-empty">أضف عادة لتظهر هنا وتتابعها خلال اليوم. <a href="#/habits">إدارة العادات</a></p>`;
  return `<div class="today-habit-list">${habits.map((habit) => {
    const checked = habitCompletedToday(habit);
    const progress = dayProgress(habit, localDateString());
    const streak = habitStreak(habit);
    return `<article class="today-habit${checked ? " is-complete" : ""}" data-habit-id="${escapeHtml(habit.id)}">
      <button class="habit-check-button${checked ? " is-checked" : ""}" type="button" data-action="toggle-habit" aria-pressed="${checked}" aria-label="${checked ? "إلغاء إكمال" : "إكمال"} ${escapeHtml(habit.title)}">
        <span aria-hidden="true">${checked ? "✓" : "+"}</span>
      </button>
      <span class="today-habit-copy">${escapeHtml(habit.title)}${habitProgressLabel(habit)}${streak ? `<small class="today-habit-streak">🔥 ${streak} ${streak === 1 ? "يوم" : "أيام"}</small>` : ""}</span>
      ${habit.mode === "items" ? `<details class="today-habit-details" data-today-habit-details="${escapeHtml(habit.id)}"${expandedTodayHabitDetails.has(habit.id) ? " open" : ""}>
        <summary><span>تفاصيل البنود</span><span>${progress.done}/${progress.total}</span></summary>
        <div class="today-habit-items">${renderTodayHabitItems(habit)}</div>
      </details>` : ""}
    </article>`;
  }).join("")}</div>`;
}

function renderFocusCard() {
  const active = records.sessions.find((session) => session.status === "active");
  const activeTask = active?.taskId ? records.tasks.find((task) => task.id === active.taskId) : null;
  const activeHabit = active?.habitId ? records.habits.find((habit) => habit.id === active.habitId) : null;
  const activeTarget = activeTask ?? activeHabit;
  const activeRoute = active?.taskId
    ? `#/focus?task=${encodeURIComponent(active.taskId)}`
    : active?.habitId ? `#/focus?habit=${encodeURIComponent(active.habitId)}` : "#/focus";
  if (active) {
    return `<article class="focus-card is-running">
      <span class="focus-card-icon" aria-hidden="true">◉</span>
      <div class="focus-card-copy"><p class="today-kicker">جلسة تركيز نشطة</p><h2>${activeTarget ? escapeHtml(activeTarget.title) : "وقت للمهمة الواحدة"}</h2><p>بدأت ${escapeHtml(new Intl.DateTimeFormat("ar", { hour: "numeric", minute: "2-digit" }).format(new Date(active.start)))}</p></div>
      <a class="button button-secondary" href="${activeRoute}">متابعة الجلسة</a>
    </article>`;
  }
  return `<article class="focus-card">
    <span class="focus-card-icon" aria-hidden="true">◉</span>
    <div class="focus-card-copy"><p class="today-kicker">التركيز ضمن خطتك</p><h2>ابدأ من مهمة أو عادة</h2><p>سجّل مدة التركيز مباشرة على العنصر الذي تعمل عليه.</p></div>
    <div class="focus-card-actions"><a class="button button-secondary" href="#/tasks">اختر مهمة</a><a class="button button-secondary" href="#/habits">اختر عادة</a></div>
  </article>`;
}

function render() {
  const app = document.querySelector("#app");
  if (!app) return;
  const tasks = todayTasks();
  const scheduledTasks = tasksScheduledToday();
  const completedTasks = completedTasksToday();
  const plannedCount = scheduledTasks.length;
  const habits = records.habits.filter((habit) => !habit.archived && isHabitScheduledToday(habit));
  const completedCount = scheduledTasks.filter((task) => task.status === "done").length;
  const completedHabits = habits.filter(habitCompletedToday).length;
  const dailyTotal = plannedCount + habits.length;
  const dailyCompleted = completedCount + completedHabits;
  const dailyPercent = dailyTotal ? Math.round(dailyCompleted / dailyTotal * 100) : 0;
  const journalEntry = records.journal.find((entry) => entry.date === localDateString());
  const sessionCount = todaySessions().length;

  app.innerHTML = `
    <section class="today-page" aria-label="ملخص اليوم">
      <div class="today-welcome">
        <div><p class="today-kicker">خطوة هادئة تكفي</p><h2>${escapeHtml(new Intl.DateTimeFormat("ar", { weekday: "long", day: "numeric", month: "long" }).format(new Date()))}</h2></div>
        <span class="today-progress-summary">${dailyCompleted} أُنجزت <span aria-hidden="true">·</span> ${dailyTotal} لهذا اليوم</span>
      </div>
      <section class="today-progress-hero" aria-label="إنجاز اليوم">
        <div class="today-progress-ring" role="img" aria-label="إنجاز ${dailyPercent}% من خطة اليوم" style="--today-progress:${dailyPercent}%"><span><strong>${dailyPercent}%</strong><small>إنجاز اليوم</small></span></div>
        <div class="today-progress-copy"><p class="today-kicker">خطتك في مكان واحد</p><h2>${dailyCompleted === dailyTotal && dailyTotal ? "أحسنت، أكملت خطتك!" : "كل خطوة تُحسب"}</h2><p>تابع مهامك وعاداتك دون أن تفقد الصورة الكاملة.</p>
          <div class="today-progress-pills"><span>المهام <strong>${completedCount}/${plannedCount}</strong></span><span>العادات <strong>${completedHabits}/${habits.length}</strong></span></div>
        </div>
      </section>
      ${renderMonthlySummary()}
      ${objectiveCard()}
      <div class="today-columns">
        <div class="today-primary-column">
          <section class="today-panel today-section">
            <div class="today-section-heading"><div><p class="today-kicker">خطتك اليومية</p><h2>مهام اليوم</h2></div><span class="today-section-count">${tasks.length}</span></div>
            <div class="today-task-groups">${renderTasks(tasks)}</div>
            <details class="today-completed-tasks">
              <summary><span>المهام المنجزة اليوم</span><strong>${completedTasks.length}</strong></summary>
              ${renderTasks(completedTasks, "لم تُنجز مهمة مجدولة اليوم بعد.")}
            </details>
          </section>
          <section class="today-panel today-section">
            <div class="today-section-heading"><div><p class="today-kicker">ثباتك يصنع الفرق</p><h2>عادات اليوم</h2></div><span class="today-section-count">${completedHabits}/${habits.length}</span></div>
            ${renderHabits(habits)}
          </section>
        </div>
        <aside class="today-side-column">
          ${renderFocusCard()}
          <section class="today-panel today-stat-card">
            <p class="today-kicker">مساحة التركيز</p>
            <strong>${focusMinutes()} <span>دقيقة</span></strong>
            <p class="today-muted">${sessionCount} جلسة اليوم</p>
          </section>
          <section class="today-panel today-journal">
            <div class="today-section-heading"><div><p class="today-kicker">لحظة لك</p><h2>مذكّرة سريعة</h2></div></div>
            <form id="today-journal-form">
              <label for="today-journal-text">ما الذي يشغل بالك اليوم؟</label>
              <textarea id="today-journal-text" name="text" rows="3" maxlength="2000" placeholder="اكتب بضعة أسطر لنفسك…">${escapeHtml(journalEntry?.text ?? "")}</textarea>
              <label for="today-mood">مزاجك اليوم</label>
              <select id="today-mood" name="mood">
                <option value="">اختر ما يناسبك</option>
                ${["متعب جداً", "متعب", "متوازن", "جيد", "ممتاز"].map((label, index) => `<option value="${index + 1}"${Number(journalEntry?.mood) === index + 1 ? " selected" : ""}>${index + 1} · ${label}</option>`).join("")}
              </select>
              <button class="button button-secondary" type="submit">${journalEntry ? "حفظ التحديث" : "حفظ المذكرة"}</button>
            </form>
          </section>
        </aside>
      </div>
      <p class="today-status" role="status" aria-live="polite" data-state="${statusIsError ? "error" : "success"}">${escapeHtml(statusMessage)}</p>
    </section>`;
  bindEvents(app);
}

function setStatus(message, isError = false) {
  statusMessage = message;
  statusIsError = isError;
  showToast(message, { isError });
  const element = document.querySelector(".today-status");
  if (element) {
    element.textContent = message;
    element.dataset.state = isError ? "error" : "success";
  }
}

async function refreshRecords() {
  const names = Object.keys(records);
  const values = await Promise.all(names.map((storeName) => getRecords(storeName)));
  records = Object.fromEntries(names.map((storeName, index) => [storeName, values[index]]));
}

function bindEvents(app) {
  eventController?.abort();
  eventController = new AbortController();
  const { signal } = eventController;
  app.addEventListener("click", (event) => {
    const summary = event.target.closest(".today-habit-details > summary");
    if (!summary) return;
    const details = summary.parentElement;
    const id = details.dataset.todayHabitDetails;
    if (details.open) expandedTodayHabitDetails.delete(id);
    else expandedTodayHabitDetails.add(id);
  }, { capture: true, signal });

  app.addEventListener("change", async (event) => {
    const checkbox = event.target.closest('[data-action="complete-task"]');
    if (!checkbox) return;
    const taskId = checkbox.closest("[data-task-id]")?.dataset.taskId;
    const task = records.tasks.find((item) => item.id === taskId);
    if (!task) return;
    try {
      const now = new Date().toISOString();
      const reopening = task.status === "done";
      await update("tasks", {
        ...task,
        status: reopening ? "open" : "done",
        completedAt: reopening ? null : now,
        updatedAt: now,
      });
      if (!reopening && task.recurrence) {
        const nextDate = nextOccurrence(task.scheduled || task.due, task.recurrence);
        await add("tasks", {
          ...task,
          id: crypto.randomUUID(),
          scheduled: nextDate,
          due: task.due ? nextDate : null,
          status: "open",
          completedAt: null,
          order: Date.now(),
          createdAt: now,
          updatedAt: now,
        });
      }
      setStatus(reopening ? "أُعيد فتح المهمة، وظهرت ضمن مهام اليوم." : "أُنجزت المهمة، وتجدها ضمن «المهام المنجزة اليوم».");
    } catch (error) {
      console.error("تعذّر تحديث مهمة اليوم:", error);
      setStatus(error.message, true);
    }
  }, { signal });

  app.addEventListener("click", async (event) => {
    const button = event.target.closest('[data-action="toggle-habit"], [data-action="toggle-habit-item"]');
    if (!button) return;
    try {
      if (button.dataset.action === "toggle-habit") {
        const habitId = button.closest("[data-habit-id]")?.dataset.habitId;
        const habit = records.habits.find((item) => item.id === habitId);
        if (!habit) return;
        const today = localDateString();
        const next = setDayComplete(habit, today, !dayProgress(habit, today).complete);
        await update("habits", next);
        setStatus(next.history[today] ? "تم تسجيل العادة لهذا اليوم." : "أُزيل تسجيل العادة لهذا اليوم.");
        return;
      }
      if (button.dataset.action === "toggle-habit-item") {
        const habitId = button.closest("[data-habit-id]")?.dataset.habitId;
        const habit = records.habits.find((item) => item.id === habitId);
        if (!habit) return;
        const today = localDateString();
        const logged = new Set(habit.itemLog?.[today] ?? []);
        if (logged.has(button.dataset.itemId)) logged.delete(button.dataset.itemId);
        else logged.add(button.dataset.itemId);
        const next = setItemsLogged(habit, today, [...logged]);
        await update("habits", next);
        const nextProgress = dayProgress(next, today);
        setStatus(`تقدّم ${habit.title}: ${nextProgress.done} من ${nextProgress.target} بند للهدف اليومي.`);
        return;
      }

    } catch (error) {
      console.error("تعذّر تحديث بيانات اليوم:", error);
      setStatus(error.message, true);
    }
  }, { signal });

  app.addEventListener("submit", async (event) => {
    const form = event.target.closest("#today-journal-form");
    if (!form) return;
    event.preventDefault();
    const today = localDateString();
    const entry = records.journal.find((item) => item.date === today);
    const text = form.elements.text.value.trim();
    const mood = form.elements.mood.value ? Number(form.elements.mood.value) : null;
    try {
      if (entry) {
        await update("journal", { ...entry, text, mood, updatedAt: new Date().toISOString() });
      } else {
        await add("journal", {
          id: crypto.randomUUID(),
          date: today,
          mood,
          text,
          gratitude: "",
          highlight: "",
          createdAt: new Date().toISOString(),
        });
      }
      setStatus("حُفظت مذكّرتك.");
    } catch (error) {
      console.error("تعذّر حفظ مذكّرة اليوم:", error);
      setStatus(error.message, true);
    }
  }, { signal });
}

export async function mountTodayView(isCurrent = () => true) {
  unsubscribe?.();
  await refreshRecords();
  if (!isCurrent()) return;
  document.querySelector("#page-title").textContent = "اليوم";
  render();
  unsubscribe = subscribe(async (_state, change) => {
    if (!change.storeName || Object.hasOwn(records, change.storeName)) {
      try {
        await refreshRecords();
        if (isCurrent() && window.location.hash.startsWith("#/today")) render();
      } catch (error) {
        console.error("تعذّر تحديث ملخص اليوم:", error);
        setStatus(error.message, true);
      }
    }
  });
}

export function unmountTodayView() {
  unsubscribe?.();
  unsubscribe = undefined;
  eventController?.abort();
  eventController = undefined;
}

import { getRecords, subscribe } from "../store.js";
import { formatDate, localDateString } from "../utils/dates.js";
import { getObjectiveProgress } from "../utils/okr.js";
import { dayProgress } from "./habits.js";

const DAY_NAMES = ["أحد", "اثن", "ثلا", "أرب", "خمي", "جمع", "سبت"];
const MONTH_NAMES = Array.from({ length: 12 }, (_, month) =>
  new Intl.DateTimeFormat("ar", { month: "long" }).format(new Date(2026, month, 1)));
const STORE_NAMES = ["tasks", "habits", "objectives", "keyResults", "sessions", "journal"];

let root;
let unsubscribe;
let records = { tasks: [], habits: [], objectives: [], keyResults: [], sessions: [], journal: [] };
let periodMode = ["day", "month", "year"].includes(localStorage.getItem("mihwar-dashboard-mode"))
  ? localStorage.getItem("mihwar-dashboard-mode")
  : "month";
let selectedDate = validDate(localStorage.getItem("mihwar-dashboard-date"))
  ? localStorage.getItem("mihwar-dashboard-date")
  : localDateString();
let refreshSequence = 0;

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && dateString(date) === value;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function currentDate() {
  return new Date(`${selectedDate}T12:00:00`);
}

function dateString(date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDate(year, month = 0, day = 1) {
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month, day);
  return date;
}

function dateWithin(value, start, end) {
  const date = String(value ?? "").slice(0, 10);
  return date >= start && date <= end;
}

function periodBounds(mode = periodMode, date = currentDate()) {
  const year = date.getFullYear();
  const month = date.getMonth();
  if (mode === "year") return {
    start: dateString(localDate(year, 0, 1)),
    end: dateString(localDate(year, 11, 31)),
  };
  if (mode === "month") {
    return {
      start: dateString(localDate(year, month, 1)),
      end: dateString(localDate(year, month + 1, 0)),
    };
  }
  const selected = dateString(date);
  return { start: selected, end: selected };
}

function formatPeriod() {
  const date = currentDate();
  if (periodMode === "year") return String(date.getFullYear());
  if (periodMode === "month") {
    return new Intl.DateTimeFormat("ar", { month: "long", year: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat("ar", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date);
}

function isHabitScheduled(habit, date) {
  const schedule = habit.schedule;
  if (!schedule || schedule === "daily" || schedule === "everyday") return true;
  const weekday = new Date(`${date}T12:00:00`).getDay();
  if (schedule === "weekdays") return weekday >= 1 && weekday <= 5;
  if (schedule === "weekends") return weekday === 0 || weekday === 6;
  if (Array.isArray(schedule)) {
    const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const arabicNames = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
    return schedule.some((day) => Number(day) === weekday ||
      String(day).toLowerCase() === names[weekday] || day === arabicNames[weekday]);
  }
  if (typeof schedule === "object") {
    const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const arabicNames = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
    return Boolean(schedule[weekday] ?? schedule[names[weekday]] ?? schedule[arabicNames[weekday]]);
  }
  return true;
}

function completedFocusMinutes(start, end) {
  return records.sessions
    .filter((session) => session.type !== "break" && session.status === "completed" &&
      dateWithin(session.start, start, end))
    .reduce((total, session) => {
      const duration = Number(session.durationMin);
      return total + (Number.isFinite(duration) ? Math.max(0, duration) : 0);
    }, 0);
}

function habitTotals(start, end) {
  const habits = records.habits.filter((habit) => !habit.archived);
  let scheduled = 0;
  let completed = 0;
  const cursor = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  while (cursor <= last) {
    const date = dateString(cursor);
    for (const habit of habits) {
      if (!isHabitScheduled(habit, date)) continue;
      scheduled += 1;
      if (dayProgress(habit, date).complete) completed += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return { scheduled, completed };
}

function metricsForDate(date) {
  const planned = records.tasks.filter((task) =>
    task.status !== "done" && (task.scheduled === date || task.due === date));
  const completedTasks = records.tasks.filter((task) =>
    task.status === "done" && (task.completedAt?.slice(0, 10) === date || task.scheduled === date || task.due === date));
  const habits = records.habits.filter((habit) => !habit.archived && isHabitScheduled(habit, date));
  const completedHabits = habits.filter((habit) => dayProgress(habit, date).complete).length;
  const focusMinutes = completedFocusMinutes(date, date);
  return {
    planned: planned.length,
    completed: completedTasks.length,
    habitScheduled: habits.length,
    habitCompleted: completedHabits,
    focusMinutes,
    journalEntries: records.journal.filter((entry) => entry.date === date).length,
  };
}

function periodMetrics() {
  const { start, end } = periodBounds();
  const plannedTasks = records.tasks.filter((task) =>
    task.status !== "done" && (dateWithin(task.scheduled, start, end) || dateWithin(task.due, start, end)));
  const completedTasks = records.tasks.filter((task) =>
    task.status === "done" && (dateWithin(task.completedAt, start, end) ||
      (!task.completedAt && (dateWithin(task.scheduled, start, end) || dateWithin(task.due, start, end)))));
  const habits = habitTotals(start, end);
  const focusMinutes = completedFocusMinutes(start, end);
  const journalEntries = records.journal.filter((entry) => dateWithin(entry.date, start, end)).length;
  const year = currentDate().getFullYear();
  const objectives = records.objectives.filter((objective) =>
    Number(objective.year) === year && objective.status !== "archived");
  const objectiveProgress = objectives.length
    ? Math.round(objectives.reduce((total, objective) =>
      total + getObjectiveProgress(objective, records.keyResults), 0) / objectives.length)
    : 0;
  return {
    plannedTasks: plannedTasks.length,
    completedTasks: completedTasks.length,
    ...habits,
    focusMinutes,
    journalEntries,
    objectives: objectives.length,
    objectiveProgress,
  };
}

function periodInput() {
  if (periodMode === "year") {
    return `<label class="period-input-label">السنة<input type="number" min="1" max="9999" value="${currentDate().getFullYear()}" data-period-input="year" aria-label="اختر السنة"></label>`;
  }
  if (periodMode === "month") {
    return `<label class="period-input-label">الشهر<input type="month" value="${selectedDate.slice(0, 7)}" data-period-input="month" aria-label="اختر الشهر"></label>`;
  }
  return `<label class="period-input-label">اليوم<input type="date" value="${selectedDate}" data-period-input="day" aria-label="اختر اليوم"></label>`;
}

function periodSummaryCards(metrics) {
  const habitPercent = metrics.scheduled
    ? Math.round(metrics.completed / metrics.scheduled * 100)
    : 0;
  return [
    { title: "المهام", value: `${metrics.completedTasks} / ${metrics.plannedTasks}`, hint: "منجزة / قيد الإنجاز", tone: "tasks" },
    { title: "العادات", value: `${metrics.completed} / ${metrics.scheduled}`, hint: `${habitPercent}% من الأيام المجدولة`, tone: "habits" },
    { title: "التركيز", value: `${metrics.focusMinutes} د`, hint: "جلسات مكتملة", tone: "focus" },
    { title: "الأهداف", value: `${metrics.objectiveProgress}%`, hint: `${metrics.objectives} أهداف هذا العام`, tone: "goals" },
    { title: "اليوميات", value: metrics.journalEntries, hint: "تدوينات في الفترة", tone: "journal" },
  ].map((card) => `<article class="period-summary-card" data-tone="${card.tone}">
    <span>${card.title}</span><strong>${card.value}</strong><small>${card.hint}</small>
  </article>`).join("");
}

function renderDayDetails(date) {
  const planned = records.tasks.filter((task) =>
    task.status !== "done" && (task.scheduled === date || task.due === date));
  const completed = records.tasks.filter((task) =>
    task.status === "done" && (task.completedAt?.slice(0, 10) === date || task.scheduled === date || task.due === date));
  const habits = records.habits.filter((habit) => !habit.archived && isHabitScheduled(habit, date));
  const focusSessions = records.sessions.filter((session) =>
    session.type !== "break" && dateWithin(session.start, date, date));
  const journal = records.journal.find((entry) => entry.date === date);
  const taskList = (items, empty) => items.length
    ? `<ul class="period-detail-list">${items.map((task) => `<li><a href="#/tasks">${escapeHtml(task.title)}</a><span>${task.status === "done" ? "مكتملة" : "قيد الإنجاز"}</span></li>`).join("")}</ul>`
    : `<p class="period-empty">${empty}</p>`;
  const habitList = habits.length
    ? `<ul class="period-detail-list">${habits.map((habit) => {
      const progress = dayProgress(habit, date);
      return `<li><a href="#/habits">${escapeHtml(habit.title)}</a><span>${progress.done}/${progress.target ?? progress.total}</span></li>`;
    }).join("")}</ul>`
    : `<p class="period-empty">لا توجد عادات مجدولة لهذا اليوم.</p>`;
  const sessions = focusSessions.length
    ? `<ul class="period-detail-list">${focusSessions.map((session) => `<li><a href="#/focus">${session.taskId ? "جلسة مهمة" : session.habitId ? "جلسة عادة" : "تركيز حر"}</a><span>${session.status === "active" ? "نشطة" : `${Number(session.durationMin) || 0} د`}</span></li>`).join("")}</ul>`
    : `<p class="period-empty">لا توجد جلسات تركيز مكتملة.</p>`;
  return `<div class="period-day-details">
    <section class="period-detail-card"><h3>المهام</h3>${taskList(planned, "لا توجد مهام مجدولة.")}<details class="period-completed-details"><summary>المهام المنجزة (${completed.length})</summary>${taskList(completed, "لا توجد مهام منجزة.")}</details></section>
    <section class="period-detail-card"><h3>العادات</h3>${habitList}</section>
    <section class="period-detail-card"><h3>التركيز</h3>${sessions}</section>
    <section class="period-detail-card"><h3>اليوميات</h3>${journal
      ? `<a class="period-journal-entry" href="#/journal">${escapeHtml(journal.highlight || journal.text || "تدوينة اليوم")}</a>`
      : `<p class="period-empty">لا توجد تدوينة لهذا اليوم.</p>`}</section>
  </div>`;
}

function dayCalendar(date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const count = localDate(year, month + 1, 0).getDate();
  const offset = localDate(year, month, 1).getDay();
  const leading = Array.from({ length: offset }, () => `<span class="period-calendar-spacer" aria-hidden="true"></span>`).join("");
  const days = Array.from({ length: count }, (_, index) => {
    const day = index + 1;
    const dateValue = dateString(localDate(year, month, day));
    const metrics = metricsForDate(dateValue);
    const selected = selectedDate === dateValue;
    const hasActivity = metrics.planned + metrics.completed + metrics.habitCompleted + metrics.focusMinutes > 0;
    return `<button class="period-day-cell${selected ? " is-selected" : ""}${hasActivity ? " has-activity" : ""}" type="button" data-select-day="${dateValue}" aria-label="${escapeHtml(formatDate(dateValue))}: ${metrics.planned} مهام، ${metrics.habitCompleted} عادات مكتملة">
      <span>${day}</span><small>${metrics.planned + metrics.completed || ""}</small>
    </button>`;
  }).join("");
  return `<div class="period-calendar" aria-label="أيام الشهر">
    ${DAY_NAMES.map((day) => `<span class="period-weekday">${day.slice(0, 2)}</span>`).join("")}
    ${leading}${days}
  </div>`;
}

function renderMonthGrid() {
  const date = currentDate();
  return `<div class="period-month-grid">${MONTH_NAMES.map((name, month) => {
    const monthStart = dateString(localDate(date.getFullYear(), month, 1));
    const monthEnd = dateString(localDate(date.getFullYear(), month + 1, 0));
    const monthMetrics = metricsForRange(monthStart, monthEnd);
    const selected = month === date.getMonth();
    return `<button class="period-month-card${selected ? " is-selected" : ""}" type="button" data-select-month="${month}" aria-label="${name} ${date.getFullYear()}">
      <strong>${name}</strong><span>${monthMetrics.tasks} مهام</span><small>${monthMetrics.focusMinutes} د تركيز</small>
    </button>`;
  }).join("")}</div>`;
}

function metricsForRange(start, end) {
  const tasks = records.tasks.filter((task) =>
    dateWithin(task.scheduled, start, end) || dateWithin(task.due, start, end) || dateWithin(task.completedAt, start, end));
  return {
    tasks: tasks.length,
    focusMinutes: completedFocusMinutes(start, end),
  };
}

function renderPeriodContent() {
  const date = currentDate();
  if (periodMode === "year") return renderMonthGrid();
  if (periodMode === "month") return dayCalendar(date);
  const dayMetrics = metricsForDate(selectedDate);
  return `<div class="period-selected-day">
    <div class="period-selected-heading"><h3>${escapeHtml(formatPeriod())}</h3><span>${dayMetrics.planned} مهام · ${dayMetrics.habitCompleted}/${dayMetrics.habitScheduled} عادات</span></div>
    ${renderDayDetails(selectedDate)}
  </div>`;
}

function changePeriod(delta) {
  const date = currentDate();
  if (periodMode === "year") date.setFullYear(date.getFullYear() + delta, 0, 1);
  else if (periodMode === "month") date.setMonth(date.getMonth() + delta, 1);
  else date.setDate(date.getDate() + delta);
  if (date.getFullYear() >= 1 && date.getFullYear() <= 9999) selectedDate = dateString(date);
}

function savePeriod() {
  localStorage.setItem("mihwar-dashboard-mode", periodMode);
  localStorage.setItem("mihwar-dashboard-date", selectedDate);
}

function render() {
  if (!root) return;
  const metrics = periodMetrics();
  const modeNames = { day: "اليوم", month: "الشهر", year: "السنة" };
  root.innerHTML = `<section class="period-dashboard" aria-label="لوحة الفترات">
    <header class="period-dashboard-heading">
      <div><p class="today-kicker">لوحتك المختصرة</p><h2>${escapeHtml(formatPeriod())}</h2></div>
      <button class="period-today-button" type="button" data-period-action="today">اليوم</button>
    </header>
    <nav class="period-mode-switch" aria-label="طريقة عرض التاريخ">
      ${Object.entries(modeNames).map(([mode, label]) => `<button type="button" data-period-mode="${mode}" aria-pressed="${periodMode === mode}">${label}</button>`).join("")}
    </nav>
    <div class="period-controls">
      <button class="period-arrow" type="button" data-period-action="previous" aria-label="الفترة السابقة">‹</button>
      ${periodInput()}
      <button class="period-arrow" type="button" data-period-action="next" aria-label="الفترة التالية">›</button>
    </div>
    <div class="period-summary-grid" aria-label="ملخص الفترة">${periodSummaryCards(metrics)}</div>
    <div class="period-content">${renderPeriodContent()}</div>
  </section>`;
}

async function refreshRecords() {
  const sequence = ++refreshSequence;
  const values = await Promise.all(STORE_NAMES.map((storeName) => getRecords(storeName)));
  if (sequence !== refreshSequence) return;
  records = Object.fromEntries(STORE_NAMES.map((storeName, index) => [storeName, values[index]]));
  render();
}

function bindEvents() {
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-period-mode], [data-period-action], [data-select-day], [data-select-month]");
    if (!button) return;
    if (button.dataset.periodMode) {
      periodMode = button.dataset.periodMode;
    } else if (button.dataset.selectDay) {
      selectedDate = button.dataset.selectDay;
      periodMode = "day";
    } else if (button.dataset.selectMonth !== undefined) {
      selectedDate = dateString(localDate(currentDate().getFullYear(), Number(button.dataset.selectMonth), 1));
      periodMode = "month";
    } else if (button.dataset.periodAction === "previous") {
      changePeriod(-1);
    } else if (button.dataset.periodAction === "next") {
      changePeriod(1);
    } else if (button.dataset.periodAction === "today") {
      selectedDate = localDateString();
      periodMode = "day";
    }
    savePeriod();
    render();
  });
  root.addEventListener("change", (event) => {
    const input = event.target.closest("[data-period-input]");
    if (!input) return;
    if (input.dataset.periodInput === "day" && validDate(input.value)) {
      selectedDate = input.value;
    } else if (input.dataset.periodInput === "month" && /^\d{4}-\d{2}$/.test(input.value)) {
      const date = new Date(`${input.value}-01T12:00:00`);
      if (!Number.isNaN(date.getTime()) && dateString(date).slice(0, 7) === input.value) selectedDate = dateString(date);
    } else if (input.dataset.periodInput === "year") {
      const year = Number(input.value);
      if (Number.isInteger(year) && year >= 1 && year <= 9999) selectedDate = dateString(localDate(year, 0, 1));
    }
    savePeriod();
    render();
  });
}

export async function mountPeriodDashboard() {
  root = document.querySelector("#period-dashboard");
  if (!root || unsubscribe) return;
  bindEvents();
  try {
    await refreshRecords();
    unsubscribe = subscribe(() => {
      refreshRecords().catch((error) => {
        console.error("تعذّر تحديث لوحة الفترات:", error);
        root.innerHTML = `<p class="period-dashboard-error" role="alert">تعذّر تحديث لوحة الفترات. أعد تحميل الصفحة للمحاولة مجدداً.</p>`;
      });
    });
  } catch (error) {
    console.error("تعذّر تحميل لوحة الفترات:", error);
    root.innerHTML = `<p class="period-dashboard-error" role="alert">تعذّر تحميل لوحة الفترات. أعد تحميل الصفحة للمحاولة مجدداً.</p>`;
  }
}

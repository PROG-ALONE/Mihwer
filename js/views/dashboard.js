import { getRecords, subscribe, update } from "../store.js";
import { formatDate, localDateString } from "../utils/dates.js";
import { getObjectiveProgress } from "../utils/okr.js";
import { dayProgress, setDayComplete } from "./habits.js";
import { showToast } from "../utils/notifications.js";

const DAY_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const WEEKDAY_SHORT_NAMES = DAY_NAMES;
const MONTH_NAMES = Array.from({ length: 12 }, (_, month) =>
  new Intl.DateTimeFormat("ar", { month: "long" }).format(new Date(2026, month, 1)));
const STORE_NAMES = ["tasks", "habits", "objectives", "keyResults", "sessions", "journal"];
const DASHBOARD_LAYOUT_VERSION = "today-home-v1";

const storedMode = localStorage.getItem("mihwar-dashboard-mode");
if (localStorage.getItem("mihwar-dashboard-layout") !== DASHBOARD_LAYOUT_VERSION) {
  if (storedMode === "month") {
    localStorage.setItem("mihwar-dashboard-mode", "day");
    localStorage.setItem("mihwar-dashboard-date", localDateString());
  }
  localStorage.setItem("mihwar-dashboard-layout", DASHBOARD_LAYOUT_VERSION);
}

let root;
let unsubscribe;
let records = { tasks: [], habits: [], objectives: [], keyResults: [], sessions: [], journal: [] };
let periodMode = ["day", "week", "month", "year"].includes(localStorage.getItem("mihwar-dashboard-mode"))
  ? localStorage.getItem("mihwar-dashboard-mode")
  : "day";
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
  const date = localDatePart(value);
  return date >= start && date <= end;
}

function localDatePart(value) {
  const text = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : localDateString(parsed);
}

function taskDateMatches(value, date) {
  return localDatePart(value) === date;
}

function isTaskPlannedOn(task, date) {
  return task.status !== "done" && (taskDateMatches(task.scheduled, date) || taskDateMatches(task.due, date));
}

function isTaskCompletedOn(task, date) {
  if (task.status !== "done") return false;
  if (task.completedAt) return taskDateMatches(task.completedAt, date);
  return taskDateMatches(task.scheduled, date) || taskDateMatches(task.due, date);
}

function taskIsPlannedInRange(task, start, end) {
  return task.status !== "done" && (dateWithin(task.scheduled, start, end) || dateWithin(task.due, start, end));
}

function taskIsCompletedInRange(task, start, end) {
  if (task.status !== "done") return false;
  if (task.completedAt) return dateWithin(task.completedAt, start, end);
  return dateWithin(task.scheduled, start, end) || dateWithin(task.due, start, end);
}

function periodBounds(mode = periodMode, date = currentDate()) {
  const year = date.getFullYear();
  const month = date.getMonth();
  if (mode === "week") {
    const startDate = localDate(year, month, date.getDate() - date.getDay());
    const endDate = localDate(year, month, startDate.getDate() + 6);
    return { start: dateString(startDate), end: dateString(endDate) };
  }
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
  if (periodMode === "week") {
    const bounds = periodBounds("week", date);
    return `${new Intl.DateTimeFormat("ar", { day: "numeric", month: "short" }).format(new Date(`${bounds.start}T12:00:00`))} — ${new Intl.DateTimeFormat("ar", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${bounds.end}T12:00:00`))}`;
  }
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
  const planned = records.tasks.filter((task) => isTaskPlannedOn(task, date));
  const completedTasks = records.tasks.filter((task) => isTaskCompletedOn(task, date));
  const habits = records.habits.filter((habit) => !habit.archived && isHabitScheduled(habit, date));
  const completedHabits = habits.filter((habit) => dayProgress(habit, date).complete).length;
  const focusMinutes = completedFocusMinutes(date, date);
  return {
    planned: planned.length,
    completed: completedTasks.length,
    taskProgress: planned.length + completedTasks.length
      ? Math.round(completedTasks.length / (planned.length + completedTasks.length) * 100)
      : 0,
    habitScheduled: habits.length,
    habitCompleted: completedHabits,
    focusMinutes,
    journalEntries: records.journal.filter((entry) => entry.date === date).length,
  };
}

function periodMetrics() {
  const { start, end } = periodBounds();
  const plannedTasks = records.tasks.filter((task) => taskIsPlannedInRange(task, start, end));
  const completedTasks = records.tasks.filter((task) => taskIsCompletedInRange(task, start, end));
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

function periodSummaryData(metrics) {
  const habitPercent = metrics.scheduled
    ? Math.round(metrics.completed / metrics.scheduled * 100)
    : 0;
  const taskTotal = metrics.completedTasks + metrics.plannedTasks;
  return [
    { title: "المهام", icon: "✓", value: metrics.completedTasks, suffix: "مكتملة", hint: `${metrics.plannedTasks} قيد الإنجاز`, progress: taskTotal ? Math.round(metrics.completedTasks / taskTotal * 100) : 0, tone: "tasks" },
    { title: "العادات", icon: "✦", value: metrics.completed, suffix: "مكتملة", hint: `${metrics.scheduled} مجدولة`, progress: habitPercent, tone: "habits" },
    { title: "التركيز", icon: "◉", value: metrics.focusMinutes, suffix: "دقيقة", hint: "جلسات مكتملة", progress: metrics.focusMinutes ? 100 : 0, tone: "focus" },
    { title: "الأهداف", icon: "◎", value: metrics.objectiveProgress, suffix: "إنجاز", hint: `${metrics.objectives} أهداف هذا العام`, progress: metrics.objectiveProgress, tone: "goals" },
    { title: "اليوميات", icon: "▤", value: metrics.journalEntries, suffix: "تدوينات", hint: "خلال هذه الفترة", progress: metrics.journalEntries ? 100 : 0, tone: "journal" },
  ];
}

function periodSummaryCards(metrics) {
  return periodSummaryData(metrics).map((card) => `<article class="period-summary-card" data-tone="${card.tone}" style="--card-progress:${card.progress}%">
    <header><span class="period-summary-icon" aria-hidden="true">${card.icon}</span><strong>${card.title}</strong></header>
    <div class="period-summary-value period-summary-chart" role="progressbar" aria-label="${escapeHtml(card.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${card.progress}">
      <div class="period-summary-chart-inner"><b data-count="${card.value}">٠</b><span>${card.suffix}</span></div>
    </div>
    <small>${card.hint}</small>
  </article>`).join("");
}

function renderDayDetails(date) {
  const metrics = metricsForDate(date);
  const planned = records.tasks.filter((task) => isTaskPlannedOn(task, date));
  const completed = records.tasks.filter((task) => isTaskCompletedOn(task, date));
  const focusSessions = records.sessions.filter((session) =>
    session.type !== "break" && dateWithin(session.start, date, date));
  const journal = records.journal.find((entry) => entry.date === date);
  const priorityLabels = ["عاجلة ومهمة", "مهمة", "عاجلة", "عادية"];
  const taskPriority = (task) => {
    const priority = Number(task.priority);
    if (Number.isInteger(priority) && priority >= 0 && priority < priorityLabels.length) {
      return priorityLabels[priority];
    }
    if (task.important && task.urgent) return priorityLabels[0];
    if (task.important) return priorityLabels[1];
    if (task.urgent) return priorityLabels[2];
    return priorityLabels[3];
  };
  const taskList = (items, empty) => items.length
    ? `<ul class="period-detail-list">${items.map((task) => {
      const taskTime = task.dueTime ? ` · ${escapeHtml(task.dueTime)}` : "";
      const status = task.status === "done" ? "مكتملة" : taskTime ? `موعد ${task.dueTime}` : "قيد الإنجاز";
      return `<li><a href="#/tasks"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(taskPriority(task))}${taskTime}</small></a><span>${status}</span></li>`;
    }).join("")}</ul>`
    : `<p class="period-empty">${empty}</p>`;
  const sessions = focusSessions.length
    ? `<ul class="period-detail-list">${focusSessions.map((session) => {
      const startTime = session.start?.slice(11, 16);
      const duration = Number(session.durationMin) || 0;
      return `<li><a href="#/focus"><strong>${session.taskId ? "جلسة مهمة" : session.habitId ? "جلسة عادة" : "تركيز حر"}</strong><small>${startTime ? `بدأت ${startTime}` : "جلسة اليوم"}</small></a><span>${session.status === "active" ? "نشطة" : `${duration} د`}</span></li>`;
    }).join("")}</ul>`
    : `<p class="period-empty">لا توجد جلسات تركيز مكتملة.</p>`;
  return `<div class="period-day-details">
    <section class="period-detail-card detail-tone-tasks"><header><h3>المهام</h3><span class="period-detail-icon">✓</span></header><div class="period-detail-stat"><strong data-count="${metrics.completed}">٠</strong><span>مكتملة</span><em>${metrics.planned} متبقية</em></div>${taskList(planned, "لا توجد مهام مجدولة.")}<details class="period-completed-details"><summary>عرض المنجزة (${completed.length})</summary>${taskList(completed, "لا توجد مهام منجزة.")}</details></section>
    <section class="period-detail-card detail-tone-focus"><header><h3>التركيز</h3><span class="period-detail-icon">◉</span></header><div class="period-detail-stat"><strong data-count="${metrics.focusMinutes}">٠</strong><span>دقيقة</span><em>${focusSessions.length} جلسات</em></div>${sessions}</section>
    <section class="period-detail-card detail-tone-journal"><header><h3>اليوميات</h3><span class="period-detail-icon">▤</span></header><div class="period-detail-stat"><strong data-count="${metrics.journalEntries}">٠</strong><span>تدوينات</span><em>${journal ? "تم التسجيل" : "لم تسجل بعد"}</em></div>${journal
      ? `<a class="period-journal-entry" href="#/journal"><strong>${escapeHtml(journal.title || "تدوينة اليوم")}</strong><span>${escapeHtml(journal.highlight || journal.text || "تم تسجيل تدوينة لهذا اليوم.")}</span></a>`
      : `<p class="period-empty">لا توجد تدوينة لهذا اليوم.</p>`}</section>
  </div>`;
}

function greetingForDate(date) {
  if (date !== localDateString()) return "خطة يومك";
  const hour = new Date().getHours();
  if (hour < 12) return "صباح الخير";
  if (hour < 17) return "نهارك سعيد";
  return "مساء الخير";
}

function messageForDate(date) {
  const messages = [
    "خطوة صغيرة اليوم تصنع فرقاً كبيراً غداً.",
    "استمر بهدوء؛ التقدم لا يحتاج إلى الكمال.",
    "امنح أهم ما لديك وقتاً، والباقي يأتي تباعاً.",
    "يكفي أن تبدأ. أكمل يومك على مهل.",
  ];
  return messages[Number(date.slice(-2)) % messages.length];
}

function progressTone(percent) {
  if (percent >= 100) return "progress-complete";
  if (percent >= 75) return "progress-high";
  if (percent >= 40) return "progress-medium";
  if (percent > 0) return "progress-low";
  return "progress-none";
}

function dailyProgress(metrics) {
  const total = metrics.planned + metrics.completed + metrics.habitScheduled;
  return total
    ? Math.round((metrics.completed + metrics.habitCompleted) / total * 100)
    : 0;
}

function renderWeekStrip(date, context = "اختر يوماً") {
  const sunday = localDate(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay());
  const days = Array.from({ length: 7 }, (_item, index) => {
    const day = localDate(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + index);
    const value = dateString(day);
    const selected = value === selectedDate;
    const metrics = metricsForDate(value);
    const complete = metrics.planned + metrics.completed > 0 && metrics.taskProgress === 100;
    const progress = dailyProgress(metrics);
    const tone = progressTone(progress);
    const today = value === localDateString();
    return `<button class="today-week-day ${tone}${today ? " is-today" : ""}${selected ? " is-selected" : ""}${complete ? " is-task-complete" : ""}" type="button" data-select-day="${value}" style="--day-progress:${progress}%" aria-pressed="${selected}" aria-label="${escapeHtml(formatDate(value))}">
      <span>${WEEKDAY_SHORT_NAMES[day.getDay()]}</span><strong>${day.getDate()}</strong>
    </button>`;
  }).join("");
  const overviewClass = context === "اختر يوماً لعرض تفاصيله" ? " today-week-picker--overview" : "";
  return `<nav class="today-week-picker${overviewClass}" aria-label="${escapeHtml(context)}">
    <button class="today-week-arrow" type="button" data-period-action="previous-week" aria-label="الأسبوع السابق">‹</button>
    <div class="today-week-content"><span class="today-week-caption">${escapeHtml(context)}</span><div class="today-week-days">${days}</div></div>
    <button class="today-week-arrow" type="button" data-period-action="next-week" aria-label="الأسبوع التالي">›</button>
  </nav>`;
}

function habitIcon(habit) {
  const title = String(habit.title ?? "");
  if (/ماء|شرب|ترطيب/.test(title)) return "💧";
  if (/قراءة|كتاب|كتب/.test(title)) return "📖";
  if (/رياضة|تمرين|جري|مشي/.test(title)) return "🏃";
  if (/صلاة|قرآن|ذكر/.test(title)) return "🙏";
  if (/نوم|راحة/.test(title)) return "🌙";
  return habit.kind === "quit" ? "✦" : "✧";
}

function renderTodayHabits(date, habits) {
  if (!habits.length) {
    return `<div class="today-habits-empty"><p>لا توجد عادات مجدولة لهذا اليوم.</p><a href="#/habits">استكشف عاداتك</a></div>`;
  }
  return habits.map((habit, index) => {
    const progress = dayProgress(habit, date);
    const complete = progress.complete;
    const progressText = progress.mode === "count"
      ? `${progress.done}/${progress.total}${habit.unit ? ` ${escapeHtml(habit.unit)}` : ""}`
      : progress.mode === "items"
        ? `${progress.done}/${progress.target} بند اليوم`
        : complete ? "اكتملت اليوم" : "خطوة صغيرة تكفي";
    return `<article class="today-habit-card tone-${index % 4}" data-habit-id="${escapeHtml(habit.id)}">
      <span class="today-habit-icon" aria-hidden="true">${habitIcon(habit)}</span>
      <a class="today-habit-info" href="#/habits"><strong>${escapeHtml(habit.title)}</strong><small>${progressText}</small></a>
      <button class="today-habit-toggle${complete ? " is-complete" : ""}" type="button" data-toggle-habit="${escapeHtml(habit.id)}" aria-pressed="${complete}" aria-label="${complete ? "إلغاء إنجاز" : "تسجيل إنجاز"} ${escapeHtml(habit.title)}">
        <span aria-hidden="true">${complete ? "✓" : ""}</span>
      </button>
    </article>`;
  }).join("");
}

function calmStatCards(metrics, tones = ["tasks", "habits", "focus", "journal"]) {
  return periodSummaryData(metrics)
    .filter((card) => tones.includes(card.tone))
    .map((card) => `<article class="today-calm-stat" data-tone="${card.tone}" style="--card-progress:${card.progress}%">
      <span class="today-calm-stat-icon" aria-hidden="true">${card.icon}</span>
      <div><strong>${card.title}</strong><span>${card.hint}</span></div>
      <b data-count="${card.value}">٠</b><small>${card.suffix}</small><i aria-hidden="true"></i>
    </article>`).join("");
}

function renderDailyHome(date) {
  const metrics = periodMetrics();
  const percent = periodCompletionPercent(metrics);

  return `<div class="today-day-content">
    <section class="today-calm-summary" aria-label="ملخص اليوم">
      <div class="today-calm-hero">
        <div><p class="today-section-kicker">ملخص اليوم</p><h3>${percent ? "إيقاعك واضح اليوم" : "مساحة هادئة لتبدأ"}</h3><span>${metrics.completedTasks} مهام · ${metrics.completed} عادات · ${metrics.focusMinutes} دقيقة تركيز</span></div>
        <div class="today-calm-score"><strong>${percent}<small>%</small></strong><span>إنجاز اليوم</span></div>
      </div>
      <div class="today-calm-stats">${calmStatCards(metrics)}</div>
    </section>
    <section class="today-message-card today-message-card--calm" aria-label="تذكير اليوم">
      <span class="today-message-icon" aria-hidden="true">✦</span>
      <div><span>تذكير اليوم</span><p>${messageForDate(date)}</p></div>
    </section>
    <nav class="today-calm-links" aria-label="اختصارات اليوم">
      <a href="#/journal"><span aria-hidden="true">▤</span><strong>التدوين</strong><small>سجّل لحظتك</small></a>
      <a href="#/focus"><span aria-hidden="true">◉</span><strong>التركيز</strong><small>ابدأ جلسة</small></a>
      <a href="#/goals"><span aria-hidden="true">◎</span><strong>الأهداف</strong><small>راجع اتجاهك</small></a>
      <a href="#/reports"><span aria-hidden="true">▥</span><strong>تقدّمي</strong><small>شاهد أرقامك</small></a>
    </nav>
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
    const complete = metrics.planned + metrics.completed > 0 && metrics.taskProgress === 100;
    const progress = dailyProgress(metrics);
    const tone = progressTone(progress);
    const today = dateValue === localDateString();
    return `<button class="period-day-cell ${tone}${today ? " is-today" : ""}${selected ? " is-selected" : ""}${hasActivity ? " has-activity" : ""}${complete ? " is-task-complete" : ""}" type="button" data-select-day="${dateValue}" style="--day-progress:${progress}%" aria-label="${escapeHtml(formatDate(dateValue))}: ${metrics.planned} مهام، ${metrics.habitCompleted} عادات مكتملة">
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
  const plannedTasks = records.tasks.filter((task) => taskIsPlannedInRange(task, start, end));
  const completedTasks = records.tasks.filter((task) => taskIsCompletedInRange(task, start, end));
  return {
    tasks: plannedTasks.length + completedTasks.length,
    plannedTasks: plannedTasks.length,
    completedTasks: completedTasks.length,
    focusMinutes: completedFocusMinutes(start, end),
  };
}

function renderPeriodContent() {
  const date = currentDate();
  if (periodMode === "year") return renderYearOverview(date);
  if (periodMode === "week") return renderWeekOverview(date);
  if (periodMode === "month") return renderMonthOverview(date);
  return renderDailyHome(selectedDate);
}

function periodCompletionPercent(metrics) {
  const taskTotal = metrics.completedTasks + metrics.plannedTasks;
  const total = taskTotal + metrics.scheduled;
  const completed = metrics.completedTasks + metrics.completed;
  return total ? Math.round(completed / total * 100) : 0;
}

function renderProgressHero(metrics, label) {
  const percent = periodCompletionPercent(metrics);
  return `<section class="period-progress-hero" aria-label="ملخص ${escapeHtml(label)}">
    <div class="period-progress-copy"><p class="today-section-kicker">إنجاز ${escapeHtml(label)}</p><h3>${percent ? "استمر، إيقاعك واضح" : "يلا نبدأ!"}</h3><span>${metrics.completedTasks} مهام · ${metrics.completed} عادات · ${metrics.focusMinutes} د تركيز</span>
      <div class="period-progress-pills"><b>${metrics.completedTasks} مهام مكتملة</b><b>${metrics.completed} عادات مكتملة</b><b>${metrics.journalEntries} تدوينات</b></div>
    </div>
    <div class="period-progress-score" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><strong>${percent}<small>%</small></strong><span>منجز</span><i style="--progress:${percent}%"></i></div>
  </section>`;
}

function renderPeriodStats(metrics, label) {
  return `<section class="period-summary-section" aria-label="إحصائيات ${escapeHtml(label)}">
    <header><div><p class="today-section-kicker">أرقام ${escapeHtml(label)}</p><h3>تفاصيل الفترة</h3></div><span>ملخص واحد بلا تكرار</span></header>
    <div class="today-calm-stats period-calm-stats">${calmStatCards(metrics, ["tasks", "habits", "focus", "goals", "journal"])}</div>
  </section>`;
}

function renderWeekOverview(date) {
  const { start, end } = periodBounds("week", date);
  const weekMetrics = periodMetrics();
  return `<section class="period-week-overview" aria-label="ملخص الأسبوع">
    ${renderProgressHero(weekMetrics, "الأسبوع")}
    ${renderPeriodStats(weekMetrics, "الأسبوع")}
    <header class="period-week-heading"><div><p class="today-section-kicker">إيقاع أسبوعك</p><h3>أسبوعك كامل بشاشة واحدة</h3></div><span>${escapeHtml(formatDate(start))} — ${escapeHtml(formatDate(end))}</span></header>
    ${renderWeekStrip(currentDate(), "اختر يوماً لعرض تفاصيله")}
  </section>`;
}

function renderMonthOverview(date) {
  const { start, end } = periodBounds("month", date);
  const metrics = periodMetrics();
  const days = [];
  const cursor = new Date(`${start}T12:00:00`);
  while (cursor <= new Date(`${end}T12:00:00`)) {
    const value = dateString(cursor);
    const day = metricsForDate(value);
    const total = day.completed + day.habitCompleted + day.planned;
    const complete = day.planned + day.completed > 0 && day.taskProgress === 100;
    const progress = dailyProgress(day);
    const tone = progressTone(progress);
    const today = value === localDateString();
    days.push(`<button class="period-activity-day ${tone}${today ? " is-today" : ""}${total ? " has-activity" : ""}${complete ? " is-task-complete" : ""}${value === selectedDate ? " is-selected" : ""}" type="button" data-select-day="${value}" aria-label="${escapeHtml(formatDate(value))}"><span>${cursor.getDate()}</span><i style="--day-progress:${progress}%"></i></button>`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return `<section class="period-long-overview" aria-label="ملخص الشهر">
    ${renderProgressHero(metrics, "الشهر")}
    ${renderPeriodStats(metrics, "الشهر")}
    <section class="period-activity-card"><header><div><p class="today-section-kicker">نشاط الشهر</p><h3>إيقاعك خلال الأيام</h3></div><span>${escapeHtml(formatPeriod())}</span></header>
      <div class="period-activity-grid">${days.join("")}</div>
    </section>
  </section>`;
}

function renderYearOverview(date) {
  const year = date.getFullYear();
  const monthCards = MONTH_NAMES.map((name, month) => {
    const start = dateString(localDate(year, month, 1));
    const end = dateString(localDate(year, month + 1, 0));
    const metrics = metricsForRange(start, end);
    const monthHabits = habitTotals(start, end);
    const total = metrics.tasks + monthHabits.scheduled;
    const completed = metrics.completedTasks + monthHabits.completed;
    const percent = total ? Math.round(completed / total * 100) : 0;
    const taskComplete = metrics.tasks > 0 && metrics.completedTasks === metrics.tasks;
    const currentMonth = date.getFullYear() === new Date().getFullYear() && month === new Date().getMonth();
    return `<button class="period-year-card ${progressTone(percent)}${currentMonth ? " is-current-month" : ""}${month === date.getMonth() ? " is-selected" : ""}${taskComplete ? " is-task-complete" : ""}" type="button" data-select-month="${month}"><strong>${name}</strong><span>${metrics.tasks} عناصر</span><i style="--month-progress:${percent}%"></i><small>${percent}% نشاط</small></button>`;
  }).join("");
  return `<section class="period-long-overview" aria-label="ملخص السنة">
    <section class="period-year-hero"><div><p class="today-section-kicker">إيقاع ${year}</p><h3>سنتك في لمحة</h3><span>تابع الأشهر النشطة بدل تقويم طويل.</span></div><strong>${year}</strong></section>
    ${renderPeriodStats(periodMetrics(), "السنة")}
    <section class="period-year-grid">${monthCards}</section>
  </section>`;
}

function changePeriod(delta) {
  const date = currentDate();
  if (periodMode === "year") date.setFullYear(date.getFullYear() + delta, 0, 1);
  else if (periodMode === "week") date.setDate(date.getDate() + delta * 7);
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
  const modeNames = { day: "اليوم", week: "الأسبوع", month: "الشهر", year: "السنة" };
  const isDaily = periodMode === "day";
  root.innerHTML = `<section class="period-dashboard${isDaily ? " period-dashboard--today" : ""}" aria-label="لوحة الفترات">
    <header class="period-dashboard-heading">
      <div><p class="today-kicker">${isDaily ? "مساحتك الهادئة" : "لوحتك المختصرة"}</p><h2>${escapeHtml(isDaily ? greetingForDate(selectedDate) : formatPeriod())}</h2>${isDaily ? `<p class="today-header-date">${escapeHtml(formatPeriod())}</p>` : ""}</div>
      <button class="period-today-button" type="button" data-period-action="today">اليوم</button>
    </header>
    <nav class="period-mode-switch" aria-label="طريقة عرض التاريخ">
      ${Object.entries(modeNames).map(([mode, label]) => `<button type="button" data-period-mode="${mode}" aria-pressed="${periodMode === mode}">${label}</button>`).join("")}
    </nav>
    ${isDaily ? renderWeekStrip(currentDate(), "تنقّل سريع بين الأيام") : `
      <div class="period-controls">
        <button class="period-arrow" type="button" data-period-action="previous" aria-label="الفترة السابقة">‹</button>
        ${periodInput()}
        <button class="period-arrow" type="button" data-period-action="next" aria-label="الفترة التالية">›</button>
      </div>
      <div class="period-content">${renderPeriodContent()}</div>
    `}
    ${isDaily ? `<div class="period-content">${renderPeriodContent()}</div>` : ""}
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
  root.addEventListener("click", async (event) => {
    const habitToggle = event.target.closest("[data-toggle-habit]");
    if (habitToggle) {
      const habit = records.habits.find((item) => item.id === habitToggle.dataset.toggleHabit);
      if (!habit) return;
      const complete = dayProgress(habit, selectedDate).complete;
      try {
        await update("habits", setDayComplete(habit, selectedDate, !complete));
        showToast(complete ? "أُزيل تسجيل العادة." : "تم تسجيل العادة لليوم المحدد.");
      } catch (error) {
        console.error("تعذّر تحديث العادة من لوحة اليوم:", error);
        showToast("تعذّر تحديث العادة. حاول مجدداً.", { isError: true });
      }
      return;
    }

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
    } else if (button.dataset.periodAction === "previous-week") {
      changePeriod(-7);
    } else if (button.dataset.periodAction === "next-week") {
      changePeriod(7);
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

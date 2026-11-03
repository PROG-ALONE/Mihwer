import { getRecords, subscribe } from "../store.js";
import { localDateString } from "../utils/dates.js";
import { showToast } from "../utils/notifications.js";
import { getKeyResultProgress } from "../utils/okr.js";
import { getPlanConfig } from "../utils/plans.js";
import { dayProgress } from "./habits.js";
import { downloadCsv } from "../export/csv.js";
import { downloadXlsx } from "../export/xlsx.js";
import { printReport } from "../export/pdf.js";

const DAY_MS = 86_400_000;
const DATE_RANGES = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 90,
  year: 365,
};
const PLAN_RANGE_DAYS = { monthly: 30, quarterly: 90, trimester: 120 };
const EXPORT_SCOPE_LABELS = {
  all: "كل الأقسام",
  tasks: "المهام بالتفصيل",
  objectives: "الأهداف والنتائج ومهامها",
  habits: "العادات وسجلها",
  sessions: "جلسات التركيز",
  journal: "اليوميات",
  reviews: "المراجعات",
  projects: "المشاريع",
};

let unsubscribe;
let eventController;
let records = { tasks: [], projects: [], objectives: [], keyResults: [], lifeAreas: [], habits: [], sessions: [], journal: [], reviews: [], profile: [] };
let range = "month";
let customStart = localDateString(new Date(Date.now() - 29 * DAY_MS));
let customEnd = localDateString();
let exportScope = "all";
let projectId = "";
let objectiveId = "";
let lifeAreaId = "";
let plan = getPlanConfig("quarterly");

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function dateRange() {
  if (range === "all") return { start: "0001-01-01", end: "9999-12-31" };
  if (range === "custom") return { start: customStart, end: customEnd };
  const end = new Date();
  const days = range === "plan" ? PLAN_RANGE_DAYS[plan.id] : DATE_RANGES[range];
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days ?? 30) + 1);
  return { start: localDateString(start), end: localDateString(end) };
}

function inRange(value, start, end) {
  const date = String(value ?? "").slice(0, 10);
  return date >= start && date <= end;
}

function objectiveForTask(task) {
  return records.objectives.find((objective) => objective.id === task.objectiveId) ??
    records.objectives.find((objective) => records.keyResults.some((result) => result.id === task.keyResultId && result.objectiveId === objective.id));
}

function matchesTaskFilters(task) {
  if (projectId && task.projectId !== projectId) return false;
  if (objectiveId && task.objectiveId !== objectiveId &&
    !records.keyResults.some((result) => result.objectiveId === objectiveId && result.id === task.keyResultId)) return false;
  if (lifeAreaId && objectiveForTask(task)?.lifeAreaId !== lifeAreaId) return false;
  return true;
}

function matchesHabitFilters(habit) {
  if (objectiveId && habit.objectiveId !== objectiveId) return false;
  const objective = records.objectives.find((item) => item.id === habit.objectiveId);
  if (lifeAreaId && objective?.lifeAreaId !== lifeAreaId) return false;
  if (projectId && !records.projects.some((project) => project.id === projectId && project.objectiveId === habit.objectiveId)) return false;
  return true;
}

function matchesFocusFilters(session) {
  if (!(projectId || objectiveId || lifeAreaId)) return true;
  const task = records.tasks.find((item) => item.id === session.taskId);
  const habit = records.habits.find((item) => item.id === session.habitId);
  return task ? matchesTaskFilters(task) : habit ? matchesHabitFilters(habit) : false;
}

function filteredTasks() {
  const { start, end } = dateRange();
  return records.tasks.filter((task) => {
    const taskDates = [task.completedAt, task.due, task.scheduled, task.createdAt].filter(Boolean);
    return taskDates.some((date) => inRange(date, start, end)) && matchesTaskFilters(task);
  });
}

function scheduledDays(habit, start, end) {
  const schedule = habit.schedule;
  let days;
  if (schedule === "weekdays") days = new Set([1, 2, 3, 4, 5]);
  else if (schedule === "weekends") days = new Set([0, 6]);
  else if (Array.isArray(schedule)) {
    const weekdayNumbers = new Map(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map((day, index) => [day, index]));
    days = new Set(schedule.map((day) => Number.isInteger(Number(day)) ? Number(day) : weekdayNumbers.get(String(day).toLowerCase())).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6));
  } else days = new Set([0, 1, 2, 3, 4, 5, 6]);
  const dates = [];
  const cursor = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  while (cursor <= last && dates.length < 366) {
    if (days.has(cursor.getDay())) dates.push(localDateString(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function habitConsistency(habit, start, end) {
  const schedule = habit.schedule;
  let weekdays;
  if (schedule === "weekdays") weekdays = new Set([1, 2, 3, 4, 5]);
  else if (schedule === "weekends") weekdays = new Set([0, 6]);
  else if (Array.isArray(schedule)) {
    const names = new Map(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map((day, index) => [day, index]));
    weekdays = new Set(schedule.map((day) => Number.isInteger(Number(day)) ? Number(day) : names.get(String(day).toLowerCase())).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6));
  } else weekdays = new Set([0, 1, 2, 3, 4, 5, 6]);
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  const totalDays = Math.max(0, Math.floor((endTime - startTime) / DAY_MS) + 1);
  const fullWeeks = Math.floor(totalDays / 7);
  let scheduled = fullWeeks * weekdays.size;
  const cursor = new Date(`${start}T00:00:00Z`);
  for (let offset = 0; offset < totalDays % 7; offset += 1) {
    if (weekdays.has((cursor.getUTCDay() + offset) % 7)) scheduled += 1;
  }
  const history = Array.isArray(habit.history)
    ? habit.history
    : Object.keys(habit.history ?? {}).filter((date) => habit.history[date]);
  const loggedDates = new Set([
    ...history,
    ...Object.keys(habit.progress ?? {}),
    ...Object.keys(habit.itemLog ?? {}),
  ]);
  const completed = [...loggedDates].filter((date) => inRange(date, start, end) &&
    weekdays.has(new Date(`${date}T12:00:00`).getDay()) &&
    dayProgress(habit, date).complete).length;
  return { scheduled, completed, percent: scheduled ? Math.round(completed / scheduled * 100) : 0 };
}

function reportSessions(start, end) {
  return records.sessions.filter((session) =>
    session.status === "completed" &&
    session.type !== "break" &&
    inRange(session.start, start, end) &&
    matchesFocusFilters(session));
}

function rangeForCharts() {
  const selected = dateRange();
  const end = range === "all" ? localDateString() : selected.end;
  const endDate = new Date(`${end}T12:00:00`);
  const days = Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${selected.start}T00:00:00Z`)) / DAY_MS) + 1;
  if (range === "all" || days > 366) {
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 364);
    return { start: localDateString(startDate), end };
  }
  return selected;
}

function reportSummary(tasks, start, end) {
  const completedTasks = tasks.filter((task) => task.status === "done" && inRange(task.completedAt, start, end)).length;
  const sessions = reportSessions(start, end);
  const focusMinutes = sessions.reduce((sum, session) => sum + Math.max(0, Number(session.durationMin) || 0), 0);
  const habits = records.habits.filter((habit) => !habit.archived && matchesHabitFilters(habit));
  const habitStats = habits.map((habit) => habitConsistency(
    habit,
    range === "all" ? habit.createdAt?.slice(0, 10) ?? start : start,
    range === "all" ? localDateString() : end,
  ));
  const habitScheduled = habitStats.reduce((sum, habit) => sum + habit.scheduled, 0);
  const habitCompleted = habitStats.reduce((sum, habit) => sum + habit.completed, 0);
  const habitCompletion = habitScheduled
    ? Math.round(habitCompleted / habitScheduled * 100)
    : 0;
  const objectives = records.objectives.filter((objective) =>
    objective.status !== "archived" &&
    (!objectiveId || objective.id === objectiveId) &&
    Number(objective.year) >= new Date(`${start}T12:00:00`).getFullYear() &&
    Number(objective.year) <= new Date(`${end}T12:00:00`).getFullYear() &&
    (!lifeAreaId || objective.lifeAreaId === lifeAreaId) &&
    (!projectId || records.projects.some((project) => project.id === projectId && project.objectiveId === objective.id)));
  const objectiveProgress = objectives.map((objective) => {
    const results = records.keyResults.filter((result) => result.objectiveId === objective.id);
    return results.length
      ? results.reduce((sum, result) => sum + getKeyResultProgress(result), 0) / results.length
      : 0;
  });
  const journalEntries = records.journal.filter((entry) => inRange(entry.date, start, end));
  const moodEntries = journalEntries.filter((entry) => Number(entry.mood) >= 1 && Number(entry.mood) <= 5);
  const averageMood = moodEntries.length
    ? (moodEntries.reduce((sum, entry) => sum + Number(entry.mood), 0) / moodEntries.length).toFixed(1)
    : "—";
  return {
    taskCount: tasks.length,
    completedTasks,
    completionRate: tasks.length ? Math.round(completedTasks / tasks.length * 100) : 0,
    focusMinutes,
    sessionCount: sessions.length,
    habitCompletion,
    habitCount: habits.length,
    objectiveProgress: objectiveProgress.length
      ? Math.round(objectiveProgress.reduce((sum, value) => sum + value, 0) / objectiveProgress.length)
      : 0,
    objectiveCount: objectives.length,
    journalCount: journalEntries.length,
    averageMood,
  };
}

function renderSummaryCards(sections, activityTotal) {
  const stats = [
    { label: "المهام", value: `${sections.tasks.metrics[1].value}/${sections.tasks.metrics[0].value}`, detail: `${sections.tasks.metrics[2].value} مفتوحة`, percent: sections.tasks.metrics[1].percent, tone: "primary" },
    { label: "الأهداف والنتائج", value: sections.objectives.metrics[0].value, detail: `${sections.objectives.metrics[3].value} نتيجة رئيسية`, tone: "blue" },
    { label: "العادات", value: sections.habits.metrics[0].value, detail: `${sections.habits.metrics[3].value} ثبات`, percent: sections.habits.metrics[3].percent, tone: "gold" },
    { label: "التركيز", value: sections.focus.metrics[1].value, detail: `${sections.focus.metrics[0].value} جلسات`, tone: "accent" },
    { label: "اليوميات", value: sections.journal.metrics[0].value, detail: `${sections.journal.metrics[2].value} متوسط المزاج`, tone: "rose" },
    { label: "المراجعات", value: sections.reviews.metrics[0].value, detail: "مراجعات محفوظة", tone: "blue" },
    { label: "المشاريع", value: sections.projects.metrics[0].value, detail: `${sections.projects.metrics[1].value} نشطة`, tone: "primary" },
    { label: "النشاط", value: activityTotal, detail: "إنجازات وجلسات وعادات", tone: "accent" },
  ];
  return `<section class="report-overview" aria-label="مؤشرات جميع الأقسام"><h3>مؤشرات جميع الأقسام</h3><div class="report-summary-grid">${stats.map((stat) => `
    <article class="report-stat-card tone-${stat.tone}${stat.label === "العادات" ? " has-ring" : ""}"${stat.label === "العادات" ? ` style="--report-progress:${stat.percent}%;"` : ""}>
      <div class="report-stat-top"><span>${stat.label}</span><span class="report-stat-dot" aria-hidden="true"></span></div>
      <div class="report-stat-value"><strong>${escapeHtml(stat.value)}</strong></div>
      ${stat.label === "العادات" ? `<div class="report-stat-ring" role="img" aria-label="الالتزام بالعادات ${stat.percent}%"><span>${stat.percent}%</span></div>` : ""}
      ${Number.isFinite(stat.percent) ? `<div class="report-stat-track" role="progressbar" aria-label="${stat.label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${stat.percent}"><span style="width:${stat.percent}%"></span></div>` : ""}
      <p>${escapeHtml(stat.detail)}</p>
    </article>`).join("")}</div></section>`;
}

function renderActivityHeatmap(activity) {
  if (!activity.length) return "";
  const total = activity.reduce((sum, day) => sum + day.value, 0);
  const cells = activity.map((day) => {
    const intensity = day.value === 0 ? 0 : day.value < 2 ? 1 : day.value < 4 ? 2 : day.value < 6 ? 3 : 4;
    return { ...day, intensity };
  });
  return `<section class="report-activity-card">
    <div class="report-section-heading"><div><p class="goals-kicker">النشاط اليومي</p><h3>خريطة النشاط</h3><span>المهام والعادات وجلسات التركيز خلال الفترة</span></div><strong>${total} نشاط</strong></div>
    <div class="report-heatmap-scroll" role="img" aria-label="خريطة النشاط اليومي: ${total} نشاط خلال ${activity.length} يوماً">
      <div class="report-heatmap">${cells.map((day) => `<span class="report-heat-cell heat-level-${day.intensity}" title="${day.date} · ${day.value} نشاط" aria-label="${day.date}: ${day.value} نشاط"></span>`).join("")}</div>
    </div>
    <div class="report-heatmap-legend"><span>أقل</span>${[0, 1, 2, 3, 4].map((level) => `<i class="heat-level-${level}" aria-hidden="true"></i>`).join("")}<span>أكثر</span></div>
  </section>`;
}

function svgLineChart(values, label, color = "var(--color-primary)") {
  const normalizedValues = values.filter((item) => Number.isFinite(Number(item.value)))
    .map((item) => ({ ...item, value: Number(item.value) }));
  const chartValues = normalizedValues.length > 56
    ? Array.from({ length: Math.ceil(normalizedValues.length / 7) }, (_item, index) => {
      const week = normalizedValues.slice(index * 7, index * 7 + 7);
      return {
        label: week.at(-1).label,
        value: week.reduce((sum, item) => sum + item.value, 0) / week.length,
        period: week.length,
      };
    })
    : normalizedValues;
  if (!chartValues.length) return `<p class="report-empty">لا توجد بيانات ضمن الفترة المحددة.</p>`;
  const width = 640;
  const height = 190;
  const pad = 24;
  const maxValue = Math.max(1, ...chartValues.map((item) => item.value));
  const chartX = (index) => chartValues.length <= 1
    ? pad
    : pad + index * (width - pad * 2) / (chartValues.length - 1);
  const points = chartValues.map((item, index) => {
    const x = chartX(index);
    const y = height - pad - (item.value / maxValue) * (height - pad * 2);
    return `${x},${y}`;
  }).join(" ");
  const labels = chartValues.filter((_item, index) => index === 0 || index === chartValues.length - 1 || index % Math.max(1, Math.floor(chartValues.length / 5)) === 0);
  const [startX] = points.split(" ")[0].split(",");
  const [lastX] = points.split(" ").at(-1).split(",");
  const areaPoints = `${startX},${height - pad} ${points} ${lastX},${height - pad}`;
  return `<svg class="report-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}">
    ${[0, 1, 2, 3].map((line) => {
      const y = pad + line * (height - pad * 2) / 3;
      return `<line x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}" stroke="var(--color-border)" stroke-dasharray="${line === 3 ? "0" : "3 5"}"/>`;
    }).join("")}
    <polygon points="${areaPoints}" fill="color-mix(in srgb, ${color} 13%, transparent)"/>
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${chartValues.map((item, index) => {
      const x = chartX(index);
      const y = height - pad - (item.value / maxValue) * (height - pad * 2);
      const value = Number.isInteger(item.value) ? item.value : item.value.toFixed(1);
      return `<circle cx="${x}" cy="${y}" r="3.5" fill="${color}"><title>${item.period ? `متوسط ${item.period} أيام حتى ${escapeHtml(item.label)}` : escapeHtml(item.label)}: ${value}</title></circle>`;
    }).join("")}
    ${labels.map((item) => {
      const index = chartValues.indexOf(item);
      const x = chartX(index);
      return `<text x="${x}" y="${height - 4}" text-anchor="middle" fill="var(--color-muted)" font-size="10">${escapeHtml(item.label)}</text>`;
    }).join("")}
  </svg>`;
}

function svgBarChart(entries, label, suffix = "") {
  if (!entries.length) return `<p class="report-empty">لا توجد بيانات ضمن الفلاتر الحالية.</p>`;
  const maxValue = Math.max(1, ...entries.map((item) => item.value));
  return `<div class="report-bars" role="img" aria-label="${escapeHtml(label)}">${entries.map((item) => `
    <div class="report-bar-row"><span title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span><div><i style="width:${Math.max(item.value ? 3 : 0, (item.value / maxValue) * 100)}%"></i></div><strong>${item.value}${suffix}</strong></div>`).join("")}</div>`;
}

function dailyCompletions(tasks, start, end) {
  const days = [];
  const cursor = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  while (cursor <= last && days.length < 366) {
    const date = localDateString(cursor);
    const count = tasks.filter((task) => task.status === "done" && task.completedAt?.slice(0, 10) === date).length;
    days.push({ date, value: count, label: new Intl.DateTimeFormat("ar", { day: "numeric", month: "short" }).format(cursor) });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function renderSectionMetrics(metrics) {
  return `<div class="report-section-stat-grid">${metrics.map((metric) => `
    <article class="report-section-stat">
      <span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(metric.value)}</strong>
      <small>${escapeHtml(metric.detail ?? "")}</small>
      ${Number.isFinite(metric.percent) ? `<div class="report-stat-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${metric.percent}"><span style="width:${metric.percent}%"></span></div>` : ""}
    </article>`).join("")}</div>`;
}

function renderEntityCards(details) {
  if (!details?.length) return `<p class="report-empty">لا توجد سجلات تفصيلية لهذا القسم ضمن الفترة المحددة.</p>`;
  return `<div class="report-entity-grid">${details.map((item) => `
    <article class="report-entity-card">
      <div class="report-entity-heading"><strong>${escapeHtml(item.title)}</strong><b>${escapeHtml(item.value)}</b></div>
      <p>${escapeHtml(item.detail ?? "")}</p>
      ${item.metrics?.length ? `<div class="report-entity-metrics">${item.metrics.map((metric) => `<span><small>${escapeHtml(metric.label)}</small><strong>${escapeHtml(metric.value)}</strong>${Number.isFinite(metric.percent) ? `<i style="width:${metric.percent}%"></i>` : ""}</span>`).join("")}</div>` : ""}
      ${item.children?.length ? `<details class="report-nested-details"><summary>تفاصيل البنود والكميات <span>${item.children.length}</span></summary><div class="report-nested-list">${item.children.map((child) => `<article><div><strong>${escapeHtml(child.label)}</strong><span>${escapeHtml(child.detail ?? "")}</span></div><b>${escapeHtml(child.value)}</b>${child.metrics?.map((metric) => `<small>${escapeHtml(metric.label)}: ${escapeHtml(metric.value)}</small>`).join("") ?? ""}</article>`).join("")}</div></details>` : ""}
    </article>`).join("")}</div>`;
}

function renderReportCharts(tasks) {
  const analytics = buildExportAnalytics(tasks);
  const sectionOrder = ["tasks", "objectives", "habits", "focus", "journal", "reviews", "projects"];
  const sections = sectionOrder.map((key) => {
    const section = analytics.sections[key];
    const charts = analytics.charts.filter((chart) => chart.section === key);
    return `<section class="report-analytics-section" aria-label="${escapeHtml(section.label)}">
      <header class="report-analytics-heading"><div><p class="goals-kicker">إحصاءات القسم</p><h3>${escapeHtml(section.label)}</h3></div><span>${section.details.length} سجل</span></header>
      ${renderSectionMetrics(section.metrics)}
      ${charts.length ? `<div class="reports-grid">${charts.map((chart) => `<article class="today-panel report-card">
        <div class="report-card-heading"><h4>${escapeHtml(chart.title)}</h4><span>${chart.values.length} عناصر</span></div>
        ${chart.type === "line" ? svgLineChart(chart.values, chart.title, key === "journal" ? "var(--color-accent)" : "var(--color-primary)") : svgBarChart(chart.values, chart.title, chart.unit === "%" ? "%" : ` ${chart.unit}`)}
      </article>`).join("")}</div>` : ""}
      <details class="report-entity-details"><summary>التفاصيل والمجاميع لكل سجل <span>${section.details.length}</span></summary>${renderEntityCards(section.details)}</details>
    </section>`;
  }).join("");
  return `${renderSummaryCards(analytics.sections, analytics.activity.reduce((sum, day) => sum + day.value, 0))}${renderActivityHeatmap(analytics.activity)}${sections}`;
}

function render() {
  const app = document.querySelector("#app");
  if (!app) return;
  const tasks = filteredTasks();
  const { start, end } = dateRange();
  app.innerHTML = `
    <section class="reports-page" aria-label="تقدّمي">
      <header class="reports-heading"><div><p class="goals-kicker">رحلتك بالأرقام</p><h2>تقدّمي</h2></div><details class="report-exports"><summary>تصدير التقرير</summary><div class="report-export-menu">
        <p class="report-export-title">اختر الصيغة المناسبة</p>
        <button class="report-export-option" type="button" data-export="excel"><strong>Excel</strong><span>جداول مرتبة ورسوم قابلة للتحليل</span></button>
        <button class="report-export-option" type="button" data-export="csv"><strong>CSV</strong><span>أرقام وتفاصيل قابلة للفتح في أي جدول</span></button>
        <button class="report-export-option" type="button" data-export="json"><strong>JSON</strong><span>بيانات كاملة للاحتفاظ أو التكامل</span></button>
        <button class="report-export-option is-primary" type="button" data-export="pdf"><strong>طباعة / PDF</strong><span>نسخة مرئية جاهزة للمشاركة</span></button>
      </div></details></header>
      <section class="today-panel reports-filters">
        <label>الفترة<select id="report-range">
          <option value="day"${range === "day" ? " selected" : ""}>اليوم</option><option value="week"${range === "week" ? " selected" : ""}>أسبوع</option><option value="month"${range === "month" ? " selected" : ""}>شهر</option><option value="quarter"${range === "quarter" ? " selected" : ""}>ربع سنة</option><option value="year"${range === "year" ? " selected" : ""}>سنة</option><option value="plan"${range === "plan" ? " selected" : ""}>فترة التخطيط (${plan.columns.length} فترات)</option><option value="custom"${range === "custom" ? " selected" : ""}>مخصص</option><option value="all"${range === "all" ? " selected" : ""}>كامل الفترة</option>
        </select></label>
        ${range === "custom" ? `<label>من<input id="report-start" type="date" value="${start}"></label><label>إلى<input id="report-end" type="date" value="${end}"></label>` : ""}
        <label>القسم للتصدير<select id="report-export-scope">
          <option value="all"${exportScope === "all" ? " selected" : ""}>كل الأقسام</option>
          <option value="tasks"${exportScope === "tasks" ? " selected" : ""}>المهام بالتفصيل</option>
          <option value="objectives"${exportScope === "objectives" ? " selected" : ""}>الأهداف والنتائج ومهامها</option>
          <option value="habits"${exportScope === "habits" ? " selected" : ""}>العادات وسجلها</option>
          <option value="sessions"${exportScope === "sessions" ? " selected" : ""}>جلسات التركيز</option>
          <option value="journal"${exportScope === "journal" ? " selected" : ""}>اليوميات</option>
          <option value="reviews"${exportScope === "reviews" ? " selected" : ""}>المراجعات</option>
          <option value="projects"${exportScope === "projects" ? " selected" : ""}>المشاريع</option>
        </select></label>
        <label>المجال<select id="report-area"><option value="">كل المجالات</option>${records.lifeAreas.filter((area) => !area.archived).map((area) => `<option value="${escapeHtml(area.id)}"${lifeAreaId === area.id ? " selected" : ""}>${escapeHtml(area.name)}</option>`).join("")}</select></label>
        <label>المشروع<select id="report-project"><option value="">كل المشاريع</option>${records.projects.filter((project) => !project.archived).map((project) => `<option value="${escapeHtml(project.id)}"${projectId === project.id ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}</select></label>
        <label>الهدف<select id="report-objective"><option value="">كل الأهداف</option>${records.objectives.filter((objective) => objective.status !== "archived").map((objective) => `<option value="${escapeHtml(objective.id)}"${objectiveId === objective.id ? " selected" : ""}>${escapeHtml(objective.title)}</option>`).join("")}</select></label>
      </section>
      <div class="report-period-label">${range === "all" ? "كامل الفترة · المخططات تعرض آخر 12 شهراً" : `${escapeHtml(start)} — ${escapeHtml(end)}`} · ${tasks.filter((task) => task.status === "done").length} مهام مكتملة · ${escapeHtml(EXPORT_SCOPE_LABELS[exportScope])}</div>
      ${renderReportCharts(tasks)}
      <details class="report-table-details">
        <summary>سجل المهام بالتفصيل <span>${tasks.length} مهمة</span></summary>
        <section class="today-panel report-table-wrap">${tasks.length ? `<table class="report-table"><thead><tr><th>المهمة</th><th>الحالة</th><th>التاريخ</th><th>الوقت</th><th>الدقائق</th><th>المشروع</th></tr></thead><tbody>${tasks.slice().sort((a, b) => (b.completedAt ?? b.due ?? "").localeCompare(a.completedAt ?? a.due ?? "")).map((task) => `<tr><td>${escapeHtml(task.title)}</td><td>${task.status === "done" ? "مكتملة" : "مفتوحة"}</td><td>${escapeHtml((task.completedAt ?? task.due ?? task.scheduled ?? "").slice(0, 10))}</td><td>${escapeHtml(task.dueTime ?? "—")}</td><td>${Number(task.timeSpentMin ?? 0)}</td><td>${escapeHtml(records.projects.find((project) => project.id === task.projectId)?.name ?? "—")}</td></tr>`).join("")}</tbody></table>` : `<p class="report-empty">لا توجد مهام ضمن هذه الفترة والفلاتر.</p>`}</section>
      </details>
      <p class="reports-status" role="status" aria-live="polite"></p>
    </section>`;
  bindEvents(app);
}

function taskRows(tasks) {
  const headers = [
    "المعرّف", "العنوان", "الوصف والملاحظات", "الحالة", "تاريخ الإنشاء", "آخر تحديث",
    "تاريخ الجدولة", "الموعد النهائي", "وقت التنفيذ", "تاريخ الإنجاز", "مهم", "عاجل",
    "الوقت المتوقع بالدقائق", "الوقت المنفق بالدقائق", "الوسوم",
    "المشروع", "معرّف المشروع", "الهدف", "معرّف الهدف", "النتيجة الرئيسية", "معرّف النتيجة",
    "التكرار", "المهام الفرعية", "الترتيب",
  ];
  return {
    name: "المهام",
    rows: [headers, ...tasks.map((task) => [
      task.id, task.title, task.notes, task.status, task.createdAt, task.updatedAt,
      task.scheduled, task.due, task.dueTime, task.completedAt, Boolean(task.important), Boolean(task.urgent),
      task.estimateMin, task.timeSpentMin, (task.tags ?? []).join("، "),
      records.projects.find((item) => item.id === task.projectId)?.name ?? "", task.projectId,
      objectiveForTask(task)?.title ?? "", objectiveForTask(task)?.id ?? "",
      records.keyResults.find((item) => item.id === task.keyResultId)?.title ?? "", task.keyResultId,
      task.recurrence,
      (task.checklist ?? []).map((item) => typeof item === "string"
        ? `○ ${item}` : `${item.done ? "✓" : "○"} ${item.text}`).join("\n"),
      task.order,
    ])],
  };
}

function buildExportSheets(tasks) {
  const { start, end } = dateRange();
  const objectives = records.objectives.filter((objective) =>
    objective.status !== "archived" &&
    (range === "all" || (
      Number(objective.year) >= new Date(`${start}T12:00:00`).getFullYear() &&
      Number(objective.year) <= new Date(`${end}T12:00:00`).getFullYear()
    )) &&
    (!objectiveId || objective.id === objectiveId) &&
    (!lifeAreaId || objective.lifeAreaId === lifeAreaId) &&
    (!projectId || records.projects.some((project) => project.id === projectId && project.objectiveId === objective.id)));
  const objectiveIds = new Set(objectives.map((objective) => objective.id));
  const objectiveTasks = tasks.filter((task) => {
    const objective = objectiveForTask(task);
    return objective && objectiveIds.has(objective.id);
  });
  const sessions = records.sessions.filter((session) => {
    if (!inRange(session.start ?? session.createdAt, start, end)) return false;
    return matchesFocusFilters(session);
  });
  const habits = records.habits.filter(matchesHabitFilters);
  const habitConfigs = {
    name: "العادات",
    rows: [["المعرّف", "العادة", "الوصف", "النوع", "طريقة التتبع", "الجدول", "الهدف اليومي", "وحدة الهدف", "هدف البنود يومياً", "مدة التركيز المستهدفة", "وقت التركيز المسجل", "بنود العادة بالتفصيل", "الهدف المرتبط", "مؤرشفة", "تاريخ الإنشاء", "آخر تحديث"],
      ...habits.map((habit) => [
        habit.id, habit.title, habit.description, habit.kind, habit.mode,
        Array.isArray(habit.schedule) ? habit.schedule.join("، ") : habit.schedule,
        habit.targetPerDay, habit.unit, habit.targetItemsPerDay, habit.focusDurationMin, habit.focusSpentMin,
        (habit.items ?? []).map((item) => `${item.category ?? "عام"} | ${item.name} | ${item.amount ?? ""} ${item.unit ?? ""}`).join("\n"),
        records.objectives.find((item) => item.id === habit.objectiveId)?.title ?? "",
        Boolean(habit.archived), habit.createdAt, habit.updatedAt,
      ])],
  };
  const habitLogs = {
    name: "سجل العادات",
    rows: [["معرّف العادة", "العادة", "التاريخ", "مكتملة", "العدد", "هدف العدد", "البنود المنجزة", "تفاصيل البنود"]],
  };
  for (const habit of habits) {
    const history = Array.isArray(habit.history)
      ? Object.fromEntries(habit.history.map((date) => [date, true]))
      : habit.history ?? {};
    const dates = new Set([
      ...Object.keys(history),
      ...Object.keys(habit.progress ?? {}),
      ...Object.keys(habit.itemLog ?? {}),
    ].filter((date) => inRange(date, start, end)));
    for (const date of [...dates].sort()) {
      const itemLog = new Set(habit.itemLog?.[date] ?? []);
      const completedItems = (habit.items ?? []).filter((item) => itemLog.has(item.id));
      habitLogs.rows.push([
        habit.id, habit.title, date, Boolean(history[date]),
        habit.progress?.[date] ?? "", habit.targetPerDay ?? "",
        completedItems.map((item) => item.name).join("، "),
        completedItems.map((item) => `${item.category ?? "عام"} | ${item.name} | ${item.amount ?? ""} ${item.unit ?? ""}`).join("\n"),
      ]);
    }
  }
  const journal = records.journal.filter((entry) => inRange(entry.date, start, end));
  const reviews = records.reviews.filter((review) => {
    const stamp = review.date ?? review.createdAt ?? review.updatedAt;
    return range === "all" || inRange(stamp, start, end);
  });
  const projects = records.projects.filter((project) =>
    (!projectId || project.id === projectId) &&
    (!objectiveId || project.objectiveId === objectiveId) &&
    (!lifeAreaId || records.objectives.some((objective) => objective.id === project.objectiveId && objective.lifeAreaId === lifeAreaId)));
  const sheets = [
    taskRows(tasks),
    {
      name: "الأهداف",
      rows: [["معرّف الهدف", "الهدف", "الوصف", "المجال", "معرّف المجال", "السنة", "الفترة", "الحالة", "تاريخ الإنشاء", "آخر تحديث", "عدد المهام في الفترة"],
        ...objectives.map((objective) => [
          objective.id, objective.title, objective.description,
          records.lifeAreas.find((area) => area.id === objective.lifeAreaId)?.name ?? "",
          objective.lifeAreaId, objective.year, objective.period ?? objective.quarter,
          objective.status, objective.createdAt, objective.updatedAt,
          objectiveTasks.filter((task) => objectiveForTask(task)?.id === objective.id).length,
        ])],
    },
    {
      name: "النتائج الرئيسية",
      rows: [["معرّف الهدف", "الهدف", "معرّف النتيجة", "النتيجة الرئيسية", "المقياس", "البداية", "المستهدف", "الحالي", "الوحدة", "التقدم %", "آخر تحديث"],
        ...records.keyResults.filter((result) => objectiveIds.has(result.objectiveId)).map((result) => [
          result.objectiveId,
          objectives.find((objective) => objective.id === result.objectiveId)?.title ?? "",
          result.id, result.title, result.metric, result.start, result.target, result.current,
          result.unit, getKeyResultProgress(result), result.updatedAt,
        ])],
    },
    habitConfigs,
    habitLogs,
    {
      name: "جلسات التركيز",
      rows: [["معرّف الجلسة", "معرّف المهمة", "المهمة", "معرّف العادة", "العادة", "النوع", "الحالة", "البداية", "النهاية", "المدة بالدقائق", "المدة المخططة", "المقاطعات", "الإنشاء"],
        ...sessions.map((session) => [
          session.id, session.taskId,
          records.tasks.find((task) => task.id === session.taskId)?.title ?? "",
          session.habitId,
          records.habits.find((habit) => habit.id === session.habitId)?.title ?? "",
          session.type, session.status, session.start, session.end, session.durationMin,
          session.plannedDurationMin, session.interruptions, session.createdAt,
        ])],
    },
    {
      name: "اليوميات",
      rows: [["المعرّف", "التاريخ", "المزاج", "النص", "الامتنان", "أبرز لحظة", "الإنشاء", "آخر تحديث"],
        ...journal.map((entry) => [entry.id, entry.date, entry.mood, entry.text, entry.gratitude, entry.highlight, entry.createdAt, entry.updatedAt])],
    },
    {
      name: "المراجعات",
      rows: [["المعرّف", "النوع", "الفترة", "الإجابات بالتفصيل", "الإنشاء", "آخر تحديث"],
        ...reviews.map((review) => [review.id, review.type, review.period, JSON.stringify(review.answers ?? {}), review.createdAt, review.updatedAt])],
    },
    {
      name: "المشاريع",
      rows: [["المعرّف", "المشروع", "الوصف", "الهدف المرتبط", "الحالة", "عدد المهام في الفترة", "تاريخ الإنشاء", "آخر تحديث"],
        ...projects.map((project) => [
          project.id, project.name, project.description,
          records.objectives.find((objective) => objective.id === project.objectiveId)?.title ?? "",
          project.archived ? "مؤرشف" : "نشط",
          tasks.filter((task) => task.projectId === project.id).length,
          project.createdAt, project.updatedAt,
        ])],
    },
  ];
  const relatedTaskSheet = (name, relatedTasks) => {
    const source = taskRows(tasks);
    const rowsById = new Map(source.rows.slice(1).map((row) => [row[0], row]));
    return { name, rows: [source.rows[0], ...relatedTasks.map((task) => rowsById.get(task.id)).filter(Boolean)] };
  };
  if (exportScope === "all") return sheets;
  if (exportScope === "tasks") return [sheets[0]];
  if (exportScope === "objectives") {
    const objectiveTaskIds = new Set(objectiveTasks.map((task) => task.id));
    const linkedSessions = {
      ...sheets[5],
      rows: [sheets[5].rows[0], ...sheets[5].rows.slice(1).filter((row) => objectiveTaskIds.has(row[1]))],
    };
    return [relatedTaskSheet("مهام الأهداف", objectiveTasks), sheets[1], sheets[2], linkedSessions];
  }
  if (exportScope === "habits") return [sheets[3], sheets[4]];
  if (exportScope === "sessions") return [sheets[5]];
  if (exportScope === "journal") return [sheets[6]];
  if (exportScope === "reviews") return [sheets[7]];
  if (exportScope === "projects") return [relatedTaskSheet("مهام المشاريع", tasks.filter((task) => projectId ? task.projectId === projectId : Boolean(task.projectId))), sheets[8]];
  return sheets;
}

function exportFilename(extension) {
  const period = range === "all" ? "full" : dateRange().start;
  return `mihwar-report-${exportScope}-${period}.${extension}`;
}

function buildExportAnalytics(tasks) {
  const selectedRange = dateRange();
  const { start, end } = rangeForCharts();
  const summary = reportSummary(tasks, selectedRange.start, selectedRange.end);
  const charts = [];
  const completedTasks = dailyCompletions(
    tasks.filter((task) => task.status === "done" && inRange(task.completedAt, start, end)),
    start,
    end,
  );
  charts.push({ section: "tasks", title: "إنجاز المهام عبر الزمن", type: "line", unit: "مهمة", values: completedTasks });
  const openTasks = tasks.filter((task) => task.status !== "done");
  charts.push({
    section: "tasks",
    title: "حالة المهام",
    type: "bar",
    unit: "مهمة",
    values: [
      { label: "مكتملة", value: summary.completedTasks },
      { label: "مفتوحة", value: openTasks.length },
    ],
  });

  const focusByGroup = new Map();
  const focusSessions = reportSessions(start, end);
  for (const session of focusSessions) {
    const task = records.tasks.find((item) => item.id === session.taskId);
    const habit = records.habits.find((item) => item.id === session.habitId);
    const objective = task ? objectiveForTask(task) : records.objectives.find((item) => item.id === habit?.objectiveId);
    const area = records.lifeAreas.find((item) => item.id === objective?.lifeAreaId);
    const label = area?.name ?? records.projects.find((item) => item.id === task?.projectId)?.name ?? "دون تصنيف";
    focusByGroup.set(label, (focusByGroup.get(label) ?? 0) + Math.max(0, Number(session.durationMin) || 0));
  }
  charts.push({
    section: "focus",
    title: "وقت التركيز حسب المجال أو المشروع",
    type: "bar",
    unit: "دقيقة",
    values: [...focusByGroup].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
  });

  const habits = records.habits.filter((habit) => !habit.archived && matchesHabitFilters(habit));
  charts.push({
    section: "habits",
    title: "ثبات العادات",
    type: "bar",
    unit: "%",
    values: habits.map((habit) => ({
      label: habit.title,
      value: habitConsistency(habit, start, end).percent,
    })),
  });
  const firstYear = new Date(`${start}T12:00:00`).getFullYear();
  const lastYear = new Date(`${end}T12:00:00`).getFullYear();
  const objectives = records.objectives.filter((objective) =>
    (range === "all" || (Number(objective.year) >= firstYear && Number(objective.year) <= lastYear)) &&
    objective.status !== "archived" &&
    (!objectiveId || objective.id === objectiveId) &&
    (!lifeAreaId || objective.lifeAreaId === lifeAreaId) &&
    (!projectId || records.projects.some((project) => project.id === projectId && project.objectiveId === objective.id)));
  const objectiveIds = new Set(objectives.map((objective) => objective.id));
  const objectiveTasks = tasks.filter((task) => objectiveIds.has(objectiveForTask(task)?.id));
  charts.push({
    section: "objectives",
    title: "تقدّم الأهداف",
    type: "bar",
    unit: "%",
    values: objectives.map((objective) => {
      const results = records.keyResults.filter((result) => result.objectiveId === objective.id);
      return {
        label: objective.title,
        value: results.length
          ? Math.round(results.reduce((sum, result) => sum + getKeyResultProgress(result), 0) / results.length)
          : 0,
      };
    }),
  });
  const objectiveStatusLabels = {
    "on-track": "يسير",
    "at-risk": "معرّض",
    blocked: "متعطّل",
    done: "مكتمل",
  };
  charts.push({
    section: "objectives",
    title: "حالات الأهداف",
    type: "bar",
    unit: "هدف",
    values: Object.entries(objectiveStatusLabels).map(([status, label]) => ({
      label,
      value: objectives.filter((objective) => objective.status === status).length,
    })),
  });
  const objectiveIdSet = new Set(objectives.map((objective) => objective.id));
  const keyResults = records.keyResults.filter((result) => objectiveIdSet.has(result.objectiveId));
  charts.push({
    section: "objectives",
    title: "تقدّم النتائج الرئيسية",
    type: "bar",
    unit: "%",
    values: keyResults.map((result) => ({
      label: result.title,
      value: getKeyResultProgress(result),
    })),
  });
  const moods = records.journal.filter((entry) => inRange(entry.date, start, end) && entry.mood)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((entry) => ({
      label: new Intl.DateTimeFormat("ar", { day: "numeric", month: "short" }).format(new Date(`${entry.date}T12:00:00`)),
      date: entry.date,
      value: Number(entry.mood),
    }));
  charts.push({ section: "journal", title: "اتجاه المزاج", type: "line", unit: "من 5", values: moods });
  const dailyHabitProgress = dailyCompletions([], start, end).flatMap((day) => {
    const scheduled = habits.filter((habit) => scheduledDays(habit, day.date, day.date).length > 0);
    if (!scheduled.length) return [];
    const completed = scheduled.filter((habit) => dayProgress(habit, day.date).complete).length;
    return [{ ...day, value: Math.round(completed / scheduled.length * 100) }];
  });
  charts.push({ section: "habits", title: "إنجاز العادات اليومي", type: "line", unit: "%", values: dailyHabitProgress });
  const focusByDay = dailyCompletions([], start, end).map((day) => ({
    ...day,
    value: focusSessions.filter((session) => session.start?.slice(0, 10) === day.date)
      .reduce((sum, session) => sum + Math.max(0, Number(session.durationMin) || 0), 0),
  }));
  charts.push({ section: "focus", title: "دقائق التركيز يومياً", type: "line", unit: "دقيقة", values: focusByDay });

  const journalEntries = records.journal.filter((entry) => inRange(entry.date, selectedRange.start, selectedRange.end));
  const journalPerDay = dailyCompletions([], start, end).map((day) => ({
    ...day,
    value: journalEntries.filter((entry) => entry.date === day.date).length,
  }));
  charts.push({ section: "journal", title: "التدوينات اليومية", type: "line", unit: "تدوينة", values: journalPerDay });
  const moodLabels = ["متعب جداً", "متعب", "متوازن", "جيد", "ممتاز"];
  charts.push({
    section: "journal",
    title: "توزيع المزاج",
    type: "bar",
    unit: "تسجيل",
    values: moodLabels.map((label, index) => ({
      label,
      value: journalEntries.filter((entry) => Number(entry.mood) === index + 1).length,
    })),
  });

  const reviewEntries = records.reviews.filter((review) => {
    const stamp = review.date ?? review.createdAt ?? review.updatedAt;
    return range === "all" || inRange(stamp, selectedRange.start, selectedRange.end);
  });
  const reviewTypeLabels = {
    weekly: "أسبوعية",
    monthly: "شهرية",
    quarterly: "ربع سنوية",
    trimester: "دورية",
    annual: "سنوية",
  };
  const reviewTypes = [...new Set([...Object.keys(reviewTypeLabels), ...reviewEntries.map((review) => review.type)])];
  charts.push({
    section: "reviews",
    title: "المراجعات حسب النوع",
    type: "bar",
    unit: "مراجعة",
    values: reviewTypes.map((type) => ({
      label: reviewTypeLabels[type] ?? type,
      value: reviewEntries.filter((review) => review.type === type).length,
    })),
  });

  const projects = records.projects.filter((project) =>
    (!projectId || project.id === projectId) &&
    (!objectiveId || project.objectiveId === objectiveId) &&
    (!lifeAreaId || records.objectives.some((objective) => objective.id === project.objectiveId && objective.lifeAreaId === lifeAreaId)));
  charts.push({
    section: "projects",
    title: "المهام حسب المشروع",
    type: "bar",
    unit: "مهمة",
    values: projects.map((project) => ({
      label: project.name,
      value: tasks.filter((task) => task.projectId === project.id).length,
    })),
  });
  charts.push({
    section: "projects",
    title: "حالة المشاريع",
    type: "bar",
    unit: "مشروع",
    values: [
      { label: "نشطة", value: projects.filter((project) => !project.archived).length },
      { label: "مؤرشفة", value: projects.filter((project) => project.archived).length },
    ],
  });

  const areas = records.lifeAreas.filter((area) => !lifeAreaId || area.id === lifeAreaId);
  charts.push({
    section: "objectives",
    title: "تقدّم الأهداف حسب المجال",
    type: "bar",
    unit: "%",
    values: areas.flatMap((area) => {
      const areaObjectives = objectives.filter((objective) => objective.lifeAreaId === area.id);
      if (!areaObjectives.length) return [];
      const progress = areaObjectives.map((objective) => {
        const results = keyResults.filter((result) => result.objectiveId === objective.id);
        return results.length
          ? results.reduce((sum, result) => sum + getKeyResultProgress(result), 0) / results.length
          : 0;
      });
      return [{ label: area.name, value: Math.round(progress.reduce((sum, value) => sum + value, 0) / progress.length) }];
    }),
  });

  const activity = [];
  const cursor = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  const taskCounts = new Map();
  for (const task of tasks) {
    if (task.status !== "done" || !inRange(task.completedAt, start, end)) continue;
    const date = task.completedAt.slice(0, 10);
    taskCounts.set(date, (taskCounts.get(date) ?? 0) + 1);
  }
  const focusCounts = new Map();
  for (const session of focusSessions) {
    const date = session.start.slice(0, 10);
    focusCounts.set(date, (focusCounts.get(date) ?? 0) + 1);
  }
  while (cursor <= last && activity.length < 366) {
    const date = localDateString(cursor);
    const doneHabits = habits.filter((habit) =>
      scheduledDays(habit, date, date).length && dayProgress(habit, date).complete).length;
    activity.push({
      date,
      label: new Intl.DateTimeFormat("ar", { day: "numeric", month: "short" }).format(cursor),
      value: (taskCounts.get(date) ?? 0) + doneHabits + (focusCounts.get(date) ?? 0),
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  const resultMetrics = keyResults.length
    ? keyResults.reduce((sum, result) => sum + getKeyResultProgress(result), 0) / keyResults.length
    : 0;
  const keyResultTotals = new Map();
  for (const result of keyResults) {
    if (!result.unit) continue;
    const totals = keyResultTotals.get(result.unit) ?? { current: 0, target: 0 };
    totals.current += Number(result.current) || 0;
    totals.target += Number(result.target) || 0;
    keyResultTotals.set(result.unit, totals);
  }
  const habitStart = (habit) => range === "all"
    ? (habit.createdAt?.slice(0, 10) ?? start)
    : selectedRange.start;
  const habitEnd = range === "all" ? localDateString() : selectedRange.end;
  const habitPerformance = habits.map((habit) =>
    habitConsistency(habit, habitStart(habit), habitEnd));
  const scheduledHabitDays = habitPerformance.reduce((sum, item) => sum + item.scheduled, 0);
  const completedHabitDays = habitPerformance.reduce((sum, item) => sum + item.completed, 0);
  const totalFocusMinutes = focusSessions.reduce((sum, session) => sum + Math.max(0, Number(session.durationMin) || 0), 0);
  const moodEntries = journalEntries.filter((entry) => Number(entry.mood) >= 1 && Number(entry.mood) <= 5);
  const averageMood = moodEntries.length
    ? Number((moodEntries.reduce((sum, entry) => sum + Number(entry.mood), 0) / moodEntries.length).toFixed(1))
    : "—";
  const archivedProjects = projects.filter((project) => project.archived).length;
  const taskDetails = tasks.map((task) => {
    const checklist = Array.isArray(task.checklist) ? task.checklist : [];
    const done = checklist.filter((item) => typeof item === "object" && item.done).length;
    return {
      title: task.title,
      value: checklist.length ? `${done}/${checklist.length} فرعية` : task.status === "done" ? "مكتملة" : "مفتوحة",
      detail: [task.notes?.trim(), `الوقت: ${Math.max(0, Number(task.timeSpentMin) || 0)} د · المتوقع: ${Math.max(0, Number(task.estimateMin) || 0)} د`].filter(Boolean).join(" · "),
      subtaskTotal: checklist.length,
      subtaskDone: done,
      metrics: [
        { label: "الوقت المنفّذ", value: `${Math.max(0, Number(task.timeSpentMin) || 0)} د` },
        { label: "الوقت المتوقع", value: `${Math.max(0, Number(task.estimateMin) || 0)} د` },
        ...(checklist.length ? [{ label: "المهام الفرعية", value: `${done} من ${checklist.length}` }] : []),
      ],
      children: checklist.map((item) => {
        const text = typeof item === "string" ? item : item.text;
        return {
          label: text || "مهمة فرعية",
          value: typeof item === "string" ? "مسجلة" : item.done ? "مكتملة" : "مفتوحة",
          detail: typeof item === "string" ? "" : item.notes ?? "",
        };
      }),
    };
  });
  const objectiveDetails = objectives.map((objective) => ({
    title: objective.title,
    value: objectiveStatusLabels[objective.status] ?? "يسير",
    detail: [objective.description?.trim(), `${objectiveTasks.filter((task) => objectiveForTask(task)?.id === objective.id).length} مهام مرتبطة`, `${keyResults.filter((result) => result.objectiveId === objective.id).length} نتائج رئيسية`].filter(Boolean).join(" · "),
    metrics: keyResults.filter((result) => result.objectiveId === objective.id).map((result) => ({
      label: result.title,
      value: `${Number(result.current ?? 0)} / ${Number(result.target ?? 0)}${result.unit ? ` ${result.unit}` : ""}`,
      detail: `البداية ${Number(result.start ?? 0)} · المتبقي ${Number(result.target ?? 0) - Number(result.current ?? 0)} · التقدم ${getKeyResultProgress(result)}%`,
      percent: getKeyResultProgress(result),
    })),
  }));
  const habitQuantities = new Map();
  const habitDetails = habits.map((habit) => {
    const from = habitStart(habit);
    const schedule = habitPerformance[habits.indexOf(habit)];
    const history = Array.isArray(habit.history)
      ? Object.fromEntries(habit.history.map((date) => [date, true]))
      : habit.history ?? {};
    const logDates = new Set([
      ...Object.keys(history),
      ...Object.keys(habit.progress ?? {}),
      ...Object.keys(habit.itemLog ?? {}),
    ].filter((date) => inRange(date, from, selectedRange.end)));
    if (habit.mode === "items") {
      const items = (habit.items ?? []).map((item) => {
        const occurrenceCount = [...logDates].filter((date) => (habit.itemLog?.[date] ?? []).includes(item.id)).length;
        const unit = item.unit || habit.unit || "مرة";
        const quantityPerOccurrence = item.amount === undefined || item.amount === null || item.amount === ""
          ? 1
          : Math.max(0, Number(item.amount) || 0);
        return {
          label: item.name,
          category: item.category ?? "عام",
          value: `${occurrenceCount} مرة`,
          detail: `${item.category ?? "عام"} · إجمالي ${quantityPerOccurrence * occurrenceCount} ${unit}`,
          quantity: quantityPerOccurrence * occurrenceCount,
          unit,
          metrics: [
            { label: "مرات الإنجاز", value: occurrenceCount },
            { label: "الكمية الإجمالية", value: `${quantityPerOccurrence * occurrenceCount} ${unit}` },
            { label: "كمية المرة", value: `${quantityPerOccurrence} ${unit}` },
          ],
        };
      });
      const totalsByUnit = new Map();
      const totalsByCategory = new Map();
      for (const item of items) {
        if (item.quantity) totalsByUnit.set(item.unit, (totalsByUnit.get(item.unit) ?? 0) + item.quantity);
        const totals = totalsByCategory.get(item.category) ?? { occurrences: 0, units: new Map() };
        totals.occurrences += Number(item.metrics[0].value) || 0;
        totals.units.set(item.unit, (totals.units.get(item.unit) ?? 0) + item.quantity);
        totalsByCategory.set(item.category, totals);
      }
      for (const [unit, amount] of totalsByUnit) {
        habitQuantities.set(unit, (habitQuantities.get(unit) ?? 0) + amount);
      }
      const categoryMetrics = [...totalsByCategory].flatMap(([category, totals]) => [
        { label: `${category} · مرات الإنجاز`, value: totals.occurrences },
        ...[...totals.units].map(([unit, amount]) => ({
          label: `${category} · إجمالي ${unit}`,
          value: amount,
        })),
      ]);
      return {
        title: habit.title,
        visualKind: "habit-items",
        value: `${schedule.completed}/${schedule.scheduled} أيام`,
        detail: [habit.description?.trim(), [...totalsByUnit].map(([unit, amount]) => `الإجمالي ${amount} ${unit}`).join(" · ")].filter(Boolean).join(" · ") || "عادة بدون كميات مسجلة",
        metrics: [
          { label: "أيام مكتملة", value: schedule.completed },
          { label: "أيام مجدولة", value: schedule.scheduled },
          ...[...totalsByUnit].map(([unit, amount]) => ({ label: `إجمالي ${unit}`, value: amount })),
          ...categoryMetrics,
        ],
        children: items,
      };
    }
    if (habit.mode === "count") {
      const dates = Object.keys(habit.progress ?? {}).filter((date) => inRange(date, from, selectedRange.end));
      const count = dates.reduce((sum, date) => sum + Math.max(0, Number(habit.progress[date]) || 0), 0);
      const target = schedule.scheduled * Math.max(1, Number(habit.targetPerDay) || 1);
      if (habit.unit) habitQuantities.set(habit.unit, (habitQuantities.get(habit.unit) ?? 0) + count);
      return {
        title: habit.title,
        value: `${count} / ${target}${habit.unit ? ` ${habit.unit}` : ""}`,
        detail: [habit.description?.trim(), `الإجمالي المسجل من الهدف خلال ${schedule.scheduled} يوماً مجدولاً`].filter(Boolean).join(" · "),
        metrics: [
          { label: `الكمية المنجزة${habit.unit ? ` (${habit.unit})` : ""}`, value: count },
          { label: "الهدف الإجمالي", value: target },
          { label: "الأيام المكتملة", value: schedule.completed },
          { label: "الأيام المجدولة", value: schedule.scheduled },
        ],
      };
    }
    return {
      title: habit.title,
      value: `${schedule.completed}/${schedule.scheduled} أيام`,
      detail: [habit.description?.trim(), "عدد مرات الإكمال خلال الأيام المجدولة"].filter(Boolean).join(" · "),
      metrics: [
        { label: "مرات الإكمال", value: schedule.completed },
        { label: "الأيام المجدولة", value: schedule.scheduled },
      ],
    };
  });
  const focusDetails = focusSessions.map((session) => ({
    title: records.tasks.find((task) => task.id === session.taskId)?.title ??
      records.habits.find((habit) => habit.id === session.habitId)?.title ?? "جلسة دون مهمة أو عادة",
    value: `${Math.max(0, Number(session.durationMin) || 0)} دقيقة`,
    detail: `${String(session.start ?? "").slice(0, 10)} · ${Math.max(0, Number(session.interruptions) || 0)} مقاطعات`,
    metrics: [
      { label: "المدة", value: `${Math.max(0, Number(session.durationMin) || 0)} د` },
      { label: "المقاطعات", value: Math.max(0, Number(session.interruptions) || 0) },
    ],
  }));
  const journalDetails = journalEntries.map((entry) => ({
    title: entry.date,
    value: entry.mood ? `المزاج ${entry.mood}/5` : "دون تسجيل مزاج",
    detail: [entry.text?.trim(), entry.gratitude?.trim() ? `امتنان: ${entry.gratitude.trim()}` : "", entry.highlight?.trim() ? `لحظة بارزة: ${entry.highlight.trim()}` : ""].filter(Boolean).join(" · ") || "تدوينة",
    metrics: [
      { label: "المزاج", value: entry.mood ?? "—" },
      { label: "الامتنان", value: entry.gratitude?.trim() ? "مسجل" : "—" },
      { label: "لحظة بارزة", value: entry.highlight?.trim() ? "مسجلة" : "—" },
    ],
  }));
  const reviewDetails = reviewEntries.map((review) => {
    const answers = Object.values(review.answers ?? {}).filter((answer) => String(answer ?? "").trim());
    return {
      title: reviewTypeLabels[review.type] ?? review.type ?? "مراجعة",
      value: `${answers.length} إجابات`,
      detail: `${review.period ?? review.date ?? review.createdAt ?? ""}`,
      metrics: Object.entries(review.answers ?? {})
        .filter(([_key, answer]) => String(answer ?? "").trim())
        .map(([question, answer]) => ({ label: question, value: String(answer) })),
    };
  });
  const projectDetails = projects.map((project) => {
    const relatedTasks = tasks.filter((task) => task.projectId === project.id);
    return {
      title: project.name,
      value: project.archived ? "مؤرشف" : "نشط",
      detail: [project.description?.trim(), `${relatedTasks.length} مهام · ${relatedTasks.filter((task) => task.status === "done").length} مكتملة`].filter(Boolean).join(" · "),
      metrics: [
        { label: "المهام", value: relatedTasks.length },
        { label: "المكتملة", value: relatedTasks.filter((task) => task.status === "done").length },
        { label: "الوقت المسجل", value: `${relatedTasks.reduce((sum, task) => sum + Math.max(0, Number(task.timeSpentMin) || 0), 0)} د` },
      ],
    };
  });
  const sections = {
    tasks: {
      label: "المهام",
      details: taskDetails,
      metrics: [
        { label: "إجمالي المهام", value: tasks.length, detail: "ضمن الفترة والفلاتر" },
        { label: "المكتملة", value: summary.completedTasks, detail: `${summary.completionRate}% من الإجمالي`, percent: summary.completionRate },
        { label: "المفتوحة", value: openTasks.length, detail: "بحاجة إلى إنجاز" },
        { label: "وقت العمل المسجّل", value: `${tasks.reduce((sum, task) => sum + Math.max(0, Number(task.timeSpentMin) || 0), 0)} د`, detail: "مجموع الوقت المنفّذ" },
        { label: "المهام الفرعية", value: `${taskDetails.reduce((sum, task) => sum + task.subtaskDone, 0)} من ${taskDetails.reduce((sum, task) => sum + task.subtaskTotal, 0)}`, detail: "من قوائم المهام" },
      ],
    },
    objectives: {
      label: "الأهداف والنتائج",
      details: objectiveDetails,
      metrics: [
        { label: "الأهداف", value: objectives.length, detail: "ضمن المجالات والفترة" },
        { label: "المكتملة", value: objectives.filter((objective) => objective.status === "done").length, detail: "حالة الهدف مكتمل" },
        { label: "المتعثرة أو المعرّضة", value: objectives.filter((objective) => ["blocked", "at-risk"].includes(objective.status)).length, detail: "تحتاج مراجعة" },
        { label: "النتائج الرئيسية", value: keyResults.length, detail: `${Math.round(resultMetrics)}% متوسط التقدم` },
        ...[...keyResultTotals].map(([unit, totals]) => ({
          label: `النتائج بوحدة ${unit}`,
          value: `${totals.current} / ${totals.target}`,
          detail: "الحالي من إجمالي المستهدف",
        })),
      ],
    },
    habits: {
      label: "العادات",
      details: habitDetails,
      metrics: [
        { label: "العادات النشطة", value: habits.length, detail: "ضمن المرشحات" },
        { label: "أيام مجدولة", value: scheduledHabitDays, detail: "بحسب جداول العادات" },
        { label: "أيام مكتملة", value: completedHabitDays, detail: "وفق إنجاز الهدف أو البنود" },
        { label: "نسبة الثبات", value: `${scheduledHabitDays ? Math.round(completedHabitDays / scheduledHabitDays * 100) : 0}%`, detail: "من الأيام المجدولة", percent: scheduledHabitDays ? Math.round(completedHabitDays / scheduledHabitDays * 100) : 0 },
        { label: "إجمالي الكميات", value: [...habitQuantities].map(([unit, total]) => `${total} ${unit}`).join(" · ") || "—", detail: "مجمعة حسب الوحدة" },
      ],
    },
    focus: {
      label: "جلسات التركيز",
      details: focusDetails,
      metrics: [
        { label: "الجلسات المكتملة", value: focusSessions.length, detail: "جلسات تركيز لا تشمل الاستراحات" },
        { label: "إجمالي التركيز", value: `${totalFocusMinutes} د`, detail: `${(totalFocusMinutes / 60).toFixed(1)} ساعة` },
        { label: "متوسط الجلسة", value: `${focusSessions.length ? Math.round(totalFocusMinutes / focusSessions.length) : 0} د`, detail: "لكل جلسة مكتملة" },
        { label: "المقاطعات", value: focusSessions.reduce((sum, session) => sum + Math.max(0, Number(session.interruptions) || 0), 0), detail: "ضمن جلسات الفترة" },
      ],
    },
    journal: {
      label: "اليوميات والمزاج",
      details: journalDetails,
      metrics: [
        { label: "التدوينات", value: journalEntries.length, detail: "ضمن الفترة" },
        { label: "تسجيلات المزاج", value: moodEntries.length, detail: "من أصل 5 درجات" },
        { label: "متوسط المزاج", value: `${averageMood}${averageMood === "—" ? "" : " / 5"}`, detail: "للتسجيلات التي تتضمن مزاجاً" },
        { label: "تدوينات الامتنان", value: journalEntries.filter((entry) => entry.gratitude?.trim()).length, detail: "تحتوي على امتنان" },
      ],
    },
    reviews: {
      label: "المراجعات",
      details: reviewDetails,
      metrics: [
        { label: "المراجعات المحفوظة", value: reviewEntries.length, detail: "ضمن الفترة" },
        ...Object.entries(reviewTypeLabels).map(([type, label]) => ({
          label: `مراجعات ${label}`,
          value: reviewEntries.filter((review) => review.type === type).length,
          detail: "مراجعة محفوظة",
        })),
      ],
    },
    projects: {
      label: "المشاريع",
      details: projectDetails,
      metrics: [
        { label: "إجمالي المشاريع", value: projects.length, detail: "ضمن الفلاتر" },
        { label: "المشاريع النشطة", value: projects.length - archivedProjects, detail: "غير مؤرشفة" },
        { label: "المؤرشفة", value: archivedProjects, detail: "محفوظة في السجل" },
        { label: "مهام المشاريع", value: tasks.filter((task) => projects.some((project) => project.id === task.projectId)).length, detail: "ضمن الفترة" },
      ],
    },
  };
  return {
    period: { start: selectedRange.start, end: selectedRange.end, chartStart: start, chartEnd: end },
    summary,
    sections,
    charts,
    activity,
  };
}

function chartRepresentation(chart) {
  const numbers = chart.values.map((item) => Number(item.value) || 0);
  if (!numbers.length) return "لا توجد بيانات";
  if (chart.type === "line") {
    const levels = "▁▂▃▄▅▆▇█";
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    return numbers.map((value) => levels[max === min ? 0 : Math.round((value - min) / (max - min) * (levels.length - 1))]).join("");
  }
  const max = Math.max(1, ...numbers);
  return chart.values.map((item) =>
    `${item.label}: ${"█".repeat(Math.max(item.value ? 1 : 0, Math.round((Number(item.value) || 0) / max * 20)))}`).join(" | ");
}

function analyticsSheets(analytics) {
  const summaryRows = [
    ["الفترة", analytics.period.start, analytics.period.end],
    ["القسم", "المؤشر", "القيمة", "التفاصيل"],
    ...Object.values(analytics.sections).flatMap((section) => [
      [section.label],
      ...section.metrics.map((metric) => [section.label, metric.label, metric.value, metric.detail ?? ""]),
    ]),
  ];
  const sectionSheets = Object.values(analytics.sections).map((section) => ({
    name: `إحصاء ${section.label}`,
    rows: [
      ["القسم", section.label],
      ["المؤشر", "القيمة", "التفاصيل"],
      ...section.metrics.map((metric) => [metric.label, metric.value, metric.detail ?? ""]),
      [],
      ["السجل", "المؤشر", "القيمة", "تفاصيل"],
      ...section.details.flatMap((item) => [
        [item.title, "الإجمالي", item.value, item.detail ?? ""],
        ...(item.metrics ?? []).map((metric) => [item.title, metric.label, metric.value, metric.detail ?? ""]),
        ...(item.children ?? []).flatMap((child) => [
          [`${item.title} · ${child.label}`, "الإجمالي", child.value, child.detail ?? ""],
          ...(child.metrics ?? []).map((metric) => [`${item.title} · ${child.label}`, metric.label, metric.value, metric.detail ?? ""]),
        ]),
      ]),
    ],
  }));
  return [
    { name: "ملخص التقرير", rows: summaryRows },
    ...sectionSheets,
    ...analytics.charts.map((chart, index) => {
      const values = chart.values;
      return {
        name: `رسم ${index + 1}`,
        chart: values.length
          ? { type: chart.type, title: chart.title, firstRow: 4, lastRow: values.length + 3 }
          : null,
        rows: [
          [chart.title],
          ["التمثيل البصري", chartRepresentation(chart)],
          ["الفئة أو التاريخ", "القيمة", chart.unit],
          ...(values.length ? values.map((item) => [item.label, item.value, chart.unit]) : [["لا توجد بيانات ضمن الفترة", "", ""]]),
        ],
      };
    }),
    {
      name: "خريطة النشاط",
      rows: [
        ["اليوم", "عدد الأنشطة"],
        ...analytics.activity.map((day) => [day.date, day.value]),
      ],
    },
  ];
}

function exportCsv(sheets, analytics) {
  const rows = [
    ["إحصاءات جميع الأقسام"],
    ["الفترة", analytics.period.start, analytics.period.end],
  ];
  for (const section of Object.values(analytics.sections)) {
    rows.push([], [`إحصاءات قسم: ${section.label}`], ["المؤشر", "القيمة", "التفاصيل"]);
    rows.push(...section.metrics.map((metric) => [metric.label, metric.value, metric.detail ?? ""]));
    rows.push(["السجل", "المؤشر", "القيمة", "التفاصيل"]);
    for (const item of section.details) {
      rows.push([item.title, "الإجمالي", item.value, item.detail ?? ""]);
      rows.push(...(item.metrics ?? []).map((metric) => [item.title, metric.label, metric.value, metric.detail ?? ""]));
      for (const child of item.children ?? []) {
        rows.push([`${item.title} · ${child.label}`, "الإجمالي", child.value, child.detail ?? ""]);
        rows.push(...(child.metrics ?? []).map((metric) => [`${item.title} · ${child.label}`, metric.label, metric.value, metric.detail ?? ""]));
      }
    }
  }
  for (const chart of analytics.charts) {
    rows.push([], [`الرسم: ${chart.title}`], ["التمثيل البصري", chartRepresentation(chart)], ["الفئة أو التاريخ", "القيمة", "الوحدة", "نوع الرسم", "تمثيل القيمة"]);
    if (chart.values.length) {
      const max = Math.max(1, ...chart.values.map((item) => Number(item.value) || 0));
      rows.push(...chart.values.map((item) => [
        item.label, item.value, chart.unit, chart.type,
        chart.type === "bar" ? "█".repeat(Math.max(item.value ? 1 : 0, Math.round((Number(item.value) || 0) / max * 20))) : "",
      ]));
    } else rows.push(["لا توجد بيانات ضمن الفترة المحددة."]);
  }
  rows.push([], ["خريطة النشاط اليومية"], ["التاريخ", "عدد الأنشطة"], ...analytics.activity.map((day) => [day.date, day.value]));
  for (const sheet of sheets) rows.push([], [sheet.name], ...sheet.rows);
  downloadCsv(exportFilename("csv"), ["مِحوَر — تقرير إحصائي ومفصل"], rows);
}

function exportExcel(sheets, analytics) {
  downloadXlsx(exportFilename("xlsx"), [...analyticsSheets(analytics), ...sheets]);
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson(sheets, analytics) {
  const { start, end } = dateRange();
  const sections = Object.fromEntries(sheets.map((sheet) => [
    sheet.name,
    sheet.rows.slice(1).map((row) => Object.fromEntries(sheet.rows[0].map((header, index) => [header, row[index] ?? ""]))),
  ]));
  const data = {
    app: "mihwar-report",
    generatedAt: new Date().toISOString(),
    range: range === "all" ? "all" : { start, end },
    filters: { exportScope, projectId, objectiveId, lifeAreaId },
    analytics: {
      period: analytics.period,
      summary: analytics.summary,
      sections: analytics.sections,
      charts: analytics.charts,
      activity: analytics.activity,
    },
    sections,
  };
  download(exportFilename("json"), JSON.stringify(data, null, 2), "application/json");
}

function scopeExportAnalytics(analytics) {
  const scope = {
    all: Object.keys(analytics.sections),
    tasks: ["tasks"],
    objectives: ["objectives", "tasks", "focus"],
    habits: ["habits"],
    sessions: ["focus"],
    journal: ["journal"],
    reviews: ["reviews"],
    projects: ["projects", "tasks", "focus"],
  }[exportScope] ?? Object.keys(analytics.sections);
  const sections = Object.fromEntries(Object.entries(analytics.sections).filter(([key]) => scope.includes(key)));
  return {
    ...analytics,
    sections,
    charts: analytics.charts.filter((chart) => scope.includes(chart.section)),
  };
}

function bindEvents(app) {
  eventController?.abort();
  eventController = new AbortController();
  const { signal } = eventController;
  app.querySelector("#report-range").addEventListener("change", (event) => {
    range = event.currentTarget.value;
    render();
  }, { signal });
  app.querySelector("#report-export-scope").addEventListener("change", (event) => {
    exportScope = event.currentTarget.value;
    render();
  }, { signal });
  app.querySelector("#report-start")?.addEventListener("change", (event) => {
    customStart = event.currentTarget.value;
    if (customStart && customEnd && customStart > customEnd) {
      setReportStatus("تاريخ البداية يجب أن يسبق تاريخ النهاية.", true);
      return;
    }
    render();
  }, { signal });
  app.querySelector("#report-end")?.addEventListener("change", (event) => {
    customEnd = event.currentTarget.value;
    if (customStart && customEnd && customStart > customEnd) {
      setReportStatus("تاريخ النهاية يجب أن يلي تاريخ البداية.", true);
      return;
    }
    render();
  }, { signal });
  app.querySelector("#report-project").addEventListener("change", (event) => {
    projectId = event.currentTarget.value;
    render();
  }, { signal });
  app.querySelector("#report-objective").addEventListener("change", (event) => {
    objectiveId = event.currentTarget.value;
    render();
  }, { signal });
  app.querySelector("#report-area").addEventListener("change", (event) => {
    lifeAreaId = event.currentTarget.value;
    render();
  }, { signal });
  app.addEventListener("click", (event) => {
    const button = event.target.closest("[data-export]");
    if (!button) return;
    try {
      const tasks = filteredTasks();
      const sheets = buildExportSheets(tasks);
      const analytics = scopeExportAnalytics(buildExportAnalytics(tasks));
      if (button.dataset.export === "pdf") {
        printReport(
          sheets,
          EXPORT_SCOPE_LABELS[exportScope],
          range === "all" ? "كامل الفترة" : `${dateRange().start} — ${dateRange().end}`,
          analytics,
        );
        setReportStatus("اختر «حفظ كـ PDF» من نافذة الطباعة؛ سيحتوي على الإحصائيات والرسوم والتفاصيل المحددة.");
        return;
      }
      if (button.dataset.export === "csv") exportCsv(sheets, analytics);
      else if (button.dataset.export === "excel") exportExcel(sheets, analytics);
      else if (button.dataset.export === "json") exportJson(sheets, analytics);
      setReportStatus(`جُهّز تصدير ${EXPORT_SCOPE_LABELS[exportScope]} مع الملخص الإحصائي والرسوم وبياناتها للفترة ${range === "all" ? "الكاملة" : `${dateRange().start} — ${dateRange().end}`} والتفاصيل.`);
    } catch (error) {
      console.error("تعذّر إنشاء التقرير:", error);
      setReportStatus(`تعذّر إنشاء التقرير: ${error.message}`, true);
    }
  }, { signal });
}

function setReportStatus(message, isError = false) {
  showToast(message, { isError });
  const status = document.querySelector(".reports-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = isError ? "error" : "success";
}

async function refreshRecords() {
  const names = Object.keys(records);
  const values = await Promise.all(names.map((name) => getRecords(name)));
  records = Object.fromEntries(names.map((name, index) => [name, values[index]]));
  const profile = records.profile.find((item) => item.id === "user") ?? records.profile[0];
  plan = getPlanConfig(profile?.activePlan);
}

export async function mountReportsView(isCurrent = () => true) {
  unsubscribe?.();
  await refreshRecords();
  if (!isCurrent()) return;
  document.querySelector("#page-title").textContent = "التقارير";
  render();
  unsubscribe = subscribe(async (_state, change) => {
    if (!change.storeName || Object.hasOwn(records, change.storeName)) {
      try {
        await refreshRecords();
        if (isCurrent() && window.location.hash.startsWith("#/reports")) render();
      } catch (error) {
        console.error("تعذّر تحديث التقارير:", error);
      }
    }
  });
}

export function unmountReportsView() {
  unsubscribe?.();
  unsubscribe = undefined;
  eventController?.abort();
  eventController = undefined;
}

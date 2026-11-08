import { add, getRecords, subscribe, update } from "../store.js";
import { formatDate, localDateString } from "../utils/dates.js";
import { nextOccurrence } from "../utils/recurrence.js";
import {
  calculatePrayerTimes,
  formatPrayerTime,
  prayerMethodLabel,
} from "../utils/prayer-times.js";
import { dayProgress, setCompletionDetails, setDayComplete, setItemsLogged } from "./habits.js";
import { showToast } from "../utils/notifications.js";
import { requestCompletionDetails } from "../utils/completion-dialog.js";

const PRAYER_METHODS = ["auto", "mwl", "isna", "egypt", "ummAlQura", "karachi"];
const PRAYER_ITEM_NAMES = {
  الفجر: "صلاة الفجر",
  الظهر: "صلاة الظهر",
  العصر: "صلاة العصر",
  المغرب: "صلاة المغرب",
  العشاء: "صلاة العشاء",
};
const NIGHT_PRAYERS = ["قيام الليل", "صلاة الشفع", "الوتر"];
const MAP_MODES = ["day", "week", "month", "year"];
const MAP_MODE_LABELS = { day: "اليوم", week: "الأسبوع", month: "الشهر", year: "السنة" };
const PRAYER_ORDER_IF_LOCATION_UNAVAILABLE = {
  الفجر: 5 * 60,
  الظهر: 12 * 60,
  العصر: 15 * 60 + 30,
  المغرب: 18 * 60,
  العشاء: 20 * 60,
};

let unsubscribe;
let eventController;
let isMounted = false;
let records = { tasks: [], habits: [] };
let mapMode = MAP_MODES.includes(localStorage.getItem("mihwar-map-mode"))
  ? localStorage.getItem("mihwar-map-mode")
  : "day";
let mapParentMode = MAP_MODES.includes(localStorage.getItem("mihwar-map-parent-mode"))
  ? localStorage.getItem("mihwar-map-parent-mode")
  : null;
let mapDate = /^\d{4}-\d{2}-\d{2}$/.test(localStorage.getItem("mihwar-map-date") ?? "")
  ? localStorage.getItem("mihwar-map-date")
  : localDateString();
const expandedMapTaskDetails = new Set();

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function localLocation() {
  try {
    const location = JSON.parse(localStorage.getItem("mihwar-prayer-location") ?? "null");
    if (Number.isFinite(location?.latitude) && location.latitude >= -90 && location.latitude <= 90
      && Number.isFinite(location?.longitude) && location.longitude >= -180 && location.longitude <= 180) {
      return location;
    }
  } catch (error) {
    console.error("تعذّرت قراءة الموقع المحفوظ لمواقيت الصلاة:", error);
  }
  return null;
}

function selectedPrayerMethod() {
  const method = localStorage.getItem("mihwar-prayer-method") ?? "auto";
  return PRAYER_METHODS.includes(method) ? method : "auto";
}

function prayerSchedule(today) {
  const location = localLocation();
  if (!location) return null;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return calculatePrayerTimes(
    today,
    location.latitude,
    location.longitude,
    timeZone,
    selectedPrayerMethod(),
  );
}

function scheduledHabit(habit, date) {
  const schedule = habit.schedule;
  if (!schedule || schedule === "daily" || schedule === "everyday") return true;
  const weekday = new Date(`${date}T12:00:00`).getDay();
  if (schedule === "weekdays") return weekday >= 1 && weekday <= 5;
  if (schedule === "weekends") return weekday === 0 || weekday === 6;
  if (Array.isArray(schedule)) {
    const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const arabicNames = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
    return schedule.some((day) => Number(day) === weekday
      || String(day).toLowerCase() === names[weekday] || day === arabicNames[weekday]);
  }
  if (typeof schedule === "object") {
    const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const arabicNames = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
    return Boolean(schedule[weekday] ?? schedule[names[weekday]] ?? schedule[arabicNames[weekday]]);
  }
  return true;
}

function taskPriority(task) {
  if (Number.isInteger(task.priority) && task.priority >= 0 && task.priority <= 3) return task.priority;
  if (task.important && task.urgent) return 0;
  if (task.important) return 1;
  if (task.urgent) return 2;
  return 3;
}

function habitPriority(habit) {
  return Number.isInteger(habit.priority) && habit.priority >= 0 && habit.priority <= 3
    ? habit.priority
    : 3;
}

function datePart(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : localDateString(parsed);
}

function taskDates(task) {
  return [task.scheduled, task.due].map(datePart).filter(Boolean);
}

function isTaskForDate(task, date) {
  const dates = taskDates(task);
  if (task.status === "done") {
    return task.completedAt ? datePart(task.completedAt) === date : dates.includes(date);
  }
  return dates.includes(date) || (date === localDateString() && dates.some((taskDate) => taskDate < date));
}

function dayTasks(date) {
  return records.tasks.filter((task) => isTaskForDate(task, date));
}

function dayHabits(date) {
  return records.habits.filter((habit) => !habit.archived && scheduledHabit(habit, date));
}

function localDate(year, month = 0, day = 1) {
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month, day);
  return date;
}

function dateString(date) {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function mapBounds(mode = mapMode, date = new Date(`${mapDate}T12:00:00`)) {
  const year = date.getFullYear();
  const month = date.getMonth();
  if (mode === "week") {
    const startDate = localDate(year, month, date.getDate() - date.getDay());
    const endDate = localDate(year, month, startDate.getDate() + 6);
    return { start: dateString(startDate), end: dateString(endDate) };
  }
  if (mode === "month") {
    return {
      start: dateString(localDate(year, month, 1)),
      end: dateString(localDate(year, month + 1, 0)),
    };
  }
  if (mode === "year") {
    return {
      start: dateString(localDate(year, 0, 1)),
      end: dateString(localDate(year, 11, 31)),
    };
  }
  return { start: dateString(date), end: dateString(date) };
}

function eachDate(start, end) {
  const dates = [];
  const cursor = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  while (cursor <= last) {
    dates.push(dateString(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function formatMapPeriod() {
  const date = new Date(`${mapDate}T12:00:00`);
  if (mapMode === "year") return String(date.getFullYear());
  if (mapMode === "month") return new Intl.DateTimeFormat("ar", { month: "long", year: "numeric" }).format(date);
  if (mapMode === "week") {
    const { start, end } = mapBounds("week", date);
    const startDate = new Date(`${start}T12:00:00`);
    const endDate = new Date(`${end}T12:00:00`);
    return `${new Intl.DateTimeFormat("ar", { day: "numeric", month: "short" }).format(startDate)} — ${new Intl.DateTimeFormat("ar", { day: "numeric", month: "short", year: "numeric" }).format(endDate)}`;
  }
  return formatDate(mapDate);
}

function saveMapSelection() {
  localStorage.setItem("mihwar-map-mode", mapMode);
  localStorage.setItem("mihwar-map-date", mapDate);
  if (mapParentMode) localStorage.setItem("mihwar-map-parent-mode", mapParentMode);
  else localStorage.removeItem("mihwar-map-parent-mode");
}

function shiftMapPeriod(direction) {
  const date = new Date(`${mapDate}T12:00:00`);
  if (mapMode === "week") date.setDate(date.getDate() + direction * 7);
  else if (mapMode === "month") date.setMonth(date.getMonth() + direction, 1);
  else if (mapMode === "year") date.setFullYear(date.getFullYear() + direction, 0, 1);
  else date.setDate(date.getDate() + direction);
  if (date.getFullYear() >= 1 && date.getFullYear() <= 9999) {
    mapDate = dateString(date);
    saveMapSelection();
    render();
  }
}

function timeLabel(value) {
  if (!value) return "";
  const [hour, minute] = value.split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return value;
  return new Intl.DateTimeFormat("ar", { hour: "numeric", minute: "2-digit" })
    .format(new Date(2000, 0, 1, hour, minute));
}

function formatArabicNumber(value) {
  return String(value).replace(/\d/g, (digit) => "٠١٢٣٤٥٦٧٨٩"[Number(digit)]).replace(".", "٫");
}

function countPhrase(value, singular, plural) {
  return `${formatArabicNumber(value)} ${value === 1 ? singular : plural}`;
}

function clockMinutes(value) {
  if (!value) return null;
  const [hour, minute] = value.split(":").map(Number);
  return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : null;
}

function prayerMinutes(value) {
  return Number.isFinite(value) ? Math.round(value * 60) % 1440 : null;
}

function priorityLabel(priority) {
  return ["عاجلة ومهمة", "مهمة", "عاجلة", "عادية"][priority] ?? "عادية";
}

function linkedPrayerHabit() {
  return records.habits.find((habit) =>
    !habit.archived && habit.mode === "items" && /صلاة|الصلوات/.test(habit.title ?? ""));
}

function prayerItemFor(habit, prayerName) {
  const itemName = PRAYER_ITEM_NAMES[prayerName] ?? prayerName;
  return (habit?.items ?? []).find((item) => item.name.includes(itemName)) ?? null;
}

function prayerStatus(item, habit, today) {
  return Boolean(item && (habit?.itemLog?.[today] ?? []).includes(item.id));
}

function buildEvents(tasks, habits, schedule, today) {
  const prayerHabit = linkedPrayerHabit();
  const prayerEvents = schedule?.times ?? Object.keys(PRAYER_ITEM_NAMES).map((name) => ({ name, time: null }));
  const events = [
    ...tasks.map((task) => ({
      type: "task",
      time: task.dueTime ?? null,
      sortMinute: clockMinutes(task.dueTime),
      priority: taskPriority(task),
      task,
    })),
    ...habits.map((habit) => ({
      type: "habit",
      time: habit.dailyTime ?? null,
      sortMinute: clockMinutes(habit.dailyTime),
      priority: habitPriority(habit),
      habit,
    })),
    ...prayerEvents.map((prayer) => {
      const actualTime = Number.isFinite(prayer.time);
      return {
        type: "prayer",
        time: actualTime ? prayerMinutes(prayer.time) : null,
        sortMinute: actualTime ? prayerMinutes(prayer.time) : PRAYER_ORDER_IF_LOCATION_UNAVAILABLE[prayer.name],
        priority: habitPriority(prayerHabit ?? {}),
        prayer,
        habit: prayerHabit,
        item: prayerItemFor(prayerHabit, prayer.name),
      };
    }),
  ];

  const flexibleEvents = events.filter((event) => event.type !== "prayer"
    && event.sortMinute === null && event.time === null);
  const flexStart = 7 * 60;
  const flexEnd = 21 * 60;
  flexibleEvents.forEach((event, index) => {
    event.sortMinute = flexStart + Math.round(((flexEnd - flexStart) * (index + 1)) / (flexibleEvents.length + 1));
  });
  const orderedEvents = events.sort((first, second) => {
    const firstMinute = first.sortMinute ?? first.time ?? 29 * 60;
    const secondMinute = second.sortMinute ?? second.time ?? 29 * 60;
    return firstMinute - secondMinute
      || (first.priority ?? 4) - (second.priority ?? 4)
      || (first.task?.order ?? first.habit?.order ?? 0) - (second.task?.order ?? second.habit?.order ?? 0);
  });
  const dawn = schedule?.times.find((item) => item.name === "الفجر");
  return [{
    type: "day-start",
    time: Number.isFinite(dawn?.time) ? prayerMinutes(dawn.time) : 5 * 60,
    label: "بداية اليوم",
  }, ...orderedEvents, {
    type: "night-prayers",
    time: null,
    habit: prayerHabit,
    items: NIGHT_PRAYERS.map((name) => prayerItemFor(prayerHabit, name)),
    today,
  }];
}

function renderPrayerSettings() {
  const location = localLocation();
  return `<label>طريقة الحساب<select data-prayer-method aria-label="طريقة حساب مواقيت الصلاة">
    ${PRAYER_METHODS.map((method) => `<option value="${method}"${selectedPrayerMethod() === method ? " selected" : ""}>${escapeHtml(prayerMethodLabel(method))}</option>`).join("")}
  </select></label>
  <div>
    <button class="space-map-action" type="button" data-action="locate">${location ? "تحديث موقعي" : "استخدم موقعي لحساب المواقيت"}</button>
    ${location ? `<button class="space-map-action" type="button" data-action="clear-location">إزالة الموقع المحفوظ</button>` : ""}
  </div>
  <small>${location
    ? `الموقع محفوظ على هذا الجهاز فقط. حساب محلي وفق ${escapeHtml(prayerMethodLabel(selectedPrayerMethod()))}؛ قد تختلف الدقائق عن تقويم المسجد.`
    : "تظهر أوقات الصلاة بعد السماح بالموقع. لا تُرسل الإحداثيات إلى خادم."}</small>`;
}

function renderTaskNode(task) {
  const done = task.status === "done";
  const priority = taskPriority(task);
  const overdue = !done && datePart(task.due || task.scheduled) < mapDate;
  const checklist = (task.checklist ?? []).map((item) =>
    typeof item === "string" ? { text: item, done: false } : item);
  const checklistDone = checklist.filter((item) => item.done).length;
  const progress = Math.round(taskCompletion(task) * 100);
  const progressState = done ? "is-done" : progress ? "is-partial" : "is-pending";
  const priorityPercent = (4 - priority) * 25;
  const detailsOpen = expandedMapTaskDetails.has(task.id);
  const meta = [overdue ? "متأخرة" : "", checklist.length ? `${formatArabicNumber(checklistDone)} / ${formatArabicNumber(checklist.length)} فرعية` : task.estimateMin ? `${formatArabicNumber(task.estimateMin)} د` : ""]
    .filter(Boolean)
    .join(" · ");
  return `<article class="space-node space-node-task priority-${priority} ${progressState}" data-priority-level="${priority}" style="--task-progress:${progress}%;--priority-progress:${priorityPercent}%">
    <span class="space-node-orbit" aria-hidden="true">✦</span>
    <div class="space-node-copy">
      <strong>${escapeHtml(task.title)}</strong>
      ${meta ? `<span class="space-node-meta">${escapeHtml(meta)}</span>` : ""}
      <div class="space-node-priority" role="img" aria-label="الأولوية ${priorityLabel(priority)}، ${formatArabicNumber(priorityPercent)} بالمئة">
        <i aria-hidden="true"><b></b></i><strong>${formatArabicNumber(priorityPercent)}٪</strong>
      </div>
      <div class="space-node-progress-row" role="img" aria-label="إنجاز المهمة ${formatArabicNumber(progress)} بالمئة">
        <i class="space-node-progress space-task-progress" aria-hidden="true"><b></b></i>
        <strong>${formatArabicNumber(progress)}٪</strong>
      </div>
      ${checklist.length || task.notes ? `<details class="space-node-details" data-map-task-details="${escapeHtml(task.id)}"${detailsOpen ? " open" : ""}>
        <summary>التفاصيل${checklist.length ? ` · ${formatArabicNumber(checklistDone)}/${formatArabicNumber(checklist.length)}` : ""}</summary>
        ${task.notes ? `<p>${escapeHtml(task.notes)}</p>` : ""}
        ${checklist.length ? `<ul>${checklist.map((item, index) => `<li><label><input type="checkbox" data-action="toggle-subtask" data-task-id="${escapeHtml(task.id)}" data-index="${index}"${item.done ? " checked" : ""}><span>${escapeHtml(item.text)}</span></label></li>`).join("")}</ul>` : ""}
        <a href="#/tasks?date=${encodeURIComponent(mapDate)}">فتح المهام</a>
      </details>` : ""}
    </div>
    <button class="space-node-check" type="button" data-action="toggle-task" data-task-id="${escapeHtml(task.id)}" aria-pressed="${done}" aria-label="${done ? "إعادة فتح" : "إنجاز"} ${escapeHtml(task.title)}">${done ? "✓" : "○"}</button>
  </article>`;
}

function renderHabitNode(habit, today) {
  const progress = dayProgress(habit, today);
  const priority = habitPriority(habit);
  const progressState = progress.complete ? "is-done" : progress.percent ? "is-partial" : "is-pending";
  const unit = habit.unit ? ` ${escapeHtml(habit.unit)}` : "";
  const progressText = progress.mode === "items"
    ? `${formatArabicNumber(progress.done)} / ${formatArabicNumber(progress.target)} بنود`
    : progress.mode === "count"
      ? `${formatArabicNumber(progress.done)} / ${formatArabicNumber(progress.total)}${unit}`
      : "";
  const nextItem = progress.mode === "items" ? habit.items.find((item) => !progress.logged.has(item.id)) : null;
  const action = progress.mode === "items"
    ? nextItem
      ? `<button class="space-node-check" type="button" data-action="toggle-prayer" data-habit-id="${escapeHtml(habit.id)}" data-item-id="${escapeHtml(nextItem.id)}" data-date="${escapeHtml(today)}" aria-label="تسجيل البند التالي من ${escapeHtml(habit.title)}">○</button>`
      : `<a class="space-node-check is-complete-link" href="#/habits?date=${encodeURIComponent(today)}" aria-label="عرض العادة المكتملة: ${escapeHtml(habit.title)}">✓</a>`
    : `<button class="space-node-check" type="button" data-action="${progress.mode === "count" ? "habit-count" : "habit-check"}" data-habit-id="${escapeHtml(habit.id)}" data-date="${escapeHtml(today)}" aria-pressed="${progress.complete}">${progress.complete ? "✓" : "○"}</button>`;

  return `<article class="space-node space-node-habit priority-${priority} ${progressState}" data-priority-level="${priority}" style="--habit-progress:${progress.percent}%">
    <span class="space-node-orbit" aria-hidden="true">✧</span>
    <div class="space-node-copy">
      <strong>${escapeHtml(habit.title)}</strong>
      ${progressText ? `<span class="space-node-meta">${progressText}</span>` : ""}
      <div class="space-node-progress-row" role="img" aria-label="إنجاز العادة ${formatArabicNumber(progress.percent)} بالمئة">
        <i class="space-node-progress" aria-hidden="true"><b></b></i>
        <strong>${formatArabicNumber(progress.percent)}٪</strong>
      </div>
    </div>
    ${action}
  </article>`;
}

function renderPrayerNode(event) {
  const { prayer, habit, item, today } = event;
  const complete = prayerStatus(item, habit, today);
  const priority = event.priority ?? 3;
  return `<article class="space-node space-node-prayer priority-${priority} ${complete ? "is-done" : "is-pending"}" data-priority-level="${priority}" aria-label="${escapeHtml(prayer.name)}: ${complete ? "مكتملة" : "لم تُسجل"}">
    <span class="space-node-orbit" aria-hidden="true">☼</span>
    <div class="space-node-copy">
      <strong>${escapeHtml(prayer.name)}</strong>
      ${Number.isFinite(prayer.time) ? `<span class="space-node-meta">${escapeHtml(formatPrayerTime(prayer.time))}</span>` : ""}
    </div>
    ${item ? `<button class="space-node-check" type="button" data-action="toggle-prayer" data-habit-id="${escapeHtml(habit.id)}" data-item-id="${escapeHtml(item.id)}" data-date="${escapeHtml(today)}" aria-pressed="${complete}" aria-label="${complete ? "إلغاء تسجيل" : "تسجيل"} ${escapeHtml(prayer.name)}">${complete ? "✓" : "○"}</button>` : ""}
  </article>`;
}

function taskCompletion(task) {
  if (task.status === "done") return 1;
  const checklist = task.checklist ?? [];
  if (!checklist.length) return 0;
  return checklist.filter((item) => typeof item === "string" ? false : item.done).length / checklist.length;
}

function renderNightNode(event) {
  const { habit, today, items } = event;
  if (!habit || items.every((item) => !item)) {
    return `<article class="space-night-node space-night-empty">
      <span class="space-night-moon" aria-hidden="true">☾</span>
      <div><strong>ختام اليوم</strong><span>قيام الليل · الشفع · الوتر</span></div>
      <a href="#/habits?date=${encodeURIComponent(mapDate)}">أضفها إلى عادة الصلاة</a>
    </article>`;
  }

  const logged = new Set(habit.itemLog?.[today] ?? []);
  const prayers = NIGHT_PRAYERS.map((name, index) => {
    const item = items[index];
    if (!item) {
      return `<span class="space-night-prayer is-unavailable"><i>✧</i>${escapeHtml(name)}</span>`;
    }
    const done = logged.has(item.id);
    const priority = habitPriority(habit);
    return `<button class="space-night-prayer priority-${priority} ${done ? "is-done" : "is-pending"}" type="button" data-priority-level="${priority}" data-action="toggle-prayer" data-habit-id="${escapeHtml(habit.id)}" data-item-id="${escapeHtml(item.id)}" data-date="${escapeHtml(today)}" aria-pressed="${done}">
      <i>${done ? "✓" : "✧"}</i>${escapeHtml(name)}
    </button>`;
  }).join("");
  return `<article class="space-night-node">
    <span class="space-night-moon" aria-hidden="true">☾</span>
    <div class="space-night-heading"><small>المحطة الأخيرة</small><strong>ختام يومك</strong></div>
    <div class="space-night-prayers">${prayers}</div>
  </article>`;
}

function renderEvent(event, index) {
  if (event.type === "night-prayers") {
    return `<div class="space-map-stop is-night" style="--node-index:${index};animation-delay:${Math.min(index * 55, 700)}ms">
      <span class="space-map-time">نهاية اليوم</span><span class="space-map-connector" aria-hidden="true"></span>
      ${renderNightNode(event)}
    </div>`;
  }

  const time = event.type === "day-start"
    ? event.time === null ? "" : formatPrayerTime(event.time / 60)
    : event.type === "prayer"
      ? Number.isFinite(event.prayer.time) ? formatPrayerTime(event.prayer.time) : ""
      : timeLabel(event.time);
  const label = event.type === "day-start" ? event.label
    : event.type === "prayer" ? event.prayer.name
      : event.type === "task" ? "مهمة"
        : "عادة";
  const node = event.type === "day-start"
    ? `<article class="space-day-start" aria-label="بداية اليوم"><span aria-hidden="true">✦</span></article>`
    : event.type === "task" ? renderTaskNode(event.task)
      : event.type === "habit" ? renderHabitNode(event.habit, mapDate)
        : renderPrayerNode({ ...event, today: mapDate });
  return `<div class="space-map-stop${index % 2 ? " is-left" : " is-right"}${event.type === "day-start" ? " is-start" : ""}" style="--node-index:${index};animation-delay:${Math.min(index * 55, 700)}ms">
    ${event.type === "day-start" ? "" : `<span class="space-map-time">${escapeHtml(time || "وقتك")}</span>`}
    <span class="space-map-connector" aria-hidden="true"></span>
    <div class="space-map-event" data-kind="${event.type}" aria-label="${escapeHtml(label)}">${node}</div>
  </div>`;
}

function buildScore(tasks, habits, today) {
  const taskDone = tasks.filter((task) => task.status === "done").length;
  const taskProgress = tasks.reduce((total, task) => total + taskCompletion(task), 0);
  const habitProgress = habits.reduce((total, habit) => total + dayProgress(habit, today).percent / 100, 0);
  const total = tasks.length + habits.length;
  return {
    percent: total ? Math.round((taskProgress + habitProgress) / total * 100) : 0,
    hasItems: total > 0,
    tasksDone: taskDone,
    habitsPercent: habits.length ? Math.round(habitProgress / habits.length * 100) : 0,
  };
}

function periodMetrics(start, end) {
  const dates = new Set(eachDate(start, end));
  const tasks = records.tasks.filter((task) => {
    if (task.status === "done") {
      return task.completedAt
        ? dates.has(datePart(task.completedAt))
        : taskDates(task).some((date) => dates.has(date));
    }
    return taskDates(task).some((date) => dates.has(date));
  });
  const completedTasks = tasks.filter((task) => task.status === "done").length;
  const taskProgress = tasks.reduce((total, task) => total + taskCompletion(task), 0);
  const habits = records.habits.filter((habit) => !habit.archived);
  let scheduledHabits = 0;
  let completedHabits = 0;
  let habitProgress = 0;
  for (const date of dates) {
    for (const habit of habits) {
      if (!scheduledHabit(habit, date)) continue;
      scheduledHabits += 1;
      const progress = dayProgress(habit, date);
      habitProgress += progress.percent / 100;
      if (progress.complete) completedHabits += 1;
    }
  }
  const total = tasks.length + scheduledHabits;
  return {
    completedTasks,
    plannedTasks: tasks.length - completedTasks,
    scheduledHabits,
    completedHabits,
    habitPercent: scheduledHabits ? Math.round((habitProgress / scheduledHabits) * 100) : 0,
    percent: total ? Math.round(((taskProgress + habitProgress) / total) * 100) : 0,
    hasItems: total > 0,
  };
}

function periodStops() {
  const date = new Date(`${mapDate}T12:00:00`);
  const bounds = mapBounds();
  if (mapMode === "week") {
    return eachDate(bounds.start, bounds.end).map((value) => {
      const dayDate = new Date(`${value}T12:00:00`);
      return {
        start: value,
        end: value,
        nextMode: "day",
        nextDate: value,
        title: new Intl.DateTimeFormat("ar", { weekday: "long" }).format(dayDate),
        subtitle: new Intl.DateTimeFormat("ar", { day: "numeric", month: "long" }).format(dayDate),
        icon: "☼",
      };
    });
  }
  if (mapMode === "month") {
    const stops = [];
    const first = new Date(`${bounds.start}T12:00:00`);
    const last = new Date(`${bounds.end}T12:00:00`);
    let weekStart = localDate(first.getFullYear(), first.getMonth(), first.getDate() - first.getDay());
    for (let week = 1; weekStart <= last; week += 1) {
      const start = weekStart < first ? bounds.start : dateString(weekStart);
      const weekEnd = localDate(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6);
      const endDate = weekEnd > last ? last : weekEnd;
      const end = dateString(endDate);
      const startDate = new Date(`${start}T12:00:00`);
      stops.push({
        start,
        end,
        nextMode: "week",
        nextDate: dateString(weekStart),
        title: `الأسبوع ${formatArabicNumber(week)}`,
        subtitle: `${new Intl.DateTimeFormat("ar", { day: "numeric", month: "short" }).format(startDate)} — ${new Intl.DateTimeFormat("ar", { day: "numeric", month: "short" }).format(endDate)}`,
        icon: "✧",
      });
      weekStart = localDate(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
    }
    return stops;
  }
  return Array.from({ length: 12 }, (_item, month) => {
    const start = dateString(localDate(date.getFullYear(), month, 1));
    const end = dateString(localDate(date.getFullYear(), month + 1, 0));
    return {
      start,
      end,
      nextMode: "month",
      nextDate: start,
      title: new Intl.DateTimeFormat("ar", { month: "long" }).format(localDate(date.getFullYear(), month, 1)),
      subtitle: `${formatArabicNumber(1)}–${formatArabicNumber(new Date(`${end}T12:00:00`).getDate())} يوم`,
      icon: "✦",
    };
  });
}

function renderPeriodStop(stop, index) {
  const metrics = periodMetrics(stop.start, stop.end);
  return `<div class="space-map-stop${index % 2 ? " is-left" : " is-right"}" style="--node-index:${index}">
    <span class="space-map-time">${escapeHtml(stop.subtitle)}</span>
    <span class="space-map-connector" aria-hidden="true"></span>
    <div class="space-map-event" data-kind="period">
      <button class="space-period-node${stop.start === localDateString() && stop.end === localDateString() ? " is-today" : ""}" type="button" data-action="open-period" data-mode="${stop.nextMode}" data-date="${stop.nextDate}" aria-label="تفاصيل ${escapeHtml(stop.title)} ${escapeHtml(stop.subtitle)}: ${formatArabicNumber(metrics.percent)} بالمئة إنجاز" style="--period-progress:${metrics.percent}%">
        <span class="space-node-orbit" aria-hidden="true">${stop.icon}</span>
        <span class="space-period-copy"><strong>${escapeHtml(stop.title)}</strong></span>
        <span class="space-period-score" role="img" aria-label="الإنجاز الكلي ${formatArabicNumber(metrics.percent)} بالمئة"><strong>${formatArabicNumber(metrics.percent)}<small>٪</small></strong></span>
      </button>
    </div>
  </div>`;
}

function renderPeriodSummary(metrics) {
  const taskTotal = metrics.completedTasks + metrics.plannedTasks;
  return `<section class="space-map-summary" aria-label="ملخص ${MAP_MODE_LABELS[mapMode]}">
    <div class="space-map-summary-score" role="img" aria-label="الإنجاز الكلي ${formatArabicNumber(metrics.percent)} بالمئة" style="--period-progress:${metrics.percent}%">
      <strong>${formatArabicNumber(metrics.percent)}<small>٪</small></strong><span>الإنجاز</span>
    </div>
    <div class="space-map-summary-metrics">
      <div class="space-map-summary-item" aria-label="المهام: ${formatArabicNumber(metrics.completedTasks)} من ${formatArabicNumber(taskTotal)}">
        <span aria-hidden="true">✓</span><strong>المهام</strong><small>${formatArabicNumber(metrics.completedTasks)} / ${formatArabicNumber(taskTotal)}</small>
      </div>
      <div class="space-map-summary-item is-habit" aria-label="العادات: ${formatArabicNumber(metrics.completedHabits)} من ${formatArabicNumber(metrics.scheduledHabits)}">
        <span aria-hidden="true">✦</span><strong>العادات</strong><small>${formatArabicNumber(metrics.completedHabits)} / ${formatArabicNumber(metrics.scheduledHabits)}</small>
      </div>
    </div>
  </section>`;
}

function renderMapControls() {
  const parentMode = mapParentMode ?? { day: "week", week: "month", month: "year" }[mapMode];
  return `<div class="space-map-controls">
    <nav class="space-map-modes" aria-label="مدى خارطة اليوم">
      ${MAP_MODES.map((mode) => `<button type="button" data-action="map-mode" data-mode="${mode}" aria-pressed="${mapMode === mode}">${MAP_MODE_LABELS[mode]}</button>`).join("")}
    </nav>
    <nav class="space-map-period-controls" aria-label="التنقل بين الفترات: ${escapeHtml(formatMapPeriod())}">
      ${parentMode ? `<button type="button" data-action="map-parent" aria-label="العودة إلى ${MAP_MODE_LABELS[parentMode]}">↗ ${MAP_MODE_LABELS[parentMode]}</button>` : ""}
      <button type="button" data-action="map-shift" data-direction="-1" aria-label="الفترة السابقة">‹</button>
      ${mapMode === "day" ? "" : `<strong>${escapeHtml(formatMapPeriod())}</strong>`}
      <button type="button" data-action="map-shift" data-direction="1" aria-label="الفترة التالية">›</button>
      <button type="button" data-action="map-today">اليوم</button>
    </nav>
  </div>`;
}

function render() {
  const app = document.querySelector("#app");
  if (!app || !isMounted) return;
  const selectedDate = mapDate;
  const tasks = dayTasks(selectedDate).sort((first, second) =>
    taskPriority(first) - taskPriority(second)
    || (Number(first.order) || 0) - (Number(second.order) || 0));
  const habits = dayHabits(selectedDate).sort((first, second) =>
    (first.dailyTime ?? "99:99").localeCompare(second.dailyTime ?? "99:99")
    || habitPriority(first) - habitPriority(second)
    || (Number(first.order) || 0) - (Number(second.order) || 0));
  const score = mapMode === "day"
    ? buildScore(tasks, habits, selectedDate)
    : periodMetrics(mapBounds().start, mapBounds().end);
  let schedule;
  let scheduleError = false;
  if (mapMode === "day") {
    try {
      schedule = prayerSchedule(selectedDate);
    } catch (error) {
      console.error("تعذّر حساب مواقيت الصلاة:", error);
      scheduleError = true;
    }
  }
  const dayEvents = mapMode === "day" ? buildEvents(tasks, habits, schedule, selectedDate) : [];
  const overviewStops = mapMode === "day" ? [] : periodStops();
  const stops = mapMode === "day" ? dayEvents.map(renderEvent).join("") : overviewStops.map(renderPeriodStop).join("");
  const periodHeading = { week: "أيام الأسبوع", month: "أسابيع الشهر", year: "أشهر العام" }[mapMode];
  const progressState = !score.hasItems ? "is-empty" : score.percent === 100 ? "is-done" : score.percent ? "is-partial" : "is-pending";
  const location = mapMode === "day" ? localLocation() : null;
  app.innerHTML = `<section class="cosmic-day" aria-label="خارطة ${MAP_MODE_LABELS[mapMode]}">
    <div class="cosmic-map" style="--map-length:${mapMode === "day" ? dayEvents.length : overviewStops.length}" data-prayer-state="${mapMode !== "day" ? "range" : location ? "ready" : scheduleError ? "error" : "needs-location"}">
      <div class="cosmic-map-stars" aria-hidden="true"></div>
      <div class="cosmic-map-nebula cosmic-map-nebula-one" aria-hidden="true"></div>
      <div class="cosmic-map-nebula cosmic-map-nebula-two" aria-hidden="true"></div>
      <header class="cosmic-day-heading">
        <div><h2>${mapMode === "day" ? escapeHtml(formatMapPeriod()) : periodHeading}</h2></div>
        <div class="cosmic-day-progress ${progressState}" role="progressbar" aria-label="إنجاز ${MAP_MODE_LABELS[mapMode]}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${score.percent}" style="--progress:${score.percent}%">
          <strong>${formatArabicNumber(score.percent)}<small>٪</small></strong>
          <span class="cosmic-day-progress-track" aria-hidden="true"><i></i></span>
        </div>
      </header>
      ${renderMapControls()}
      ${mapMode === "day" ? `<nav class="space-map-day-links" aria-label="تفاصيل ${escapeHtml(formatDate(mapDate))}">
        <a href="#/tasks?date=${encodeURIComponent(mapDate)}">مهام اليوم <strong>${formatArabicNumber(tasks.length)}</strong></a>
        <a href="#/habits?date=${encodeURIComponent(mapDate)}">عادات اليوم <strong>${formatArabicNumber(habits.length)}</strong></a>
      </nav>` : ""}
      ${mapMode === "day" ? "" : renderPeriodSummary(score)}
      <div class="cosmic-map-route${mapMode === "day" ? "" : " is-overview"}" aria-label="${mapMode === "day" ? "تتابع محطات اليوم" : `محطات ${MAP_MODE_LABELS[mapMode]}`}">
        ${stops}
      </div>
      <footer class="cosmic-map-footer">
        <span>${mapMode !== "day" ? "اختر محطة للتعمق في تفاصيلها" : scheduleError ? "تعذّر حساب المواقيت. راجع طريقة الحساب والموقع." : location
          ? `المواقيت وفق ${escapeHtml(prayerMethodLabel(schedule?.method))} · الحساب على جهازك`
          : "أوقات الصلاة تقديرية حتى تحدد موقعك"}</span>
        ${mapMode === "day" ? `<details class="space-map-settings">
          <summary>الموقع والمواقيت</summary>
          <div class="space-map-settings-content">
            ${renderPrayerSettings()}
          </div>
        </details>` : ""}
      </footer>
    </div>
  </section>`;
}

async function locateDevice() {
  if (!navigator.geolocation) {
    showToast("هذا المتصفح لا يدعم تحديد الموقع.", { isError: true });
    return;
  }
  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 5 * 60 * 1000,
      });
    });
    localStorage.setItem("mihwar-prayer-location", JSON.stringify({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      savedAt: new Date().toISOString(),
    }));
    render();
    showToast("حُفظ الموقع على جهازك وحُسبت المواقيت محلياً.");
  } catch (error) {
    console.error("تعذّر تحديد الموقع لمواقيت الصلاة:", error);
    const message = error.code === 1 ? "لم يُسمح بالوصول إلى الموقع. يمكنك السماح به من إعدادات المتصفح."
      : error.code === 3 ? "انتهت مهلة تحديد الموقع. حاول مجدداً."
        : "تعذّر تحديد الموقع. تحقق من إعدادات الجهاز وحاول مجدداً.";
    showToast(message, { isError: true });
  }
}

async function toggleTask(task, completionDetails = null) {
  const now = new Date().toISOString();
  if (task.status !== "done") {
    if (!completionDetails) throw new Error("يلزم تسجيل وقت الإنجاز ومدته أولاً.");
    await update("tasks", {
      ...task,
      status: "done",
      completedAt: completionDetails.completedAt,
      completionLog: [...(Array.isArray(task.completionLog) ? task.completionLog : []), completionDetails],
      timeSpentMin: Math.max(0, Number(task.timeSpentMin) || 0) + completionDetails.durationMin,
      updatedAt: now,
    });
    if (task.recurrence) {
      const nextDate = nextOccurrence(task.scheduled || task.due, task.recurrence);
      await add("tasks", {
        ...task,
        id: crypto.randomUUID(),
        scheduled: nextDate,
        due: task.due ? nextDate : null,
        status: "open",
        completedAt: null,
        completionLog: [],
        timeSpentMin: 0,
        order: Date.now(),
        createdAt: now,
        updatedAt: now,
      });
    }
    return;
  }
  await update("tasks", { ...task, status: "open", completedAt: null, updatedAt: now });
}

function bindEvents(app) {
  eventController?.abort();
  eventController = new AbortController();
  const { signal } = eventController;

  app.addEventListener("toggle", (event) => {
    const details = event.target.closest("[data-map-task-details]");
    if (!details) return;
    const taskId = details.dataset.mapTaskDetails;
    if (details.open) expandedMapTaskDetails.add(taskId);
    else expandedMapTaskDetails.delete(taskId);
  }, { capture: true, signal });

  app.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    if (button.dataset.action === "map-mode") {
      if (!MAP_MODES.includes(button.dataset.mode)) return;
      mapMode = button.dataset.mode;
      mapParentMode = null;
      saveMapSelection();
      render();
      return;
    }
    if (button.dataset.action === "map-shift") {
      const direction = Number(button.dataset.direction);
      if (direction === -1 || direction === 1) shiftMapPeriod(direction);
      return;
    }
    if (button.dataset.action === "map-today") {
      mapMode = "day";
      mapDate = localDateString();
      mapParentMode = null;
      saveMapSelection();
      render();
      return;
    }
    if (button.dataset.action === "map-parent") {
      const parentMode = { day: "week", week: "month", month: "year" }[mapMode];
      const targetMode = mapParentMode ?? parentMode;
      if (!targetMode) return;
      mapMode = targetMode;
      mapParentMode = null;
      saveMapSelection();
      render();
      return;
    }
    if (button.dataset.action === "open-period") {
      if (!MAP_MODES.includes(button.dataset.mode) || !/^\d{4}-\d{2}-\d{2}$/.test(button.dataset.date ?? "")) return;
      mapParentMode = mapMode;
      mapMode = button.dataset.mode;
      mapDate = button.dataset.date;
      saveMapSelection();
      render();
      return;
    }
    if (button.dataset.action === "locate") {
      await locateDevice();
      return;
    }
    if (button.dataset.action === "clear-location") {
      localStorage.removeItem("mihwar-prayer-location");
      render();
      showToast("أُزيل الموقع المحفوظ من هذا الجهاز.");
      return;
    }
    if (button.dataset.action === "toggle-task") {
      const task = records.tasks.find((item) => item.id === button.dataset.taskId);
      if (!task) return;
      try {
        const completionDetails = task.status === "done"
          ? null
          : await requestCompletionDetails({ title: task.title });
        if (task.status !== "done" && !completionDetails) return;
        await toggleTask(task, completionDetails);
      } catch (error) {
        console.error("تعذّر تحديث المهمة من خارطة اليوم:", error);
        showToast(error.message || "تعذّر تحديث المهمة. حاول مجدداً.", { isError: true });
      }
      return;
    }

    const habit = records.habits.find((item) => item.id === button.dataset.habitId);
    if (!habit) return;
    const today = button.dataset.date && /^\d{4}-\d{2}-\d{2}$/.test(button.dataset.date) ? button.dataset.date : mapDate;
    try {
      if (button.dataset.action === "habit-check") {
        const nextComplete = !dayProgress(habit, today).complete;
        const details = nextComplete
          ? await requestCompletionDetails({ title: habit.title, date: today })
          : null;
        if (nextComplete && !details) return;
        let next = setDayComplete(habit, today, nextComplete);
        if (details) next = setCompletionDetails(next, today, details);
        await update("habits", next);
      } else if (button.dataset.action === "habit-count") {
        const progress = dayProgress(habit, today);
        const wasComplete = progress.complete;
        const value = Math.min(progress.total, progress.done + 1);
        const next = { ...habit, progress: { ...(habit.progress ?? {}), [today]: value }, updatedAt: new Date().toISOString() };
        let updated = setDayComplete(next, today, value >= progress.total);
        updated.progress = next.progress;
        if (value < progress.total) delete updated.history[today];
        if (!wasComplete && value >= progress.total) {
          const details = await requestCompletionDetails({ title: habit.title, date: today });
          if (!details) return;
          updated = setCompletionDetails(updated, today, details);
        }
        await update("habits", updated);
      } else if (button.dataset.action === "toggle-prayer") {
        const wasComplete = dayProgress(habit, today).complete;
        const logged = new Set(habit.itemLog?.[today] ?? []);
        if (logged.has(button.dataset.itemId)) logged.delete(button.dataset.itemId);
        else logged.add(button.dataset.itemId);
        let next = setItemsLogged(habit, today, [...logged]);
        if (!wasComplete && dayProgress(next, today).complete) {
          const details = await requestCompletionDetails({ title: habit.title, date: today });
          if (!details) return;
          next = setCompletionDetails(next, today, details);
        }
        await update("habits", next);
      }
    } catch (error) {
      console.error("تعذّر تحديث العادة من خارطة اليوم:", error);
      showToast(error.message || "تعذّر تحديث العادة. حاول مجدداً.", { isError: true });
    }
  }, { signal });

  app.addEventListener("change", (event) => {
    const subtask = event.target.closest('[data-action="toggle-subtask"]');
    if (subtask) {
      const task = records.tasks.find((item) => item.id === subtask.dataset.taskId);
      if (!task) return;
      const checklist = (task.checklist ?? []).map((item) =>
        typeof item === "string" ? { text: item, done: false } : { ...item });
      const item = checklist[Number(subtask.dataset.index)];
      if (!item) return;
      item.done = subtask.checked;
      update("tasks", { ...task, checklist, updatedAt: new Date().toISOString() })
        .catch((error) => {
          console.error("تعذّر تحديث المهمة الفرعية من الخارطة:", error);
          showToast("تعذّر تحديث المهمة الفرعية. حاول مجدداً.", { isError: true });
        });
      return;
    }
    const select = event.target.closest("[data-prayer-method]");
    if (!select || !PRAYER_METHODS.includes(select.value)) return;
    localStorage.setItem("mihwar-prayer-method", select.value);
    render();
  }, { signal });
}

export async function mountTodayView(isCurrent = () => true) {
  if (!isCurrent()) return;
  unsubscribe?.();
  const [tasks, habits] = await Promise.all([getRecords("tasks"), getRecords("habits")]);
  if (!isCurrent()) return;
  const requestedDate = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("date") ?? "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    mapDate = requestedDate;
    mapMode = "day";
    mapParentMode = null;
    saveMapSelection();
  }
  records = { tasks, habits };
  isMounted = true;
  document.querySelector("#page-title").textContent = "اليوم";
  const app = document.querySelector("#app");
  if (!app) return;
  bindEvents(app);
  render();
  unsubscribe = subscribe((state, change) => {
    if (!change.storeName || ["tasks", "habits"].includes(change.storeName)) {
      records = { tasks: state.tasks ?? records.tasks, habits: state.habits ?? records.habits };
      render();
    }
  });
}

export function unmountTodayView() {
  isMounted = false;
  unsubscribe?.();
  unsubscribe = undefined;
  eventController?.abort();
  eventController = undefined;
}

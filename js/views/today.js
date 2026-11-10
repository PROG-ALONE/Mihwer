import { add, getRecords, subscribe, update } from "../store.js";
import { formatDate, localDateString } from "../utils/dates.js";
import { nextOccurrence } from "../utils/recurrence.js";
import { getKeyResultProgress } from "../utils/okr.js";
import {
  calculatePrayerTimes,
  formatPrayerTime,
  prayerMethodLabel,
} from "../utils/prayer-times.js";
import { dayProgress, ensureDailyRitualHabits, setCompletionDetails, setDayComplete, setItemsLogged } from "./habits.js";
import { showToast } from "../utils/notifications.js";
import { requestCompletionDetails } from "../utils/completion-dialog.js";
import { completedSubtaskCount, completedSubtasksOn, formatDuration, manualTaskMinutes } from "../utils/task-metrics.js";
import { isTaskCountedInRange, isTaskCountedOn, isTaskScheduledInRange, isTaskScheduledOn } from "../utils/task-schedule.js";
import { shareTextReport } from "../export/share.js";
import { printStructuredReport } from "../export/pdf.js";
import { animatedDayStoryFile, shareOrDownloadStoryFile } from "../export/day-story.js";
import { animatedPeriodStoryFile } from "../export/period-story.js";

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
const PRAYER_WISDOM = {
  الفجر: { text: "ركعتا الفجر خير من الدنيا وما فيها", source: "مسلم، ٧٢٥" },
  الظهر: { text: "أحب الأعمال إلى الله الصلاة لوقتها", source: "البخاري، ٥٢٧ · مسلم، ٨٥" },
  العصر: { text: "من صلى البردين دخل الجنة", source: "البخاري، ٥٧٤ · مسلم، ٦٣٥" },
  المغرب: { text: "بين كل أذانين صلاة لمن شاء", source: "البخاري، ٦٢٧" },
  العشاء: { text: "لو يعلمون ما في العتمة والصبح لأتوهما ولو حبوا", source: "البخاري، ٦٥٧ · مسلم، ٦٥١" },
};
const PRAYER_ORDER_IF_LOCATION_UNAVAILABLE = {
  الفجر: 5 * 60,
  الظهر: 12 * 60,
  العصر: 15 * 60 + 30,
  المغرب: 18 * 60,
  العشاء: 20 * 60,
};
const LOW_PROGRESS_THRESHOLD = 50;

let unsubscribe;
let eventController;
let clockInterval;
let storyPlaybackInterval;
let isMounted = false;
let activeStoryEvents = [];
let records = { tasks: [], habits: [], objectives: [], keyResults: [], lifeAreas: [], sessions: [], device: [], profile: [] };
let recapMode = "day";
let recapAnchorDate = localDateString();
let recapSelectedDate = "";
let recapStart = "";
let recapEnd = "";
let recapLabel = "";
let mapMode = MAP_MODES.includes(localStorage.getItem("mihwar-map-mode"))
  ? localStorage.getItem("mihwar-map-mode")
  : "day";
let mapParentMode = MAP_MODES.includes(localStorage.getItem("mihwar-map-parent-mode"))
  ? localStorage.getItem("mihwar-map-parent-mode")
  : null;
let mapDate = /^\d{4}-\d{2}-\d{2}$/.test(localStorage.getItem("mihwar-map-date") ?? "")
  ? localStorage.getItem("mihwar-map-date")
  : dateOffset(localDateString(), -1);
const expandedMapTaskDetails = new Set();
const periodDayMetricsCache = new Map();
let activeStoryIndex = 0;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function taskLifeAreaId(task) {
  return task.lifeAreaId ?? objectiveForTask(task)?.lifeAreaId ?? null;
}

function objectiveForTask(task) {
  const objectiveId = task.objectiveId ??
    records.keyResults.find((result) => result.id === task.keyResultId)?.objectiveId;
  return records.objectives.find((objective) => objective.id === objectiveId);
}

function habitLifeAreaId(habit) {
  return habit.lifeAreaId ?? records.objectives.find((objective) => objective.id === habit.objectiveId)?.lifeAreaId ?? null;
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
  return isTaskScheduledOn(task, date, true) ||
    (date === localDateString() && dates.some((taskDate) => taskDate < date));
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

function dateOffset(value, offset) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return dateString(date);
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
  return new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
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
  return Number.isInteger(hour) && hour >= 0 && hour < 24
    && Number.isInteger(minute) && minute >= 0 && minute < 60
    ? hour * 60 + minute
    : null;
}

function wakeTimeFor(date) {
  const value = sleepLogFor(date)?.wakeTime ?? "";
  return clockMinutes(value) === null ? "" : value;
}

function sleepLogFor(date) {
  return records.device.find((entry) => entry.id === `sleep-log:${date}`);
}

function sleepSettings() {
  return records.profile.find((profile) => profile.id === "user")?.sleepSettings ?? {};
}

function sleepBedtimeFor(date) {
  const bedtime = sleepLogFor(date)?.bedTime;
  return clockMinutes(bedtime) !== null ? bedtime : learnedSleepPattern(date).bedtime;
}

function sleepLogsBefore(date, days = 14) {
  const start = localDate(new Date(`${date}T12:00:00`).getFullYear(), new Date(`${date}T12:00:00`).getMonth(),
    new Date(`${date}T12:00:00`).getDate() - days);
  const startDate = dateString(start);
  return records.device.filter((entry) =>
    String(entry.id).startsWith("sleep-log:") && entry.date >= startDate && entry.date < date);
}

function averageMinute(values, circular = false) {
  const valid = values.map(clockMinutes).filter((minute) => minute !== null);
  if (!valid.length) return null;
  if (!circular) return Math.round(valid.reduce((sum, minute) => sum + minute, 0) / valid.length);
  const radians = valid.map((minute) => minute / 1440 * Math.PI * 2);
  const sin = radians.reduce((sum, angle) => sum + Math.sin(angle), 0);
  const cos = radians.reduce((sum, angle) => sum + Math.cos(angle), 0);
  return (Math.round((Math.atan2(sin, cos) / (Math.PI * 2) * 1440 + 1440) % 1440));
}

function minuteTime(minute) {
  if (!Number.isFinite(minute)) return "";
  const normalized = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function learnedSleepPattern(beforeDate = dateString(new Date())) {
  const logs = sleepLogsBefore(beforeDate);
  const wakeMinute = averageMinute(logs.map((entry) => entry.wakeTime));
  const bedtimeMinute = averageMinute(logs.map((entry) => entry.bedTime), true);
  const sleepMinutes = logs.flatMap((entry) => {
    const previousDate = dateString(new Date(new Date(`${entry.date}T12:00:00`).setDate(new Date(`${entry.date}T12:00:00`).getDate() - 1)));
    const previousBedtime = sleepLogFor(previousDate)?.bedTime;
    const bedtime = clockMinutes(previousBedtime);
    const wake = clockMinutes(entry.wakeTime);
    return bedtime !== null && wake !== null ? [(wake - bedtime + 1440) % 1440] : [];
  });
  const napLogs = logs.filter((entry) => Number(entry.napDurationMin) > 0);
  const napLoggedDays = logs.filter((entry) => Number.isFinite(Number(entry.napDurationMin))).length;
  const napMinutes = napLogs.length
    ? Math.round(napLogs.reduce((sum, entry) => sum + Number(entry.napDurationMin), 0) / napLogs.length)
    : null;
  const bedtime = bedtimeMinute === null
    ? sleepSettings().bedtime ?? "00:00"
    : minuteTime(bedtimeMinute);
  const chronotype = logs.length < 3 || wakeMinute === null
    ? "قيد التعلّم"
    : wakeMinute < 390 && bedtimeMinute !== null && bedtimeMinute >= 1260
      ? "صباحي"
      : wakeMinute >= 480 || (bedtimeMinute !== null && bedtimeMinute < 120)
        ? "مسائي"
        : "متوازن";
  return {
    logs,
    wakeTime: wakeMinute === null ? "" : minuteTime(wakeMinute),
    bedtime,
    averageSleepMin: sleepMinutes.length
      ? Math.round(sleepMinutes.reduce((sum, minutes) => sum + minutes, 0) / sleepMinutes.length)
      : null,
    averageNapMin: napMinutes,
    averageNapStart: napLogs.length
      ? minuteTime(averageMinute(napLogs.map((entry) => entry.napStart), true))
      : "",
    napDays: napLogs.length,
    napLoggedDays,
    chronotype,
  };
}

function formatSleepDuration(minutes) {
  if (!Number.isFinite(minutes)) return "—";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${formatArabicNumber(hours)} س ${formatArabicNumber(remainder)} د`;
}

function currentTimeValue(date = new Date()) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function prayerMinutes(value) {
  return Number.isFinite(value) ? Math.round(value * 60) % 1440 : null;
}

function linkedPrayerHabit() {
  return records.habits.find((habit) =>
    !habit.archived && habit.mode === "items" && /صلاة|الصلوات/.test(habit.title ?? ""));
}

function prayerItemFor(habit, prayerName) {
  const prayerWord = prayerName.replace(/^ال/, "");
  return (habit?.items ?? []).find((item) =>
    item.category === "نافلة"
    && (item.name.includes(prayerName) || item.name.includes(prayerWord))) ?? null;
}

function prayerItemsFor(habit, prayerName) {
  const prayerWord = prayerName.replace(/^ال/, "");
  return (habit?.items ?? []).filter((item) =>
    ["فرض", "سنة"].includes(item.category)
    && (item.name.includes(prayerName) || item.name.includes(prayerWord)));
}

function openPrayerLog(habit, prayerName, date) {
  const dialog = document.querySelector("#space-prayer-log-dialog");
  if (!dialog) return;
  const items = prayerItemsFor(habit, prayerName);
  const logged = new Set(habit.itemLog?.[date] ?? []);
  const renderCategory = (category) => {
    const categoryItems = items.filter((item) => item.category === category);
    if (!categoryItems.length) return "";
    const done = categoryItems.filter((item) => logged.has(item.id)).length;
    return `<section class="space-prayer-dialog-group" data-prayer-category-group="${category}">
      <header><strong>${category}</strong><span data-prayer-count>${formatArabicNumber(done)} / ${formatArabicNumber(categoryItems.length)}</span>
        <div><button type="button" data-action="prayer-mark-category" data-category="${category}" data-complete="true">أكملها</button><button type="button" data-action="prayer-mark-category" data-category="${category}" data-complete="false">لم أصلِّها</button></div>
      </header>
      <div class="space-prayer-dialog-items">${categoryItems.map((item) => `<label data-prayer-item data-category="${category}">
        <input type="checkbox" name="item-id" value="${escapeHtml(item.id)}"${logged.has(item.id) ? " checked" : ""}>
        <span><strong>${escapeHtml(item.name)}</strong><small>${formatArabicNumber(item.amount || 0)} ${escapeHtml(item.unit || "ركعة")}</small></span>
        <i aria-hidden="true">${logged.has(item.id) ? "✓" : ""}</i>
      </label>`).join("")}</div>
    </section>`;
  };
  dialog.innerHTML = `<form data-prayer-log-form data-habit-id="${escapeHtml(habit.id)}" data-prayer="${escapeHtml(prayerName)}" data-date="${escapeHtml(date)}">
    <div class="space-prayer-dialog-heading">
      <div><small>تسجيل الصلاة</small><h2>صلاة ${escapeHtml(prayerName)}</h2></div>
      <button class="icon-button" type="button" data-action="close-prayer-log" aria-label="إغلاق">×</button>
    </div>
    <p>علّم الفرض والسنن التي أديتها، أو أزل العلامة إذا لم تصلِّها.</p>
    ${renderCategory("فرض")}
    ${renderCategory("سنة")}
    <div class="space-prayer-dialog-actions">
      <button class="button button-secondary" type="button" data-action="close-prayer-log">إلغاء</button>
      <button class="button button-primary" type="submit">حفظ تسجيل الصلاة</button>
    </div>
  </form>`;
  dialog.showModal();
}

function prayerStatus(item, habit, today) {
  return Boolean(item && (habit?.itemLog?.[today] ?? []).includes(item.id));
}

function buildEvents(tasks, habits, schedule, today) {
  const prayerHabit = linkedPrayerHabit();
  const prayerEvents = (schedule?.times ?? Object.keys(PRAYER_ITEM_NAMES).map((name) => ({ name, time: null })))
    .filter((prayer) => Object.hasOwn(PRAYER_ITEM_NAMES, prayer.name));
  const prayerMinutesByName = new Map(prayerEvents.map((prayer) =>
    [prayer.name, Number.isFinite(prayer.time) ? prayerMinutes(prayer.time) : PRAYER_ORDER_IF_LOCATION_UNAVAILABLE[prayer.name]]));
  const ritualTime = (habit) => {
    if (habit.dailyTime) return habit.dailyTime;
    const title = habit.title ?? "";
    const fajr = prayerMinutesByName.get("الفجر");
    const maghrib = prayerMinutesByName.get("المغرب");
    if (/الضحى/.test(title)) return minuteTime((fajr + 120) % 1440);
    if (/أذكار الصباح/.test(title)) return minuteTime((fajr + 20) % 1440);
    if (/أذكار المساء/.test(title)) return minuteTime(maghrib);
    return null;
  };
  const visibleHabits = habits.filter((habit) => habit.id !== prayerHabit?.id);
  const events = [
    ...tasks.map((task) => ({
      type: "task",
      time: task.dueTime ?? null,
      sortMinute: clockMinutes(task.dueTime),
      priority: taskPriority(task),
      task,
    })),
    ...visibleHabits.map((habit) => ({
      type: "habit",
      time: ritualTime(habit),
      sortMinute: clockMinutes(ritualTime(habit)),
      priority: habitPriority(habit),
      habit,
      ritual: /الضحى|أذكار الصباح|أذكار المساء/.test(habit.title ?? ""),
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
        items: prayerItemsFor(prayerHabit, prayer.name),
      };
    }),
  ];

  const flexibleEvents = events.filter((event) => event.type !== "prayer"
    && event.sortMinute === null && event.time === null);
  const flexStart = 7 * 60;
  const flexEnd = 21 * 60;
  flexibleEvents.forEach((event, index) => {
    event.sortMinute = flexStart + Math.round(((flexEnd - flexStart) * (index + 1)) / (flexibleEvents.length + 1));
    event.displayTime = event.time ?? `${String(Math.floor(event.sortMinute / 60)).padStart(2, "0")}:${String(event.sortMinute % 60).padStart(2, "0")}`;
  });
  const orderedEvents = events.sort((first, second) => {
    const firstMinute = first.sortMinute ?? first.time ?? 29 * 60;
    const secondMinute = second.sortMinute ?? second.time ?? 29 * 60;
    return firstMinute - secondMinute
      || (first.priority ?? 4) - (second.priority ?? 4)
      || (first.task?.order ?? first.habit?.order ?? 0) - (second.task?.order ?? second.habit?.order ?? 0);
  });
  const routeEvents = [...orderedEvents, {
    type: "night-prayers",
    time: null,
    habit: prayerHabit,
    today,
  }];
  return routeEvents.sort((first, second) =>
    (first.sortMinute ?? first.time ?? 29 * 60) - (second.sortMinute ?? second.time ?? 29 * 60)
    || (first.priority ?? 4) - (second.priority ?? 4));
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

function renderSleepDialog(date) {
  const log = sleepLogFor(date) ?? {};
  const previousDate = dateOffset(date, -1);
  const previousLog = sleepLogFor(previousDate) ?? {};
  const preferences = sleepSettings();
  const wakeTime = wakeTimeFor(date);
  const wakeValue = wakeTime || (date === localDateString() ? currentTimeValue() : "");
  const previousBedtime = clockMinutes(previousLog.bedTime) === null ? "" : previousLog.bedTime;
  const napStart = log.napStart ?? (preferences.napExpected ? preferences.napTime : "");
  const napDuration = Number(log.napDurationMin) > 0 ? log.napDurationMin : "";
  const dialog = document.querySelector("#space-sleep-dialog");
  if (!dialog) return;
  dialog.innerHTML = `<div class="space-sleep-dialog-content">
    <header class="space-sleep-dialog-heading">
      <div><small>إيقاع يومك</small><h2>تفاصيل النوم</h2></div>
      <button class="icon-button" type="button" data-action="close-sleep-dialog" aria-label="إغلاق">×</button>
    </header>
    <div class="space-sleep-dialog-grid">
      <section class="space-sleep-panel">
        <h3>وقت الاستيقاظ</h3>
        <label>وقت الاستيقاظ
          <input type="time" data-wake-time value="${escapeHtml(wakeValue)}" aria-label="وقت الاستيقاظ لهذا اليوم">
        </label>
        <button type="button" data-action="save-wake-time">${wakeTime ? "تحديث وقت الاستيقاظ" : "تسجيل وقت الاستيقاظ"}</button>
      </section>
      <section class="space-sleep-panel">
        <h3>نوم الليلة الماضية</h3>
        <label>وقت النوم
          <input type="time" data-previous-bedtime value="${escapeHtml(previousBedtime)}" aria-label="وقت نوم الليلة السابقة">
        </label>
        <button type="button" data-action="save-previous-bedtime">${previousBedtime ? "تحديث وقت النوم" : "تسجيل وقت النوم"}</button>
      </section>
      <section class="space-sleep-panel space-sleep-nap-panel">
        <h3>قيلولة اليوم</h3>
        <div class="space-sleep-nap-fields">
          <label>وقت البداية
            <input type="time" data-nap-start value="${escapeHtml(napStart)}" aria-label="بداية القيلولة">
          </label>
          <label>المدة بالدقائق
            <input type="number" data-nap-duration min="1" max="240" step="1" value="${escapeHtml(napDuration)}" aria-label="مدة القيلولة بالدقائق">
          </label>
        </div>
        <div class="space-sleep-panel-actions">
          <button type="button" data-action="save-nap">تسجيل القيلولة</button>
          <button class="space-sleep-skip" type="button" data-action="skip-nap">لم آخذ قيلولة</button>
        </div>
      </section>
    </div>
    <div class="space-sleep-dialog-actions">
      <button class="button button-secondary" type="button" data-action="close-sleep-dialog">إغلاق</button>
    </div>
  </div>`;
  if (!dialog.open) dialog.showModal();
}

function renderDayStart() {
  return `<article class="space-day-start" aria-label="تفاصيل النوم">
    <div class="space-day-start-copy">
      <button class="space-sleep-card" type="button" data-action="open-sleep-dialog">
        <strong>تفاصيل النوم</strong>
      </button>
    </div>
  </article>`;
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
  const detailsOpen = expandedMapTaskDetails.has(task.id);
  const bedtimeWarning = task.status !== "done" && isHeavyTaskNearBedtime(task, mapDate);
  const meta = [overdue ? "متأخرة" : "", bedtimeWarning ? "قرب موعد النوم" : "", task.estimateMin ? `${formatArabicNumber(task.estimateMin)} دقيقة` : ""]
    .filter(Boolean)
    .join(" · ");
  return `<article class="space-node space-node-task priority-${priority} ${progressState}" data-priority-level="${priority}" data-action="toggle-task" data-card-action data-task-id="${escapeHtml(task.id)}" role="button" tabindex="0" aria-pressed="${done}" aria-label="${done ? "إعادة فتح" : "إنجاز"} ${escapeHtml(task.title)}" style="--task-progress:${progress}%">
    <div class="space-node-copy">
      <strong>${escapeHtml(task.title)}</strong>
      ${checklist.length ? `<span class="space-node-meta">${formatArabicNumber(checklistDone)} من ${formatArabicNumber(checklist.length)} خطوات</span>` : ""}
      ${meta ? `<span class="space-node-meta">${escapeHtml(meta)}</span>` : ""}
      ${checklist.length || task.notes ? `<details class="space-node-details" data-map-task-details="${escapeHtml(task.id)}"${detailsOpen ? " open" : ""}>
        <summary>التفاصيل${checklist.length ? ` · ${formatArabicNumber(checklistDone)}/${formatArabicNumber(checklist.length)}` : ""}</summary>
        ${task.notes ? `<p>${escapeHtml(task.notes)}</p>` : ""}
        ${checklist.length ? `<ul>${checklist.map((item, index) => `<li><label><input type="checkbox" data-action="toggle-subtask" data-task-id="${escapeHtml(task.id)}" data-index="${index}" data-date="${escapeHtml(mapDate)}"${item.done ? " checked" : ""}><span>${escapeHtml(item.text)}</span></label></li>`).join("")}</ul>` : ""}
        <a href="#/tasks?date=${encodeURIComponent(mapDate)}">فتح المهام</a>
      </details>` : ""}
    </div>
  </article>`;
}

function isHeavyTaskNearBedtime(task, date) {
  if (taskPriority(task) > 1) return false;
  const taskMinute = clockMinutes(task.dueTime);
  const bedtimeMinute = clockMinutes(sleepBedtimeFor(date));
  if (taskMinute === null || bedtimeMinute === null) return false;
  const minutesUntilBedtime = (bedtimeMinute - taskMinute + 1440) % 1440;
  return minutesUntilBedtime > 0 && minutesUntilBedtime <= 180;
}

function isWithinPersonalDay(date, time) {
  const minute = clockMinutes(time);
  const wakeMinute = clockMinutes(wakeTimeFor(date));
  const bedtimeMinute = clockMinutes(sleepBedtimeFor(date));
  if (minute === null || wakeMinute === null) return true;
  if (bedtimeMinute === null || bedtimeMinute <= wakeMinute) return minute >= wakeMinute;
  return minute >= wakeMinute && minute < bedtimeMinute;
}

function renderHabitNode(habit, today) {
  const progress = dayProgress(habit, today);
  const priority = habitPriority(habit);
  const progressState = progress.complete ? "is-done" : progress.percent ? "is-partial" : "is-pending";
  const unit = habit.unit ? ` ${escapeHtml(habit.unit)}` : "";
  const progressText = progress.mode === "items"
    ? `${formatArabicNumber(progress.done)} من ${formatArabicNumber(progress.target)}${unit || " بنود"}`
    : progress.mode === "count"
      ? `${formatArabicNumber(progress.done)} من ${formatArabicNumber(progress.total)}${unit}`
      : "";
  const ritualWisdom = /الضحى/.test(habit.title ?? "")
    ? { text: "ويجزئ من ذلك ركعتان يركعهما من الضحى", source: "مسلم، ٧٢٠" }
    : /أذكار الصباح|أذكار المساء/.test(habit.title ?? "")
      ? { text: "ألا بذكر الله تطمئن القلوب", source: "الرعد، ٢٨" }
      : null;
  const nextItem = progress.mode === "items" ? habit.items.find((item) => !progress.logged.has(item.id)) : null;
  const action = progress.mode === "items"
    ? nextItem ? "toggle-prayer" : "open-habit"
    : progress.mode === "count" ? "habit-count" : "habit-check";

  return `<article class="space-node space-node-habit priority-${priority} ${progressState}" data-priority-level="${priority}" data-action="${action}" data-card-action data-habit-id="${escapeHtml(habit.id)}"${nextItem ? ` data-item-id="${escapeHtml(nextItem.id)}"` : ""} data-date="${escapeHtml(today)}" role="button" tabindex="0" aria-pressed="${progress.complete}" aria-label="${escapeHtml(habit.title)}${progressText ? `، ${escapeHtml(progressText)}` : ""}">
    <div class="space-node-copy">
      <strong>${escapeHtml(habit.title)}</strong>
      ${progressText ? `<span class="space-node-meta">${escapeHtml(progressText)}</span>` : ""}
      ${ritualWisdom ? `<div class="space-ritual-wisdom"><strong>ومضة اليوم</strong><span>«${escapeHtml(ritualWisdom.text)}» <b>${escapeHtml(ritualWisdom.source)}</b></span></div>` : ""}
    </div>
  </article>`;
}

function renderPrayerNode(event) {
  const { prayer, habit, items, today } = event;
  const fardItems = items.filter((item) => item.category === "فرض");
  const sunnahItems = items.filter((item) => item.category === "سنة");
  const fardDone = fardItems.filter((item) => prayerStatus(item, habit, today)).length;
  const sunnahDone = sunnahItems.filter((item) => prayerStatus(item, habit, today)).length;
  const complete = fardItems.length > 0 && fardDone === fardItems.length;
  const status = complete ? "is-done" : fardDone || sunnahDone ? "is-partial" : "is-pending";
  const priority = event.priority ?? 3;
  const wisdom = PRAYER_WISDOM[prayer.name];
  const fardCount = fardItems.length
    ? `<span class="space-prayer-count"><b>الفرض</b> ${formatArabicNumber(fardDone)} من ${formatArabicNumber(fardItems.length)}</span>` : "";
  const sunnahCount = sunnahItems.length
    ? `<span class="space-prayer-count"><b>السنة</b> ${formatArabicNumber(sunnahDone)} من ${formatArabicNumber(sunnahItems.length)}</span>` : "";
  return `<article class="space-node space-node-prayer priority-${priority} ${status}" data-priority-level="${priority}" data-action="open-prayer-log" data-card-action data-habit-id="${escapeHtml(habit?.id ?? "")}" data-prayer="${escapeHtml(prayer.name)}" data-date="${escapeHtml(today)}" role="button" tabindex="0" aria-pressed="${complete}" aria-label="${escapeHtml(prayer.name)}: الفرض ${formatArabicNumber(fardDone)} من ${formatArabicNumber(fardItems.length)}${sunnahItems.length ? `، السنة ${formatArabicNumber(sunnahDone)} من ${formatArabicNumber(sunnahItems.length)}` : ""}">
    <div class="space-node-copy">
      <strong>${escapeHtml(prayer.name)}</strong>
      ${fardCount || sunnahCount ? `<div class="space-prayer-counts">${fardCount}${sunnahCount}</div>` : ""}
      ${wisdom ? `<div class="space-prayer-wisdom"><strong>حكمة</strong><span>«${escapeHtml(wisdom.text)}» <b>${escapeHtml(wisdom.source)}</b></span></div>` : ""}
    </div>
  </article>`;
}

function taskCompletion(task) {
  if (task.status === "done") return 1;
  const checklist = task.checklist ?? [];
  if (!checklist.length) return 0;
  return checklist.filter((item) => typeof item === "string" ? false : item.done).length / checklist.length;
}

function renderNightNode(event, index) {
  const { habit, today } = event;
  const logged = new Set(habit?.itemLog?.[today] ?? []);
  const nightItems = NIGHT_PRAYERS.map((name) => prayerItemFor(habit, name)).filter(Boolean);
  const sunnahItems = (habit?.items ?? []).filter((item) =>
    item.category === "سنة" && /قيام|وتر|شفع|ليل/.test(item.name));
  const renderItem = (item) => {
    const done = logged.has(item.id);
    const amount = item.amount ? `${formatArabicNumber(item.amount)} ${escapeHtml(item.unit || "ركعة")}` : "";
    return `<button class="space-night-prayer ${done ? "is-done" : "is-pending"}" type="button" data-action="toggle-prayer" data-habit-id="${escapeHtml(habit.id)}" data-item-id="${escapeHtml(item.id)}" data-date="${escapeHtml(today)}" aria-pressed="${done}">
      <i>${done ? "✓" : "✧"}</i><span>${escapeHtml(item.name)}</span>${amount ? `<small>${amount}</small>` : ""}
    </button>`;
  };
  const renderGroup = (title, items, emptyMessage) => `<details class="space-night-group">
    <summary><span>${title}</span><b>${formatArabicNumber(items.filter((item) => logged.has(item.id)).length)} / ${formatArabicNumber(items.length)}</b></summary>
    <div class="space-night-group-items">${items.length ? items.map(renderItem).join("") : `<span class="space-night-group-empty">${emptyMessage}</span>`}</div>
  </details>`;
  return `<div class="space-map-stop is-night-prayers" data-event-kind="night-prayers" style="--node-index:${index};animation-delay:${Math.min(index * 55, 700)}ms">
    <span class="space-map-connector" aria-hidden="true"></span>
    <article class="space-night-node">
    <div class="space-night-groups">
      ${renderGroup("النوافل", nightItems, "لا توجد نوافل ليلية مسجّلة.")}
      ${renderGroup("السنن", sunnahItems, "لا توجد سنن لقيام الليل مسجّلة.")}
    </div>
    </article>
  </div>`;
}

function renderEvent(event, index) {
  if (event.type === "night-prayers") {
    return renderNightNode(event, index);
  }

  const time = event.type === "prayer"
    ? Number.isFinite(event.prayer.time) ? formatPrayerTime(event.prayer.time) : ""
    : event.time ? timeLabel(event.time) : "";
  const label = event.type === "prayer" ? event.prayer.name
      : event.type === "task" ? "مهمة"
        : "عادة";
  const node = event.type === "task" ? renderTaskNode(event.task)
      : event.type === "habit" ? renderHabitNode({ ...event.habit, dailyTime: event.time ?? event.habit.dailyTime }, mapDate)
        : renderPrayerNode({ ...event, today: mapDate });
  const progress = event.type === "task" ? taskCompletion(event.task)
    : event.type === "habit" ? dayProgress(event.habit, mapDate).percent / 100
      : event.type === "prayer"
        ? (() => {
          const fard = event.items.filter((item) => item.category === "فرض");
        const fardDone = fard.filter((item) => prayerStatus(item, event.habit, mapDate)).length;
        if (fard.length && fardDone === fard.length) return 1;
        return event.items.length
          ? event.items.filter((item) => prayerStatus(item, event.habit, mapDate)).length / event.items.length
          : 0;
      })()
      : 0;
  const stopStatus = progress >= 1 ? " is-stop-done"
      : progress > 0 ? " is-stop-partial"
        : " is-stop-pending";
  const eventMinute = Number.isFinite(event.sortMinute) ? event.sortMinute : event.time;
  const eventKind = event.type;
  const progressState = progress >= 1 ? "done" : progress > 0 ? "partial" : "pending";
  return `<div class="space-map-stop${index % 2 ? " is-left" : " is-right"}${stopStatus}"${Number.isFinite(eventMinute) ? ` data-event-minute="${eventMinute}"` : ""} data-event-kind="${eventKind}" data-stop-status="${progressState}" style="--node-index:${index};animation-delay:${Math.min(index * 55, 700)}ms">
    ${time ? `<span class="space-map-time">${escapeHtml(time)}</span>` : ""}
    <span class="space-map-connector" aria-hidden="true"></span>
    <div class="space-map-event" data-kind="${event.type}" aria-label="${escapeHtml(label)}">${node}</div>
  </div>`;
}

function buildScore(tasks, habits, today) {
  const countedTasks = tasks.filter((task) =>
    isWithinPersonalDay(today, task.dueTime) && (task.status === "done" || isTaskCountedOn(task, today)));
  const countedHabits = habits.filter((habit) => isWithinPersonalDay(today, habit.dailyTime));
  const completedSubtasks = completedSubtasksOn(records.tasks, today).length;
  const taskDone = countedTasks.filter((task) => task.status === "done").length;
  const taskProgress = countedTasks.reduce((total, task) => total + taskCompletion(task), 0);
  const habitProgress = countedHabits.reduce((total, habit) => total + dayProgress(habit, today).percent / 100, 0);
  const total = countedTasks.length + countedHabits.length + completedSubtasks;
  return {
    percent: total ? Math.round((taskProgress + habitProgress + completedSubtasks) / total * 100) : 0,
    hasItems: total > 0,
    tasksDone: taskDone,
    habitsPercent: countedHabits.length ? Math.round(habitProgress / countedHabits.length * 100) : 0,
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
    return isTaskCountedInRange(task, start, end);
  });
  const completedTasks = tasks.filter((task) => task.status === "done").length;
  const taskProgress = tasks.reduce((total, task) => total + taskCompletion(task), 0);
  const habits = records.habits.filter((habit) => !habit.archived);
  let scheduledHabits = 0;
  let completedHabits = 0;
  let habitProgress = 0;
  for (const date of dates) {
    let dailyMetrics = periodDayMetricsCache.get(date);
    if (!dailyMetrics) {
      dailyMetrics = { scheduled: 0, completed: 0, progress: 0 };
      for (const habit of habits) {
        if (!scheduledHabit(habit, date)) continue;
        dailyMetrics.scheduled += 1;
        const progress = dayProgress(habit, date);
        dailyMetrics.progress += progress.percent / 100;
        if (progress.complete) dailyMetrics.completed += 1;
      }
      periodDayMetricsCache.set(date, dailyMetrics);
    }
    scheduledHabits += dailyMetrics.scheduled;
    completedHabits += dailyMetrics.completed;
    habitProgress += dailyMetrics.progress;
  }
  const completedSubtasks = completedSubtaskCount(records.tasks, start, end);
  const total = tasks.length + scheduledHabits + completedSubtasks;
  return {
    completedTasks,
    plannedTasks: tasks.length - completedTasks,
    completedSubtasks,
    scheduledHabits,
    completedHabits,
    habitPercent: scheduledHabits ? Math.round((habitProgress / scheduledHabits) * 100) : 0,
    percent: total ? Math.round(((taskProgress + habitProgress + completedSubtasks) / total) * 100) : 0,
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
      <div class="space-map-summary-item" aria-label="المهام الفرعية المنجزة: ${formatArabicNumber(metrics.completedSubtasks)}">
        <span aria-hidden="true">↳</span><strong>فرعية</strong><small>${formatArabicNumber(metrics.completedSubtasks)} منجزة</small>
      </div>
    </div>
    <div class="space-map-summary-actions">
      <button class="space-map-recap-action is-share" type="button" data-action="share-period-path" aria-label="مشاركة مسار ${MAP_MODE_LABELS[mapMode]} مع رسوم بيانية وإحصاءات مفصلة">
        <span aria-hidden="true">↗</span> مشاركة المسار والرسوم
      </button>
    </div>
  </section>`;
}

function taskDatesInRange(task, start, end) {
  const subtaskDates = (Array.isArray(task.checklist) ? task.checklist : []).flatMap((item) =>
    typeof item === "string" ? [] : (item.completionLog ?? []).filter((entry) => entry?.completed).map((entry) => entry.date));
  const completionDates = (task.completionLog ?? []).map((entry) => entry?.completedAt);
  const loggedTimeDates = (task.timeLog ?? []).map((entry) => entry?.date);
  return isTaskScheduledInRange(task, start, end, true) ||
    [task.createdAt, task.completedAt, ...completionDates, ...subtaskDates, ...loggedTimeDates]
    .some((value) => {
      const date = datePart(value);
      return date && date >= start && date <= end;
    });
}

function recapPeriodBounds(mode, anchorDate) {
  const bounds = mapBounds(mode, new Date(`${anchorDate}T12:00:00`));
  const today = localDateString();
  const end = bounds.end > today ? today : bounds.end;
  return { start: bounds.start, end: end < bounds.start ? bounds.start : end };
}

function renderRecapRangeTabs() {
  return `<nav class="space-recap-range-tabs" aria-label="اختيار إيقاع الحصاد">
    ${MAP_MODES.map((mode) => `<button type="button" data-recap-range="${mode}" aria-pressed="${recapMode === mode}">${MAP_MODE_LABELS[mode]}</button>`).join("")}
  </nav>`;
}

function renderRecapDayDetails(date) {
  const metrics = periodMetrics(date, date);
  const dayTasks = records.tasks.filter((task) => taskDatesInRange(task, date, date));
  const taskCards = dayTasks.flatMap((task) => {
    const logs = (task.completionLog ?? []).filter((entry) => datePart(entry.completedAt) === date);
    if (logs.length) {
      return logs.map((entry) => `<article class="space-recap-detail"><strong>${escapeHtml(task.title)}</strong><span>مهمة مكتملة${storyTime(entry.completedAt) ? ` · ${escapeHtml(storyTime(entry.completedAt))}` : ""}${Number(entry.durationMin) > 0 ? ` · ${formatDuration(entry.durationMin)}` : ""}</span></article>`);
    }
    return task.status === "done" && datePart(task.completedAt) === date
      ? [`<article class="space-recap-detail"><strong>${escapeHtml(task.title)}</strong><span>مهمة مكتملة</span></article>`]
      : [];
  }).join("");
  const subtasks = completedSubtasksOn(records.tasks, date);
  const subtaskCards = subtasks.map(({ task, item }) =>
    `<article class="space-recap-detail"><strong>${escapeHtml(item.text)}</strong><span>مهمة فرعية · ${escapeHtml(task.title)}</span></article>`).join("");
  const completedHabits = records.habits.filter((habit) =>
    !habit.archived && (!datePart(habit.createdAt) || datePart(habit.createdAt) <= date)
    && scheduledHabit(habit, date) && dayProgress(habit, date).complete);
  const habitCards = completedHabits.map((habit) =>
    `<article class="space-recap-detail"><strong>${escapeHtml(habit.title)}</strong><span>عادة مكتملة</span></article>`).join("");
  const sessions = records.sessions.filter((session) =>
    session.status === "completed" && session.type !== "break" && datePart(session.start) === date);
  const sessionMinutes = sessions.reduce((total, session) => total + Math.max(0, Number(session.durationMin) || 0), 0);
  const sessionCards = sessions.map((session) =>
    `<article class="space-recap-detail"><strong>${escapeHtml(session.taskTitle || session.habitTitle || "جلسة تركيز")}</strong><span>${formatDuration(session.durationMin)}${storyTime(session.start) ? ` · ${escapeHtml(storyTime(session.start))}` : ""}</span></article>`).join("");
  const prayerHabit = linkedPrayerHabit();
  const prayerCards = prayerHabit ? Object.keys(PRAYER_ITEM_NAMES).flatMap((prayerName) => {
    const items = prayerItemsFor(prayerHabit, prayerName);
    const doneItems = items.filter((item) => prayerStatus(item, prayerHabit, date));
    if (!doneItems.length) return [];
    const times = doneItems.map((item) => storyTime(prayerHabit.itemLogTimes?.[date]?.[item.id])).filter(Boolean);
    return [`<article class="space-recap-detail"><strong>صلاة ${escapeHtml(prayerName)}</strong><span>${formatArabicNumber(doneItems.length)} بنود مسجلة${times.length ? ` · ${times.map(escapeHtml).join("، ")}` : ""}</span></article>`];
  }).join("") : "";
  const previousSleep = sleepLogFor(dateOffset(date, -1)) ?? {};
  const daySleep = sleepLogFor(date) ?? {};
  const dateLabel = new Intl.DateTimeFormat("ar", { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${date}T12:00:00`));
  const sections = [
    ["المهام المكتملة", taskCards],
    ["المهام الفرعية المنجزة", subtaskCards],
    ["العادات المكتملة", habitCards],
    ["الصلوات وأوقاتها", prayerCards],
    ["جلسات التركيز", sessionCards],
  ].filter(([, cards]) => cards);
  return `<header class="space-recap-selected-heading"><div><h4>${escapeHtml(dateLabel)}</h4><span>${formatArabicNumber(metrics.percent)}٪ إنجاز</span></div><div class="space-recap-selected-stats"><span>${formatArabicNumber(metrics.completedTasks)} مهام</span><span>${formatArabicNumber(subtasks.length)} فرعية</span><span>${formatArabicNumber(completedHabits.length)} عادات</span><span>${formatDuration(sessionMinutes)} تركيز</span></div></header>
    <div class="space-recap-day-detail-grid">${sections.length ? sections.map(([title, cards]) => `<section><h5>${title}</h5><div class="space-recap-list">${cards}</div></section>`).join("") : `<p class="space-recap-empty-day">لا توجد إنجازات مسجلة في هذا اليوم.</p>`}
      <section><h5>النوم والراحة</h5><div class="space-recap-list"><article class="space-recap-detail"><strong>النوم الليلي</strong><span>${previousSleep.bedTime ? timeLabel(previousSleep.bedTime) : "—"} · استيقاظ ${daySleep.wakeTime ? timeLabel(daySleep.wakeTime) : "—"}</span></article><article class="space-recap-detail"><strong>القيلولة</strong><span>${Number(daySleep.napDurationMin) > 0 ? `${daySleep.napStart ? `${timeLabel(daySleep.napStart)} · ` : ""}${formatSleepDuration(Number(daySleep.napDurationMin))}` : "—"}</span></article></div></section>
    </div>`;
}

function recapSegments(mode, start, end) {
  const segments = [];
  if (mode === "year") {
    const first = new Date(`${start}T12:00:00`);
    const last = new Date(`${end}T12:00:00`);
    for (let month = first.getMonth(); month <= last.getMonth(); month += 1) {
      const monthStart = dateString(localDate(first.getFullYear(), month, 1));
      const monthEnd = dateString(localDate(first.getFullYear(), month + 1, 0));
      segments.push({
        start: monthStart < start ? start : monthStart,
        end: monthEnd > end ? end : monthEnd,
        mode: "month",
        title: new Intl.DateTimeFormat("ar", { month: "long" }).format(localDate(first.getFullYear(), month, 1)),
      });
    }
    return segments;
  }
  if (mode === "month") {
    let cursor = new Date(`${start}T12:00:00`);
    const last = new Date(`${end}T12:00:00`);
    let week = 1;
    while (cursor <= last) {
      const weekEnd = localDate(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + (6 - cursor.getDay()));
      const endDate = weekEnd > last ? last : weekEnd;
      segments.push({
        start: dateString(cursor),
        end: dateString(endDate),
        mode: "week",
        title: `الأسبوع ${formatArabicNumber(week)}`,
      });
      cursor = localDate(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1);
      week += 1;
    }
    return segments;
  }
  if (mode === "week") {
    return eachDate(start, end).map((date) => ({
      start: date,
      end: date,
      mode: "day",
      title: new Intl.DateTimeFormat("ar", { weekday: "long" }).format(new Date(`${date}T12:00:00`)),
    }));
  }
  return segments;
}

function renderRecapPeriodCards(segments, selectedDate) {
  return segments.map((segment) => {
    const metrics = periodMetrics(segment.start, segment.end);
    const sessions = records.sessions.filter((session) =>
      session.status === "completed" && session.type !== "break"
      && datePart(session.start) >= segment.start && datePart(session.start) <= segment.end);
    const focusMinutes = sessions.reduce((total, session) => total + Math.max(0, Number(session.durationMin) || 0), 0);
    const selected = selectedDate >= segment.start && selectedDate <= segment.end;
    const isDay = segment.mode === "day";
    const title = isDay
      ? new Intl.DateTimeFormat("ar", { day: "numeric", month: "short" }).format(new Date(`${segment.start}T12:00:00`))
      : segment.title;
    const label = segment.mode === "month" ? `حصاد شهر ${segment.title}`
      : segment.mode === "week" ? `حصاد ${segment.title}`
        : `حصاد ${segment.title}`;
    const taskTotal = metrics.completedTasks + metrics.plannedTasks;
    const taskPercent = taskTotal ? Math.round(metrics.completedTasks / taskTotal * 100) : 0;
    const habitPercent = metrics.scheduledHabits ? Math.round(metrics.completedHabits / metrics.scheduledHabits * 100) : 0;
    const icon = segment.mode === "month" ? "✦" : segment.mode === "week" ? "▦" : "☼";
    const periodDates = isDay ? title : `${formatDate(segment.start)}${segment.start !== segment.end ? ` – ${formatDate(segment.end)}` : ""}`;
    return `<button type="button" class="space-recap-period-card${selected ? " is-selected" : ""}${segment.start === localDateString() && isDay ? " is-today" : ""}" data-recap-period-start="${segment.start}" data-recap-period-end="${segment.end}" data-recap-period-mode="${segment.mode}" data-recap-period-label="${escapeHtml(label)}" aria-pressed="${selected}" aria-label="${escapeHtml(title)}: إنجاز ${formatArabicNumber(metrics.percent)} بالمئة، ${formatArabicNumber(metrics.completedTasks)} من ${formatArabicNumber(taskTotal)} مهام، ${formatArabicNumber(metrics.completedHabits)} من ${formatArabicNumber(metrics.scheduledHabits)} عادات" style="--recap-day-progress:${metrics.percent}%;--recap-day-tint:${Math.round(5 + metrics.percent * 0.13)}%">
      <header><span class="space-recap-period-icon" aria-hidden="true">${icon}</span><span class="space-recap-period-title"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(periodDates)}</small></span><span class="space-recap-period-open" aria-hidden="true">↗</span></header>
      <div class="space-recap-period-body">
        <span class="space-recap-period-ring" role="img" aria-label="إنجاز ${formatArabicNumber(metrics.percent)} بالمئة"><strong>${formatArabicNumber(metrics.percent)}<small>٪</small></strong><i>إنجاز</i></span>
        <div class="space-recap-period-meters">
          <div class="space-recap-period-meter"><span>المهام</span><strong>${formatArabicNumber(metrics.completedTasks)}<small> / ${formatArabicNumber(taskTotal)}</small></strong><i style="--meter-progress:${taskPercent}%"></i></div>
          <div class="space-recap-period-meter is-habit"><span>العادات</span><strong>${formatArabicNumber(metrics.completedHabits)}<small> / ${formatArabicNumber(metrics.scheduledHabits)}</small></strong><i style="--meter-progress:${habitPercent}%"></i></div>
        </div>
      </div>
      <footer class="space-recap-period-stats"><span><b aria-hidden="true">↳</b>${formatArabicNumber(metrics.completedSubtasks)} فرعية</span><span><b aria-hidden="true">◷</b>${formatDuration(focusMinutes)} تركيز</span></footer>
    </button>`;
  }).join("");
}

function renderPeriodRecap(start, end, label) {
  if (recapMode === "day" && start === end) {
    return renderDayRecap(start, label);
  }

  const dates = eachDate(start, end);
  const tasks = records.tasks.filter((task) => taskDatesInRange(task, start, end));
  const habits = records.habits.filter((habit) => !habit.archived);
  const taskEvents = tasks.flatMap((task) => {
    const logs = (task.completionLog ?? []).filter((entry) => entry?.completedAt && datePart(entry.completedAt) >= start && datePart(entry.completedAt) <= end);
    return logs.length ? logs : task.status === "done" && datePart(task.completedAt) >= start && datePart(task.completedAt) <= end
      ? [{ completedAt: task.completedAt, durationMin: null }]
      : [];
  });
  const completedTasks = taskEvents.length;
  const completedSubtasks = completedSubtaskCount(tasks, start, end);
  const countableOpenTasks = tasks.filter((task) =>
    task.status !== "done" && isTaskCountedInRange(task, start, end)).length;
  const habitRows = habits.map((habit) => {
    const created = datePart(habit.createdAt);
    const scheduledDates = dates.filter((date) => (!created || date >= created) && scheduledHabit(habit, date));
    const completedDates = scheduledDates.filter((date) => dayProgress(habit, date).complete);
    return { habit, scheduledDates, completedDates };
  }).filter((row) => row.scheduledDates.length);
  const scheduledHabitDays = habitRows.reduce((total, row) => total + row.scheduledDates.length, 0);
  const completedHabitDays = habitRows.reduce((total, row) => total + row.completedDates.length, 0);
  const taskTotal = completedTasks + countableOpenTasks;
  const totalItems = taskTotal + scheduledHabitDays + completedSubtasks;
  const progress = totalItems ? Math.round((completedTasks + completedHabitDays + completedSubtasks) / totalItems * 100) : 0;
  const focusSessions = records.sessions.filter((session) =>
    session.status === "completed" && session.type !== "break" && datePart(session.start) >= start && datePart(session.start) <= end);
  const focusMinutes = focusSessions.reduce((total, session) => total + Math.max(0, Number(session.durationMin) || 0), 0);
  const taskManualMinutes = tasks.reduce((total, task) => total + (task.timeLog ?? []).reduce((minutes, entry) =>
    entry?.date >= start && entry.date <= end ? minutes + Math.max(0, Number(entry.minutes) || 0) : minutes, 0), 0);
  const completionMinutes = [
    ...taskEvents,
    ...habitRows.flatMap(({ habit, completedDates }) => completedDates.map((date) => habit.completionLog?.[date])),
  ].reduce((total, event) => total + Math.max(0, Number(event?.durationMin) || 0), 0);
  const periodObjectiveIds = new Set([
    ...tasks.map((task) => objectiveForTask(task)?.id),
    ...habitRows.map(({ habit }) => habit.objectiveId),
    ...records.keyResults.filter((result) => {
      const updatedDate = datePart(result.updatedAt);
      return updatedDate && updatedDate >= start && updatedDate <= end;
    }).map((result) => result.objectiveId),
    ...records.objectives.filter((objective) => objective.status === "done" && datePart(objective.updatedAt) >= start && datePart(objective.updatedAt) <= end)
      .map((objective) => objective.id),
  ].filter(Boolean));
  const firstYear = new Date(`${start}T12:00:00`).getFullYear();
  const lastYear = new Date(`${end}T12:00:00`).getFullYear();
  const objectives = records.objectives.filter((objective) =>
    periodObjectiveIds.has(objective.id) &&
    objective.status !== "archived" &&
    Number(objective.year) >= firstYear &&
    Number(objective.year) <= lastYear);
  const areaStats = new Map();
  const recordArea = (id, kind, completed) => {
    if (!id) return;
    const current = areaStats.get(id) ?? { tasks: 0, habits: 0, completedTasks: 0, completedHabits: 0 };
    current[kind] += 1;
    if (completed) current[kind === "tasks" ? "completedTasks" : "completedHabits"] += 1;
    areaStats.set(id, current);
  };
  for (const task of tasks) {
    const done = (task.completionLog ?? []).some((entry) => entry?.completedAt && datePart(entry.completedAt) >= start && datePart(entry.completedAt) <= end)
      || (task.status === "done" && datePart(task.completedAt) >= start && datePart(task.completedAt) <= end);
    recordArea(taskLifeAreaId(task), "tasks", done);
  }
  for (const { habit, scheduledDates, completedDates } of habitRows) {
    if (scheduledDates.length) recordArea(habitLifeAreaId(habit), "habits", completedDates.length > 0);
  }
  for (const objective of objectives) {
    if (objective.lifeAreaId && !areaStats.has(objective.lifeAreaId)) areaStats.set(objective.lifeAreaId, { tasks: 0, habits: 0, completedTasks: 0, completedHabits: 0 });
  }
  const areaCards = [...areaStats].map(([id, stats]) => {
    const area = records.lifeAreas.find((item) => item.id === id);
    return area ? `<article class="space-recap-area"><strong>${escapeHtml(area.name)}</strong><span>${formatArabicNumber(stats.tasks)} مهام · ${formatArabicNumber(stats.habits)} عادات</span></article>` : "";
  }).filter(Boolean).join("");
  const objectiveCards = objectives.map((objective) => {
    const results = records.keyResults.filter((result) => result.objectiveId === objective.id);
    const percent = results.length
      ? Math.round(results.reduce((total, result) => total + getKeyResultProgress(result), 0) / results.length)
      : objective.status === "done" ? 100 : 0;
    const area = records.lifeAreas.find((item) => item.id === objective.lifeAreaId);
    return `<article class="space-recap-detail"><strong>${escapeHtml(objective.title)}</strong><span>${area ? `${escapeHtml(area.name)} · ` : ""}${results.length} نتائج رئيسية · ${formatArabicNumber(percent)}٪</span></article>`;
  }).join("");
  const taskCards = tasks.map((task) => {
    const logs = (task.completionLog ?? []).filter((entry) => entry?.completedAt && datePart(entry.completedAt) >= start && datePart(entry.completedAt) <= end);
    const done = logs.length || (task.status === "done" && datePart(task.completedAt) >= start && datePart(task.completedAt) <= end);
    const checklist = (task.checklist ?? []).filter((item) => item && typeof item === "object");
    const checklistDone = checklist.filter((item) => item.done).length;
    const taskProgress = task.status === "done" ? 100 : checklist.length ? Math.round(checklistDone / checklist.length * 100) : 0;
    const subtaskDetails = checklist.flatMap((item) => {
      const entries = (item.completionLog ?? []).filter((entry) =>
        entry?.completed && entry.date >= start && entry.date <= end);
      return entries.map((entry) => {
        const time = storyTime(entry.completedAt);
        return `<span>${escapeHtml(item.text)} · ${escapeHtml(formatDate(entry.date))}${time ? ` · ${escapeHtml(time)}` : ""}</span>`;
      });
    });
    const completionDetails = logs.map((entry) => {
      const time = storyTime(entry.completedAt);
      const duration = Number(entry.durationMin) > 0 ? ` · ${formatDuration(entry.durationMin)}` : "";
      return `${formatDate(datePart(entry.completedAt))}${time ? ` · ${time}` : ""}${duration}`;
    });
    return `<article class="space-recap-detail"><strong>${escapeHtml(task.title)}</strong><span>${done ? "مكتملة" : taskProgress ? `${formatArabicNumber(taskProgress)}٪ تقدم` : "مفتوحة"}${checklist.length ? ` · ${formatArabicNumber(checklistDone)}/${formatArabicNumber(checklist.length)} فرعية` : ""}${completionDetails.length ? ` · ${completionDetails.map(escapeHtml).join("، ")}` : ""}</span>${subtaskDetails.length ? `<div class="space-recap-subtask-list" aria-label="المهام الفرعية المنجزة">${subtaskDetails.join("")}</div>` : ""}</article>`;
  }).join("");
  const habitCards = habitRows.map(({ habit, scheduledDates, completedDates }) => {
    const percent = Math.round(completedDates.length / scheduledDates.length * 100);
    const times = completedDates.slice(-7).map((date) => {
      const completedAt = habit.completionLog?.[date]?.completedAt;
      const time = storyTime(completedAt);
      return `${formatDate(date)}${time ? ` · ${time}` : ""}`;
    });
    return `<article class="space-recap-detail"><strong>${escapeHtml(habit.title)}</strong><span>${formatArabicNumber(completedDates.length)} من ${formatArabicNumber(scheduledDates.length)} يومًا · ${formatArabicNumber(percent)}٪${times.length ? ` · ${times.map(escapeHtml).join("، ")}` : ""}</span></article>`;
  }).join("");
  const prayerHabit = linkedPrayerHabit();
  const prayerCards = prayerHabit ? Object.keys(PRAYER_ITEM_NAMES).map((prayerName) => {
    const items = prayerItemsFor(prayerHabit, prayerName);
    if (!items.length) return "";
    const fardItems = items.filter((item) => item.category === "فرض");
    const sunnahItems = items.filter((item) => item.category === "سنة");
    const created = datePart(prayerHabit.createdAt);
    const prayerDates = dates.filter((date) => !created || date >= created);
    const fardDays = prayerDates.filter((date) =>
      fardItems.length > 0 && fardItems.every((item) => prayerStatus(item, prayerHabit, date))).length;
    const sunnahCount = prayerDates.reduce((total, date) =>
      total + sunnahItems.filter((item) => prayerStatus(item, prayerHabit, date)).length, 0);
    const timeEntries = prayerDates.flatMap((date) => items.flatMap((item) => {
      if (!prayerStatus(item, prayerHabit, date)) return [];
      const time = storyTime(prayerHabit.itemLogTimes?.[date]?.[item.id]);
      return time ? [{ date, time }] : [];
    })).slice(-7);
    const timeDetails = timeEntries.map(({ date, time }) =>
      `${new Intl.DateTimeFormat("ar", { weekday: "short" }).format(new Date(`${date}T12:00:00`))} ${time}`);
    return `<article class="space-recap-detail"><strong>صلاة ${escapeHtml(prayerName)}</strong><span>الفرض ${formatArabicNumber(fardDays)} من ${formatArabicNumber(prayerDates.length)} يومًا · ${formatArabicNumber(sunnahCount)} سنن مسجلة</span>${timeDetails.length ? `<small>الأوقات: ${timeDetails.map(escapeHtml).join(" · ")}</small>` : ""}</article>`;
  }).filter(Boolean).join("") : "";
  const recapEnd = end < localDateString() ? end : localDateString();
  const segmentEnd = recapEnd < start ? start : recapEnd;
  const recapPeriods = recapSegments(recapMode, start, segmentEnd);
  if (!recapPeriods.some((period) => recapSelectedDate >= period.start && recapSelectedDate <= period.end)) {
    recapSelectedDate = recapPeriods.length ? recapPeriods.at(-1).end : start;
  }
  const periodCards = renderRecapPeriodCards(recapPeriods, recapSelectedDate);
  const recapPeriodTitle = {
    year: "إيقاع شهور السنة",
    month: "إيقاع أسابيع الشهر",
    week: "إيقاع أيام الأسبوع",
  }[recapMode] ?? "إيقاع الأيام";
  const personalWin = completedTasks || completedHabitDays
    ? `أنجزت ${formatArabicNumber(completedTasks)} مهمة وحافظت على ${formatArabicNumber(completedHabitDays)} يومًا من العادات. كل خطوة ساهمت في وصولك.`
    : "قد لا يكون اليوم كاملاً، لكن مراجعتك له خطوة مهمة نحو يوم أفضل.";
  return `<div class="space-recap-content">
    <header class="space-recap-heading">
      <div><p>محطتك تستحق الاحتفاء</p><h2>${escapeHtml(label)}</h2><span><bdi dir="ltr">${escapeHtml(start)} — ${escapeHtml(end)}</bdi></span></div>
      <button class="icon-button" type="button" data-action="close-recap" aria-label="إغلاق">×</button>
    </header>
    ${renderRecapRangeTabs()}
    <section class="space-recap-hero">
      <div class="space-recap-progress" style="--recap-progress:${progress}%"><strong>${formatArabicNumber(progress)}<small>٪</small></strong><span>إنجاز الفترة</span></div>
      <div class="space-recap-stats">
        <article><span>مهام مكتملة</span><strong>${formatArabicNumber(completedTasks)}</strong><small>من ${formatArabicNumber(taskTotal)} مهمة محسوبة في الفترة</small></article>
        <article><span>أيام عادات مكتملة</span><strong>${formatArabicNumber(completedHabitDays)}</strong><small>من ${formatArabicNumber(scheduledHabitDays)} يومًا مجدولًا</small></article>
        <article><span>مهام فرعية منجزة</span><strong>${formatArabicNumber(completedSubtasks)}</strong><small>تُحسب في يوم إنجازها</small></article>
        <article><span>أهداف ضمن رحلتك</span><strong>${formatArabicNumber(objectives.length)}</strong><small>${formatArabicNumber(objectives.filter((objective) => objective.status === "done").length)} مكتملة</small></article>
      </div>
    </section>
    ${periodCards ? `<section class="space-recap-section space-recap-rhythm"><header><h3>${recapPeriodTitle}</h3><span>${formatArabicNumber(recapPeriods.length)} ${recapMode === "year" ? "أشهر" : recapMode === "month" ? "أسابيع" : "أيام"} · اختر الفترة للتفصيل</span></header><div class="space-recap-day-track">${periodCards}</div>${recapMode === "week" ? `<div class="space-recap-selected-day">${renderRecapDayDetails(recapSelectedDate)}</div>` : ""}</section>` : ""}
    <section class="space-recap-time">
      <article><span>مدد الإنجاز المسجّلة</span><strong>${formatDuration(completionMinutes)}</strong></article>
      <article><span>جلسات التركيز</span><strong>${formatDuration(focusMinutes)}</strong><small>${formatArabicNumber(focusSessions.length)} جلسة</small></article>
      <article><span>وقت العمل اليدوي</span><strong>${formatDuration(taskManualMinutes)}</strong></article>
    </section>
    ${areaCards ? `<section class="space-recap-section"><h3>مجالات شاركت فيها</h3><div class="space-recap-area-grid">${areaCards}</div></section>` : ""}
    ${objectiveCards ? `<section class="space-recap-section"><h3>أهدافك ونتائجك</h3><div class="space-recap-list">${objectiveCards}</div></section>` : ""}
    ${prayerCards ? `<section class="space-recap-section"><h3>الصلوات وأوقاتها</h3><div class="space-recap-list">${prayerCards}</div></section>` : ""}
    ${taskCards ? `<section class="space-recap-section"><h3>المهام</h3><div class="space-recap-list">${taskCards}</div></section>` : ""}
    ${habitCards ? `<section class="space-recap-section"><h3>العادات</h3><div class="space-recap-list">${habitCards}</div></section>` : ""}
    <p class="space-recap-pride"><span aria-hidden="true">✦</span>${escapeHtml(personalWin)}</p>
    <div class="space-recap-actions">
      <button class="button button-secondary" type="button" data-action="share-period" data-start="${start}" data-end="${end}" data-label="${escapeHtml(label)}">مشاركة التقرير</button>
      <button class="button button-secondary" type="button" data-action="print-period" data-start="${start}" data-end="${end}" data-label="${escapeHtml(label)}">حفظ PDF</button>
      <button class="button button-primary" type="button" data-action="close-recap">أغلق وأنا فخور بما أنجزت</button>
    </div>
  </div>`;
}

function renderDayRecap(date, label) {
  const metrics = periodMetrics(date, date);
  const previousSleep = sleepLogFor(dateOffset(date, -1)) ?? {};
  const todaySleep = sleepLogFor(date) ?? {};
  const bedtime = clockMinutes(previousSleep.bedTime) === null ? "—" : timeLabel(previousSleep.bedTime);
  const wakeTime = clockMinutes(todaySleep.wakeTime) === null ? "—" : timeLabel(todaySleep.wakeTime);
  const nap = Number(todaySleep.napDurationMin) > 0
    ? `${todaySleep.napStart ? `${timeLabel(todaySleep.napStart)} · ` : ""}${formatArabicNumber(todaySleep.napDurationMin)} د`
    : "—";
  const taskTotal = metrics.completedTasks + metrics.plannedTasks;

  return `<div class="space-recap-content space-day-recap-content">
    <header class="space-recap-heading">
      <div><p>ختام يومك</p><h2>${escapeHtml(label)}</h2><span>${escapeHtml(formatDate(date))}</span></div>
      <button class="icon-button" type="button" data-action="close-recap" aria-label="إغلاق">×</button>
    </header>
    ${renderRecapRangeTabs()}
    <section class="space-day-recap-grid" aria-label="إحصائيات اليوم والنوم">
      <article class="is-highlight"><span>الإنجاز</span><strong><bdi dir="ltr">${formatArabicNumber(metrics.percent)}٪</bdi></strong></article>
      <article><span>المهام</span><strong><bdi dir="ltr">${formatArabicNumber(metrics.completedTasks)} / ${formatArabicNumber(taskTotal)}</bdi></strong></article>
      <article><span>المهام الفرعية</span><strong><bdi dir="ltr">${formatArabicNumber(metrics.completedSubtasks)}</bdi></strong></article>
      <article><span>العادات</span><strong><bdi dir="ltr">${formatArabicNumber(metrics.completedHabits)} / ${formatArabicNumber(metrics.scheduledHabits)}</bdi></strong></article>
      <article><span>النوم</span><strong><bdi dir="ltr">${bedtime}</bdi></strong></article>
      <article><span>الاستيقاظ</span><strong><bdi dir="ltr">${wakeTime}</bdi></strong></article>
      <article><span>القيلولة</span><strong><bdi dir="ltr">${nap}</bdi></strong></article>
    </section>
    <div class="space-recap-actions">
      <button class="button button-secondary" type="button" data-action="share-period" data-start="${date}" data-end="${date}" data-label="${escapeHtml(label)}">مشاركة</button>
      <button class="button button-primary" type="button" data-action="close-recap">إغلاق</button>
    </div>
  </div>`;
}

function periodReport(start, end, label) {
  const dates = eachDate(start, end);
  const tasks = records.tasks.filter((task) => taskDatesInRange(task, start, end));
  const metrics = periodMetrics(start, end);
  const taskItems = tasks.map((task) => {
    const logs = (task.completionLog ?? []).filter((entry) => entry?.completedAt && datePart(entry.completedAt) >= start && datePart(entry.completedAt) <= end);
    const completed = logs.length > 0 || (task.status === "done" && datePart(task.completedAt) >= start && datePart(task.completedAt) <= end);
    const checklist = (task.checklist ?? []).filter((item) => item && typeof item === "object");
    const doneCount = checklist.filter((item) => item.done).length;
    const due = task.due || task.scheduled;
    return {
      title: task.title,
      detail: `${completed ? "مكتملة" : "قيد الإنجاز"}${due ? ` · ${formatDate(due)}` : ""}${task.dueTime ? ` · ${task.dueTime}` : ""}`,
      details: checklist.map((item) => `${item.done ? "✓" : "○"} ${item.text}`)
        .concat(checklist.length ? [`التقدم الفرعي: ${formatArabicNumber(doneCount)} من ${formatArabicNumber(checklist.length)}`] : []),
    };
  });
  const habitItems = records.habits.filter((habit) => !habit.archived).flatMap((habit) => {
    const created = datePart(habit.createdAt);
    const scheduled = dates.filter((date) => (!created || date >= created) && scheduledHabit(habit, date));
    if (!scheduled.length) return [];
    const completed = scheduled.filter((date) => dayProgress(habit, date).complete);
    return [{
      title: habit.title,
      detail: `${formatArabicNumber(completed.length)} من ${formatArabicNumber(scheduled.length)} يومًا · ${formatArabicNumber(scheduled.length ? Math.round(completed.length / scheduled.length * 100) : 0)}٪`,
    }];
  });
  const sessions = records.sessions.filter((session) =>
    session.status === "completed" && session.type !== "break" && datePart(session.start) >= start && datePart(session.start) <= end);
  const focusMinutes = sessions.reduce((sum, session) => sum + Math.max(0, Number(session.durationMin) || 0), 0);
  const rangeLabel = start === end ? formatDate(start) : `${start} — ${end}`;
  const summary = [
    { label: "نسبة الإنجاز", value: `${formatArabicNumber(metrics.percent)}٪` },
    { label: "المهام المكتملة", value: `${formatArabicNumber(metrics.completedTasks)} من ${formatArabicNumber(metrics.completedTasks + metrics.plannedTasks)}` },
    { label: "أيام العادات المكتملة", value: `${formatArabicNumber(metrics.completedHabits)} من ${formatArabicNumber(metrics.scheduledHabits)}` },
    { label: "وقت التركيز", value: formatDuration(focusMinutes), detail: `${formatArabicNumber(sessions.length)} جلسة` },
  ];
  const sections = [
    { title: "المهام", items: taskItems },
    { title: "العادات", items: habitItems },
    { title: "جلسات التركيز", items: sessions.map((session) => ({
      title: session.taskTitle || session.habitTitle || "جلسة تركيز",
      detail: `${formatDate(datePart(session.start))} · ${formatDuration(session.durationMin)}`,
    })) },
  ];
  return { title: label, period: rangeLabel, summary, sections };
}

function openPeriodRecap(start, end, label, mode = null, anchorDate = null) {
  const dialog = document.querySelector("#space-period-recap-dialog");
  if (!dialog) return;
  const inferredMode = start === end || label.includes("اليوم") ? "day"
    : label.includes("أسبوع") ? "week"
      : label.includes("شهر") ? "month"
        : label.includes("سنة") || label.includes("عام") ? "year"
          : eachDate(start, end).length <= 7 ? "week"
            : eachDate(start, end).length <= 31 ? "month" : "year";
  recapMode = MAP_MODES.includes(mode) ? mode : inferredMode;
  recapAnchorDate = anchorDate || (mapDate >= start && mapDate <= end
    ? mapDate
    : end < localDateString() ? end : localDateString());
  recapSelectedDate = recapAnchorDate;
  recapStart = start;
  recapEnd = end;
  recapLabel = label;
  dialog.innerHTML = renderPeriodRecap(start, end, label);
  if (!dialog.open) dialog.showModal();
}

function storyDisplayName() {
  const profile = records.profile.find((item) => item.id === "user") ?? records.profile[0];
  return String(profile?.displayName ?? profile?.fullName ?? profile?.name ?? "أنت").trim() || "أنت";
}

function storyTime(value) {
  if (!value) return "";
  const time = /^\d{2}:\d{2}$/.test(value) ? value : (() => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : currentTimeValue(parsed);
  })();
  return time ? timeLabel(time) : "";
}

function storyMinute(value) {
  if (!value) return null;
  if (/^\d{2}:\d{2}$/.test(value)) return clockMinutes(value);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getHours() * 60 + parsed.getMinutes();
}

function buildDayStory(date, requestedName = storyDisplayName()) {
  const name = String(requestedName || storyDisplayName()).trim().slice(0, 60) || "أنت";
  const events = [];
  const addEvent = (event) => events.push({
    kind: "activity",
    time: "",
    sortMinute: 25 * 60,
    status: "pending",
    progress: 0,
    durationMin: 0,
    ...event,
  });
  const sleepLog = sleepLogFor(date) ?? {};
  const previousSleepLog = sleepLogFor(dateOffset(date, -1)) ?? {};
  const wakeMinute = clockMinutes(sleepLog.wakeTime);
  const previousBedMinute = clockMinutes(previousSleepLog.bedTime);
  const previousSleepDuration = previousBedMinute === null || wakeMinute === null
    ? null
    : (wakeMinute - previousBedMinute + 1440) % 1440;
  addEvent({
    kind: "sleep",
    role: "wake",
    mapTitle: wakeMinute === null ? `بداية يوم ${name}` : `استيقظ ${name}`,
    time: wakeMinute === null ? "" : timeLabel(sleepLog.wakeTime),
    sortMinute: wakeMinute ?? 0,
    status: wakeMinute === null ? "pending" : "done",
    progress: wakeMinute === null ? 0 : 1,
    timeIsActual: wakeMinute !== null,
    title: wakeMinute === null ? `بداية يوم ${name}` : `استيقظ ${name} الآن`,
    detailLines: [
      wakeMinute === null ? "لم يُسجّل وقت الاستيقاظ." : `وقت الاستيقاظ: ${timeLabel(sleepLog.wakeTime)}`,
      ...(previousBedMinute === null ? [] : [`النوم السابق: ${timeLabel(previousSleepLog.bedTime)}${previousSleepDuration ? ` · ${formatSleepDuration(previousSleepDuration)}` : ""}`]),
    ],
    detail: wakeMinute === null
      ? "لم يُسجّل وقت الاستيقاظ لهذا اليوم."
      : `استيقظ عند ${timeLabel(sleepLog.wakeTime)}${previousBedMinute === null ? "" : ` بعد نوم عند ${timeLabel(previousSleepLog.bedTime)}${previousSleepDuration ? ` · مدة النوم ${formatSleepDuration(previousSleepDuration)}` : ""}`}.`,
  });
  if (clockMinutes(sleepLog.napStart) !== null && Number(sleepLog.napDurationMin) > 0) {
    addEvent({
      kind: "sleep",
      role: "nap",
      mapTitle: `قيلولة ${name}`,
      time: timeLabel(sleepLog.napStart),
      sortMinute: clockMinutes(sleepLog.napStart),
      status: "done",
      progress: 1,
      title: `أخذ ${name} قيلولة`,
      detail: `استغرقت ${formatSleepDuration(Number(sleepLog.napDurationMin))}.`,
    });
  }

  const tasks = dayTasks(date);
  for (const task of tasks) {
    const checklist = (task.checklist ?? [])
      .map((item) => typeof item === "string" ? { text: item, done: false } : item)
      .filter((item) => item && typeof item === "object");
    const checklistDone = checklist.filter((item) => item.done).length;
    const checklistDetail = checklist.length
      ? `${formatArabicNumber(checklistDone)} من ${formatArabicNumber(checklist.length)} خطوات`
      : "";
    const checklistLines = checklist.map((item) => `${item.done ? "✓" : "○"} ${item.text}`);
    const logs = (Array.isArray(task.completionLog) ? task.completionLog : [])
      .filter((entry) => datePart(entry?.completedAt ?? entry?.date) === date);
    const markedDoneToday = task.status === "done"
      && (task.completedAt ? datePart(task.completedAt) === date : taskDates(task).includes(date));
    const completionEntries = logs.length
      ? logs
      : markedDoneToday
        ? [{ completedAt: task.completedAt }]
        : [];
    if (task.status === "done" && completionEntries.length) {
      const entry = completionEntries.at(-1);
      const completedTime = storyTime(entry.completedAt);
      addEvent({
        kind: "task",
        mapTitle: task.title,
        time: completedTime || (task.dueTime ? timeLabel(task.dueTime) : ""),
        sortMinute: storyMinute(entry.completedAt) ?? clockMinutes(task.dueTime) ?? 24 * 60,
        status: "done",
        progress: 1,
        durationMin: Number.isFinite(Number(entry.durationMin)) ? Number(entry.durationMin) : 0,
        timeIsActual: Boolean(completedTime),
        title: `أنجز ${name} المهمة: ${task.title}`,
        taskId: task.id,
        completedAt: completedTime,
        taskTitle: task.title,
        checklistDetail,
        detailLines: [
          `اكتملت الساعة ${completedTime || "وقت الإنجاز غير مسجل"}`,
          ...(entry.durationMin ? [`مدة التركيز: ${formatDuration(entry.durationMin)}`] : []),
          ...checklistLines,
        ],
        futureTitle: `مهمة: ${task.title}`,
        detail: `${completedTime ? `اكتملت الساعة ${completedTime}` : "مكتملة · وقت الإنجاز غير مسجل"}${entry.durationMin ? ` · مدة التركيز ${formatDuration(entry.durationMin)}` : ""}${checklistDetail ? ` · ${checklistDetail}` : ""}.`,
      });
    } else if (task.status !== "done") {
      const progress = taskCompletion(task);
      addEvent({
        kind: "task",
        mapTitle: task.title,
        taskId: task.id,
        time: task.dueTime ? timeLabel(task.dueTime) : "",
        sortMinute: clockMinutes(task.dueTime) ?? 24 * 60,
        status: progress > 0 ? "partial" : "pending",
        progress,
        checklistDetail,
        detailLines: [
          progress > 0 ? `التقدم: ${formatArabicNumber(Math.round(progress * 100))}٪` : "لم يبدأ تسجيل الإنجاز.",
          ...checklistLines,
        ],
        title: `موعد المهمة: ${task.title}`,
        detail: progress > 0
          ? `قيد الإنجاز · ${checklistDetail || `${formatArabicNumber(Math.round(progress * 100))}٪ من المهمة`}.`
          : `لم يُسجّل إنجازها بعد.${checklistDetail ? ` · ${checklistDetail}` : ""}`,
      });
    }
  }

  let schedule;
  try {
    schedule = prayerSchedule(date);
  } catch (error) {
    console.error("تعذّر تجهيز مواقيت الصلاة لمسار المشاركة:", error);
  }
  const prayerHabit = linkedPrayerHabit();
  const prayerTimes = new Map((schedule?.times ?? []).map((prayer) => [prayer.name, prayer]));
  const prayerMinutesByName = new Map(Object.keys(PRAYER_ITEM_NAMES).map((prayerName) => {
    const time = prayerTimes.get(prayerName);
    return [prayerName, Number.isFinite(time?.time) ? prayerMinutes(time.time) : PRAYER_ORDER_IF_LOCATION_UNAVAILABLE[prayerName]];
  }));
  const itemLogTimes = prayerHabit?.itemLogTimes?.[date] ?? {};
  const prayerItemsForCategory = (categoryItems) => {
    const done = categoryItems.filter((item) => prayerStatus(item, prayerHabit, date));
    const totalRakats = categoryItems.reduce((sum, item) => sum + Math.max(0, Number(item.amount) || 0), 0);
    const doneRakats = done.reduce((sum, item) => sum + Math.max(0, Number(item.amount) || 0), 0);
    return {
      doneCount: done.length,
      count: categoryItems.length,
      doneRakats,
      totalRakats,
      done,
    };
  };
  const prayerNames = Object.keys(PRAYER_ITEM_NAMES);
  for (const prayerName of prayerNames) {
    const prayer = prayerTimes.get(prayerName);
    const items = prayerItemsFor(prayerHabit, prayerName);
    const fard = items.filter((item) => item.category === "فرض");
    const sunnah = items.filter((item) => item.category === "سنة");
    const fardProgress = prayerItemsForCategory(fard);
    const sunnahProgress = prayerItemsForCategory(sunnah);
    const fardDone = fardProgress.doneCount;
    const minute = Number.isFinite(prayer?.time)
      ? prayerMinutes(prayer.time)
      : PRAYER_ORDER_IF_LOCATION_UNAVAILABLE[prayerName];
    const performedItems = [...fardProgress.done, ...sunnahProgress.done];
    const performedAt = performedItems.map((item) => storyMinute(itemLogTimes[item.id]))
      .filter((value) => value !== null)
      .sort((first, second) => second - first)[0];
    const completedTime = performedAt === undefined ? "" : timeLabel(minuteTime(performedAt));
    const hasPrayerProgress = fardDone > 0 || sunnahProgress.doneCount > 0;
    const prayerComplete = fard.length > 0 && fardDone === fard.length;
    const prayerDetailLines = [...fard, ...sunnah].map((item) => {
      const logged = prayerStatus(item, prayerHabit, date);
      const loggedTime = storyTime(itemLogTimes[item.id]);
      return `${logged ? "✓" : "○"} ${item.category}: ${item.name} · ${formatArabicNumber(Math.max(0, Number(item.amount) || 0))} ${item.unit || "ركعة"}${loggedTime ? ` · ${loggedTime}` : ""}`;
    });
    addEvent({
      kind: "prayer",
      mapTitle: `صلاة ${prayerName}`,
      prayerName,
      time: completedTime || (Number.isFinite(prayer?.time) ? formatPrayerTime(prayer.time) : ""),
      sortMinute: performedAt ?? minute,
      status: prayerComplete ? "done" : hasPrayerProgress ? "partial" : "pending",
      progress: prayerComplete ? 1 : items.length ? performedItems.length / items.length : 0,
      timeIsActual: performedAt !== undefined,
      title: prayerComplete
        ? `يصلي ${name} صلاة ${prayerName} الآن`
        : hasPrayerProgress
          ? `يتابع ${name} صلاة ${prayerName}`
          : `موعد صلاة ${prayerName}`,
      inProgressTitle: `يصلي ${name} صلاة ${prayerName} الآن`,
      futureTitle: `صلاة ${prayerName}`,
      prayerCounts: {
        fardDone: fardProgress.doneRakats,
        fardTotal: fardProgress.totalRakats,
        sunnahDone: sunnahProgress.doneRakats,
        sunnahTotal: sunnahProgress.totalRakats,
      },
      detailLines: [
        `الفرض: ${formatArabicNumber(fardProgress.doneRakats)} من ${formatArabicNumber(fardProgress.totalRakats)} ركعة`,
        ...(sunnah.length ? [`السنة: ${formatArabicNumber(sunnahProgress.doneRakats)} من ${formatArabicNumber(sunnahProgress.totalRakats)} ركعة`] : []),
        ...prayerDetailLines,
        ...(performedAt === undefined && hasPrayerProgress ? ["وقت الأداء الفعلي غير مسجل."] : []),
      ],
      detail: `${completedTime ? `وقت التسجيل ${completedTime} · ` : ""}الفرض: ${formatArabicNumber(fardProgress.doneRakats)} من ${formatArabicNumber(fardProgress.totalRakats)} ركعة (${formatArabicNumber(fardProgress.doneCount)} من ${formatArabicNumber(fardProgress.count)} بنود)${sunnah.length ? ` · السنة: ${formatArabicNumber(sunnahProgress.doneRakats)} من ${formatArabicNumber(sunnahProgress.totalRakats)} ركعة (${formatArabicNumber(sunnahProgress.doneCount)} من ${formatArabicNumber(sunnahProgress.count)} بنود)` : ""}${!hasPrayerProgress ? " · لم يُسجّل أداؤها بعد؛ الوقت المعروض هو موعد الصلاة." : performedAt === undefined ? " · وقت الأداء الفعلي غير مسجل." : ""}`,
    });
  }

  for (const habit of dayHabits(date)) {
    if (habit.id === prayerHabit?.id) continue;
    const progress = dayProgress(habit, date);
    const details = habit.completionLog?.[date] ?? {};
    const recordedTime = storyTime(details.completedAt);
    const title = habit.title ?? "";
    const plannedMinute = clockMinutes(habit.dailyTime)
      ?? (/أذكار الصباح/.test(title) ? (prayerMinutesByName.get("الفجر") + 20) % 1440
        : /الضحى/.test(title) ? (prayerMinutesByName.get("الفجر") + 120) % 1440
          : /أذكار المساء/.test(title) ? prayerMinutesByName.get("المغرب") : null);
    const plannedTime = plannedMinute === null ? "" : minuteTime(plannedMinute);
    const detail = progress.mode === "items"
      ? `${formatArabicNumber(progress.done)} من ${formatArabicNumber(progress.target)} بنود.`
      : progress.mode === "count"
        ? `${formatArabicNumber(progress.done)} من ${formatArabicNumber(progress.target)} ${habit.unit || "مرات"}.`
        : progress.complete ? "اكتمل تسجيل العادة." : "لم يُسجّل إنجازها بعد.";
    const habitDetailLines = progress.mode === "items"
      ? [
        `التقدم: ${formatArabicNumber(progress.done)} من ${formatArabicNumber(progress.target)} بنود`,
        ...(habit.items ?? []).map((item) => `${(habit.itemLog?.[date] ?? []).includes(item.id) ? "✓" : "○"} ${item.name}`),
      ]
      : progress.mode === "count"
        ? [`العدد: ${formatArabicNumber(progress.done)} من ${formatArabicNumber(progress.target)} ${habit.unit || "مرات"}`]
        : [progress.complete ? "اكتمل تسجيل العادة." : "لم يُسجّل إنجازها بعد."];
    addEvent({
      kind: "habit",
      mapTitle: habit.title,
      habitId: habit.id,
      time: recordedTime || (plannedTime ? timeLabel(plannedTime) : ""),
      sortMinute: storyMinute(details.completedAt) ?? plannedMinute ?? 24 * 60,
      status: progress.complete ? "done" : progress.done > 0 ? "partial" : "pending",
      progress: progress.percent / 100,
      durationMin: Number(details.durationMin) || 0,
      completedAt: recordedTime,
      timeIsActual: Boolean(recordedTime),
      habitTitle: habit.title,
      detailLines: [
        ...habitDetailLines,
        ...(recordedTime ? [`وقت التسجيل: ${recordedTime}`] : plannedTime ? [`الموعد المخطط: ${timeLabel(plannedTime)}`] : []),
      ],
      futureTitle: `عادة: ${habit.title}`,
      title: progress.complete
        ? `أكمل ${name} عادة ${habit.title}`
        : progress.done
          ? `تقدّم ${name} في ${habit.title}`
          : `موعد عادة ${habit.title}`,
      detail: `${detail}${!progress.complete && progress.done === 0 ? "" : recordedTime ? "" : " وقتها المعروض مخطط لا وقت التسجيل."}`,
    });
  }

  if (prayerHabit) {
    const nightItems = (prayerHabit.items ?? []).filter((item) =>
      NIGHT_PRAYERS.some((namePart) => item.name.includes(namePart)));
    const nightDone = nightItems.filter((item) => prayerStatus(item, prayerHabit, date));
    const nightRakats = nightDone.reduce((sum, item) => sum + Math.max(0, Number(item.amount) || 0), 0);
    const nightTotalRakats = nightItems.reduce((sum, item) => sum + Math.max(0, Number(item.amount) || 0), 0);
    const nightTimes = nightDone.map((item) => storyMinute(itemLogTimes[item.id]))
      .filter((value) => value !== null)
      .sort((first, second) => first - second);
    const nightTime = nightTimes.length ? timeLabel(minuteTime(nightTimes.at(-1))) : "";
    if (nightItems.length) {
      addEvent({
        kind: "night",
        mapTitle: "قيام الليل · الشفع والوتر",
        nightKey: "night",
        time: nightTime,
        sortMinute: nightTimes.at(-1) ?? 23 * 60,
        status: nightDone.length === nightItems.length ? "done" : nightDone.length ? "partial" : "pending",
        progress: nightItems.length ? nightDone.length / nightItems.length : 0,
        timeIsActual: nightTimes.length > 0,
        title: "قيام الليل · الشفع والوتر",
        nightItems: nightItems.map((item) => ({
          name: item.name,
          amount: Math.max(0, Number(item.amount) || 0),
          unit: item.unit || "ركعة",
          category: item.category || "",
          done: prayerStatus(item, prayerHabit, date),
          time: storyTime(itemLogTimes[item.id]),
        })),
        detailLines: [
          ...nightItems.map((item) => `${prayerStatus(item, prayerHabit, date) ? "✓" : "○"} ${item.category ? `${item.category}: ` : ""}${item.name} · ${formatArabicNumber(Math.max(0, Number(item.amount) || 0))} ${item.unit || "ركعة"}${storyTime(itemLogTimes[item.id]) ? ` · ${storyTime(itemLogTimes[item.id])}` : ""}`),
          ...(nightTime ? [`وقت التسجيل: ${nightTime}`] : nightDone.length ? ["وقت الأداء الفعلي غير مسجل."] : []),
        ],
        nightCounts: {
          done: nightRakats,
          total: nightTotalRakats,
          doneItems: nightDone.length,
          totalItems: nightItems.length,
        },
        detail: `${nightItems.map((item) => `${item.category ? `${item.category}: ` : ""}${item.name}: ${prayerStatus(item, prayerHabit, date) ? `${formatArabicNumber(Math.max(0, Number(item.amount) || 0))} ${item.unit || "ركعة"}` : "لم يُسجّل"}`).join("\n")}${nightTime ? `\nوقت التسجيل ${nightTime}` : nightDone.length ? "\nوقت الأداء الفعلي غير مسجل." : ""}`,
      });
    }
  }

  const bedMinute = clockMinutes(sleepLog.bedTime);
  if (bedMinute !== null) {
    addEvent({
      kind: "sleep",
      role: "bed",
      mapTitle: `نام ${name}`,
      time: timeLabel(sleepLog.bedTime),
      sortMinute: bedMinute,
      status: "done",
      progress: 1,
      timeIsActual: true,
      title: `نام ${name}`,
      detailLines: [`وقت النوم: ${timeLabel(sleepLog.bedTime)}`],
      detail: `سُجّل وقت النوم عند ${timeLabel(sleepLog.bedTime)}.`,
    });
  } else {
    const expectedBedtime = sleepSettings().bedtime;
    if (clockMinutes(expectedBedtime) !== null) {
      addEvent({
        kind: "sleep",
        role: "bed",
        mapTitle: `موعد نوم ${name}`,
        time: timeLabel(expectedBedtime),
        sortMinute: clockMinutes(expectedBedtime),
        title: `موعد نوم ${name}`,
        detailLines: [`موعد النوم المعتاد: ${timeLabel(expectedBedtime)}`, "هذا موعد مخطط وليس تسجيلًا فعليًا."],
        detail: "هذا وقت النوم المعتاد، وليس تسجيلًا فعليًا لنوم اليوم.",
      });
    } else {
      addEvent({
        kind: "sleep",
        role: "bed",
        mapTitle: `نوم ${name}`,
        title: `نوم ${name}`,
        detailLines: ["لم يُسجّل وقت النوم لهذا اليوم."],
        detail: "لم يُسجّل وقت النوم لهذا اليوم.",
      });
    }
  }

  events.sort((first, second) => first.sortMinute - second.sortMinute);
  const wakeEvent = events.find((event) => event.role === "wake");
  const bedEvent = events.find((event) => event.role === "bed");
  const nightEvent = events.find((event) => event.kind === "night");
  const dayEvents = events.filter((event) => !["wake", "bed"].includes(event.role) && event.kind !== "night");
  const mapEvents = buildEvents(tasks, dayHabits(date), schedule, date);
  const mapOrder = new Map(mapEvents.map((event, index) => {
    const key = event.type === "task" ? `task:${event.task.id}`
      : event.type === "habit" ? `habit:${event.habit.id}`
        : event.type === "prayer" ? `prayer:${event.prayer.name}`
          : "night";
    return [key, index];
  }));
  const eventKey = (event) => event.kind === "task" ? `task:${event.taskId}`
    : event.kind === "habit" ? `habit:${event.habitId}`
      : event.kind === "prayer" ? `prayer:${event.prayerName}`
        : event.nightKey;
  const storyOrder = (event) => {
    const key = eventKey(event);
    if (mapOrder.has(key)) return mapOrder.get(key);
    if (event.role === "nap") {
      const next = mapEvents.findIndex((item) => item.sortMinute >= event.sortMinute);
      return next < 0 ? mapEvents.length - 0.5 : next - 0.5;
    }
    return mapEvents.length;
  };
  dayEvents.sort((first, second) => storyOrder(first) - storyOrder(second));
  dayEvents.forEach((event) => {
    event.mapIndex = Math.max(0, Math.floor(storyOrder(event)));
  });
  const routeEvents = [
    ...(wakeEvent ? [wakeEvent] : []),
    ...dayEvents,
    ...(nightEvent ? [nightEvent] : []),
    ...(bedEvent ? [bedEvent] : []),
  ];
  const activities = routeEvents.filter((event) => ["task", "habit", "prayer", "night"].includes(event.kind));
  const completedEvents = activities.filter((event) => event.status === "done").length;
  const partialEvents = activities.filter((event) => event.status === "partial").length;
  const pendingEvents = activities.filter((event) => event.status === "pending").length;
  const score = buildScore(tasks, dayHabits(date), date);
  return {
    name,
    date,
    dateLabel: formatDate(date),
    score: score.percent,
    events: [
      ...routeEvents,
      {
        kind: "end",
        mapTitle: "ختام اليوم",
        time: "",
        status: "done",
        progress: 1,
        title: `ختام يوم ${name}`,
        detail: `${formatArabicNumber(completedEvents)} مكتملة · ${formatArabicNumber(partialEvents)} جزئية · ${formatArabicNumber(pendingEvents)} لم تكتمل · إنجاز اليوم ${formatArabicNumber(score.percent)}٪.\nالاستيقاظ: ${wakeEvent?.timeIsActual ? wakeEvent.time : "غير مسجل"} · النوم: ${bedEvent?.timeIsActual ? bedEvent.time : "غير مسجل"}.`,
        summary: { completed: completedEvents, partial: partialEvents, pending: pendingEvents },
        sleepSummary: {
          wakeTime: wakeEvent?.timeIsActual ? wakeEvent.time : "",
          bedTime: bedEvent?.timeIsActual ? bedEvent.time : "",
        },
      },
    ],
  };
}

function renderDayStoryDialog(story) {
  return `<div class="space-day-story-content" dir="rtl">
    <header class="space-day-story-heading">
      <div><small>حكاية يومك · ${escapeHtml(story.dateLabel)}</small><h2>معاينة مسار اليوم</h2></div>
      <button class="icon-button" type="button" data-action="close-day-story" aria-label="إغلاق">×</button>
    </header>
    <label class="space-day-story-name">الاسم الظاهر في المشاركة
      <input type="text" maxlength="60" data-story-name value="${escapeHtml(story.name)}">
    </label>
    <section class="space-day-story-current" aria-live="polite">
      <span data-story-position></span><strong data-story-title></strong><p data-story-detail></p>
    </section>
    <div class="space-day-story-controls">
      <button type="button" data-action="story-prev" aria-label="المحطة السابقة">‹</button>
      <input type="range" min="0" max="${story.events.length - 1}" value="0" data-story-seek aria-label="التنقل بين محطات اليوم">
      <button type="button" data-action="story-play" aria-label="تشغيل أو إيقاف المسار">▶</button>
      <button type="button" data-action="story-next" aria-label="المحطة التالية">›</button>
    </div>
    <nav class="space-day-story-stops" aria-label="محطات اليوم">
      ${story.events.map((event, index) => `<button type="button" data-story-index="${index}"${index === 0 ? ' aria-current="step"' : ""}>
        <span>${event.time ? escapeHtml(event.time) : formatArabicNumber(index + 1)}</span><strong>${escapeHtml(event.title)}</strong>
      </button>`).join("")}
    </nav>
    <footer class="space-day-story-actions">
      <button class="button button-secondary" type="button" data-action="story-share-gif">مشاركة GIF متحرك</button>
    </footer>
    <small class="space-day-story-privacy">تُضمّن البيانات التي تختار مشاركتها داخل الملف فقط، ولا تُرفع إلى خادم.</small>
  </div>`;
}

function updateDayStoryPosition(dialog, requestedIndex = activeStoryIndex) {
  if (!dialog || !activeStoryEvents.length) return;
  activeStoryIndex = (requestedIndex + activeStoryEvents.length) % activeStoryEvents.length;
  const event = activeStoryEvents[activeStoryIndex];
  dialog.querySelector("[data-story-position]").textContent =
    `${event.time ? `${event.time} · ` : ""}المحطة ${formatArabicNumber(activeStoryIndex + 1)} من ${formatArabicNumber(activeStoryEvents.length)}`;
  dialog.querySelector("[data-story-title]").textContent = event.title;
  dialog.querySelector("[data-story-detail]").textContent = event.detail;
  dialog.querySelector("[data-story-seek]").value = String(activeStoryIndex);
  dialog.querySelectorAll("[data-story-index]").forEach((button, index) => {
    if (index === activeStoryIndex) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
  dialog.querySelector(`[data-story-index="${activeStoryIndex}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function openDayStoryDialog(date) {
  const dialog = document.querySelector("#space-day-story-dialog");
  if (!dialog) return;
  window.clearInterval(storyPlaybackInterval);
  const story = buildDayStory(date);
  dialog.dataset.storyDate = date;
  activeStoryEvents = story.events;
  activeStoryIndex = 0;
  dialog.innerHTML = renderDayStoryDialog(story);
  dialog.showModal();
  updateDayStoryPosition(dialog, 0);
}

function currentDayStory(dialog) {
  const date = dialog?.dataset.storyDate || mapDate;
  return buildDayStory(date, dialog?.querySelector("[data-story-name]")?.value);
}

function renderMapControls() {
  const { start, end } = mapBounds();
  return `<div class="space-map-controls">
    <div class="space-map-recap-control">
      <button class="space-map-recap-action" type="button" data-action="period-recap" data-start="${start}" data-end="${end}" data-label="حصاد ${MAP_MODE_LABELS[mapMode]}">
        <span aria-hidden="true">✦</span> الحصاد
      </button>
    </div>
    <nav class="space-map-modes" aria-label="مدى خارطة اليوم">
      ${MAP_MODES.map((mode) => `<button type="button" data-action="map-mode" data-mode="${mode}" aria-pressed="${mapMode === mode}">${MAP_MODE_LABELS[mode]}</button>`).join("")}
    </nav>
    <nav class="space-map-period-controls" aria-label="التنقل بين الفترات">
      <button type="button" data-action="map-shift" data-direction="-1" aria-label="الفترة السابقة">‹</button>
      <button type="button" data-action="map-shift" data-direction="1" aria-label="الفترة التالية">›</button>
    </nav>
  </div>`;
}

function render() {
  const app = document.querySelector("#app");
  if (!app || !isMounted) return;
  periodDayMetricsCache.clear();
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
    <div class="cosmic-map" style="--map-length:${mapMode === "day" ? dayEvents.length : overviewStops.length}" data-map-mode="${mapMode}" data-prayer-state="${mapMode !== "day" ? "range" : location ? "ready" : scheduleError ? "error" : "needs-location"}">
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
      ${mapMode === "day" ? `<div class="space-map-sleep-start">${renderDayStart()}</div>` : ""}
      ${mapMode === "day" ? `<nav class="space-map-day-links" aria-label="تفاصيل ${escapeHtml(formatDate(mapDate))}">
        <a href="#/tasks?date=${encodeURIComponent(mapDate)}">مهام اليوم <strong>${formatArabicNumber(tasks.length)}</strong></a>
        <a href="#/habits?date=${encodeURIComponent(mapDate)}">عادات اليوم <strong>${formatArabicNumber(habits.length)}</strong></a>
        <button type="button" data-action="share-day-story">مشاركة مسار اليوم</button>
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
  </section>
  <dialog class="space-period-recap-dialog" id="space-period-recap-dialog" aria-label="حصاد الفترة"></dialog>
  <dialog class="space-prayer-log-dialog" id="space-prayer-log-dialog" aria-label="تسجيل الصلاة"></dialog>
  <dialog class="space-sleep-dialog" id="space-sleep-dialog" aria-label="تفاصيل النوم والقيلولة"></dialog>
  <dialog class="space-day-story-dialog" id="space-day-story-dialog" aria-label="مشاركة مسار اليوم"></dialog>`;
}

function updateLiveClock() {
  if (!isMounted || mapMode !== "day" || mapDate !== localDateString()) return;
  const now = new Date();
  const time = timeLabel(currentTimeValue(now));
  document.querySelectorAll("[data-live-clock]").forEach((element) => {
    element.textContent = time;
  });
  const today = localDateString(now);
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const routeStops = [...document.querySelectorAll(".cosmic-map-route:not(.is-overview) .space-map-stop[data-event-minute]:not([data-event-kind=\"day-start\"])")];
  let currentStop = routeStops.find((stop) => Number(stop.dataset.eventMinute) >= currentMinute);
  if (!currentStop) currentStop = routeStops.at(-1);
  for (const stop of routeStops) {
    const passed = Number(stop.dataset.eventMinute) < currentMinute && stop.dataset.stopStatus !== "done";
    stop.classList.toggle("is-time-passed", passed);
    stop.classList.toggle("is-current-time", stop === currentStop);
  }

  const reminderKey = `mihwar-end-of-day-reminder:${today}`;
  if (document.visibilityState !== "visible") return;
  const minutesUntilBedtime = (clockMinutes(sleepBedtimeFor(today)) - (now.getHours() * 60 + now.getMinutes()) + 1440) % 1440;
  const score = buildScore(dayTasks(today), dayHabits(today), today);
  if (minutesUntilBedtime > 0 && minutesUntilBedtime <= 180 && score.hasItems
    && score.percent < LOW_PROGRESS_THRESHOLD && localStorage.getItem(reminderKey) !== "shown") {
    localStorage.setItem(reminderKey, "shown");
    const heavyCount = dayTasks(today).filter((task) => isHeavyTaskNearBedtime(task, today)).length;
    showToast(`بقي أقل من ٣ ساعات على موعد نومك. إنجازك ${formatArabicNumber(score.percent)}٪${heavyCount ? `، وهناك ${formatArabicNumber(heavyCount)} مهام عالية الأولوية قريبة من النوم` : ""}. اختر خطوة خفيفة تُنهيها الآن.`, { duration: 9000 });
  }
}

async function saveSleepLog(date, changes) {
  const existing = sleepLogFor(date);
  const now = new Date().toISOString();
  const next = {
    ...(existing ?? {}),
    id: `sleep-log:${date}`,
    date,
    ...changes,
    updatedAt: now,
  };
  if (existing) await update("device", next);
  else await add("device", { ...next, createdAt: now });
  records.device = existing
    ? records.device.map((entry) => entry.id === next.id ? next : entry)
    : [...records.device, { ...next, createdAt: now }];
}

async function saveSleepLogWithFeedback(date, changes, message) {
  try {
    await saveSleepLog(date, changes);
    showToast(message);
    return true;
  } catch (error) {
    console.error("تعذّر حفظ سجل النوم:", error);
    showToast(`تعذّر حفظ سجل النوم: ${error.message}`, { isError: true });
    return false;
  }
}

function sleepEntriesComplete(date) {
  const wakeTime = sleepLogFor(date)?.wakeTime;
  const bedtime = sleepLogFor(dateOffset(date, -1))?.bedTime;
  const nap = sleepLogFor(date) ?? {};
  const napRecorded = clockMinutes(nap.napStart) !== null && Number(nap.napDurationMin) > 0;
  return clockMinutes(wakeTime) !== null && clockMinutes(bedtime) !== null
    && (napRecorded || nap.napSkipped === true);
}

function finishSleepEntrySave(date, nodeSelector) {
  if (!sleepEntriesComplete(date)) {
    showToast("حُفظ الوقت. أكمل تسجيل الاستيقاظ والنوم والقيلولة أو اختر «لم آخذ قيلولة».");
    return;
  }
  document.querySelector("#space-sleep-dialog")?.close();
  render();
  animateMapCompletion(nodeSelector);
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

function animateMapCompletion(selector) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const card = document.querySelector(selector);
    if (!card) return;
    const stop = card.closest(".space-map-stop");
    card.classList.remove("is-celebrating");
    stop?.classList.remove("is-path-illuminating");
    void card.offsetWidth;
    card.classList.add("is-celebrating");
    stop?.classList.add("is-path-lit", "is-path-illuminating");
    window.setTimeout(() => stop?.classList.remove("is-path-illuminating"), 1100);
  }));
}

function mapNodeSelector(className, attribute, value) {
  return `${className}[${attribute}="${CSS.escape(value)}"]`;
}

function bindEvents(app) {
  eventController?.abort();
  eventController = new AbortController();
  const { signal } = eventController;

  app.addEventListener("close", (event) => {
    if (!(event.target instanceof HTMLDialogElement)) return;
    if (event.target.id === "space-day-story-dialog") {
      window.clearInterval(storyPlaybackInterval);
      storyPlaybackInterval = undefined;
      activeStoryEvents = [];
    }
    if (isMounted) render();
  }, { capture: true, signal });

  app.addEventListener("toggle", (event) => {
    const details = event.target.closest("[data-map-task-details]");
    if (!details) return;
    const taskId = details.dataset.mapTaskDetails;
    if (details.open) expandedMapTaskDetails.add(taskId);
    else expandedMapTaskDetails.delete(taskId);
  }, { capture: true, signal });

  app.addEventListener("click", async (event) => {
    const recapDialog = app.querySelector("#space-period-recap-dialog");
    if (event.target === recapDialog) {
      recapDialog.close();
      return;
    }
    const prayerDialog = app.querySelector("#space-prayer-log-dialog");
    if (event.target === prayerDialog) {
      prayerDialog.close();
      return;
    }
    const sleepDialog = app.querySelector("#space-sleep-dialog");
    if (event.target === sleepDialog) {
      sleepDialog.close();
      return;
    }
    const storyDialog = app.querySelector("#space-day-story-dialog");
    if (event.target === storyDialog) {
      storyDialog.close();
      return;
    }
    const recapRangeButton = event.target.closest("[data-recap-range]");
    if (recapRangeButton) {
      const mode = recapRangeButton.dataset.recapRange;
      if (!MAP_MODES.includes(mode)) return;
      const anchorDate = recapSelectedDate || recapAnchorDate;
      const bounds = recapPeriodBounds(mode, anchorDate);
      openPeriodRecap(bounds.start, bounds.end, `حصاد ${MAP_MODE_LABELS[mode]}`, mode, anchorDate);
      return;
    }
    const recapPeriodButton = event.target.closest("[data-recap-period-start]");
    if (recapPeriodButton) {
      const { recapPeriodStart: start, recapPeriodEnd: end, recapPeriodMode: mode } = recapPeriodButton.dataset;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? "")
        || start > end || !MAP_MODES.includes(mode)) return;
      if (mode === "day") {
        recapSelectedDate = start;
        recapAnchorDate = start;
        const dialog = app.querySelector("#space-period-recap-dialog");
        if (dialog) dialog.innerHTML = renderPeriodRecap(recapStart, recapEnd, recapLabel);
        return;
      }
      const anchorDate = recapSelectedDate >= start && recapSelectedDate <= end ? recapSelectedDate : end;
      openPeriodRecap(start, end, recapPeriodButton.dataset.recapPeriodLabel || "حصاد الفترة", mode, anchorDate);
      return;
    }
    const storyStop = event.target.closest("[data-story-index]");
    if (storyStop) {
      updateDayStoryPosition(storyDialog, Number(storyStop.dataset.storyIndex));
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button) return;
    if (button.matches("[data-card-action]")
      && event.target.closest("a, button, input, summary, select, textarea, details")) return;
    if (button.dataset.action === "close-recap") {
      recapDialog?.close();
      return;
    }
    if (button.dataset.action === "close-prayer-log") {
      prayerDialog?.close();
      return;
    }
    if (button.dataset.action === "open-sleep-dialog") {
      renderSleepDialog(mapDate);
      return;
    }
    if (button.dataset.action === "close-sleep-dialog") {
      sleepDialog?.close();
      return;
    }
    if (button.dataset.action === "share-day-story") {
      openDayStoryDialog(mapDate);
      return;
    }
    if (button.dataset.action === "share-period-path") {
      try {
        const { start, end } = mapBounds();
        const title = `مسار ${MAP_MODE_LABELS[mapMode]}`;
        const report = periodReport(start, end, `حصاد ${MAP_MODE_LABELS[mapMode]}`);
        const series = periodStops().map((stop) => ({
          title: stop.title,
          subtitle: stop.subtitle,
          metrics: periodMetrics(stop.start, stop.end),
        }));
        const file = await animatedPeriodStoryFile({
          mode: mapMode,
          title,
          period: report.period,
          summary: report.summary,
          series,
          sections: report.sections,
        });
        const result = await shareOrDownloadStoryFile(
          file,
          `${title} · مِحوَر`,
          `تقرير ${title} للفترة ${report.period}، مع الرسوم البيانية والإحصاءات والتفاصيل.`,
        );
        if (result === "shared") showToast("أُرفق مسار الفترة ورسومه وإحصاءاته للمشاركة.");
        else if (result === "downloaded") showToast("نُزّل مسار الفترة كصورة GIF متحركة، ويمكنك مشاركته.");
      } catch (error) {
        console.error("تعذّر تجهيز مسار الفترة للمشاركة:", error);
        showToast(`تعذّر تجهيز التقرير: ${error.message}`, { isError: true });
      }
      return;
    }
    if (button.dataset.action === "close-day-story") {
      storyDialog?.close();
      return;
    }
    if (button.dataset.action === "story-prev" || button.dataset.action === "story-next") {
      updateDayStoryPosition(storyDialog, activeStoryIndex + (button.dataset.action === "story-prev" ? -1 : 1));
      return;
    }
    if (button.dataset.action === "story-play") {
      if (storyPlaybackInterval) {
        window.clearInterval(storyPlaybackInterval);
        storyPlaybackInterval = undefined;
        button.textContent = "▶";
      } else {
        button.textContent = "Ⅱ";
        storyPlaybackInterval = window.setInterval(() => {
          if (!storyDialog?.open) {
            window.clearInterval(storyPlaybackInterval);
            storyPlaybackInterval = undefined;
            return;
          }
          updateDayStoryPosition(storyDialog, activeStoryIndex + 1);
        }, 2400);
      }
      return;
    }
    if (button.dataset.action === "story-share-gif") {
      try {
        const story = currentDayStory(storyDialog);
        const file = await animatedDayStoryFile(story);
        const result = await shareOrDownloadStoryFile(
          file,
          `حكاية يوم ${story.name} · مِحوَر`,
          `خارطة ${story.dateLabel} من مِحوَر`,
        );
        if (result === "shared") showToast("أُرفق مسار اليوم للمشاركة.");
        else if (result === "downloaded") showToast("نُزّل الملف؛ أرفقه في تطبيق المشاركة.");
      } catch (error) {
        console.error("تعذّر تجهيز مسار اليوم للمشاركة:", error);
        showToast(`تعذّر تجهيز الملف: ${error.message}`, { isError: true });
      }
      return;
    }
    if (button.dataset.action === "prayer-mark-category") {
      const form = button.closest("[data-prayer-log-form]");
      const category = button.dataset.category;
      const complete = button.dataset.complete === "true";
      if (!form || !["فرض", "سنة"].includes(category)) return;
      form.querySelectorAll(`[data-prayer-item][data-category="${category}"] input`)
        .forEach((input) => {
          input.checked = complete;
          input.closest("label").querySelector("i").textContent = complete ? "✓" : "";
        });
      const inputs = [...form.querySelectorAll(`[data-prayer-item][data-category="${category}"] input`)];
      const done = inputs.filter((input) => input.checked).length;
      form.querySelector(`[data-prayer-category-group="${category}"] [data-prayer-count]`).textContent =
        `${formatArabicNumber(done)} / ${formatArabicNumber(inputs.length)}`;
      return;
    }
    if (button.dataset.action === "open-prayer-log") {
      const habit = records.habits.find((item) => item.id === button.dataset.habitId);
      if (habit) openPrayerLog(habit, button.dataset.prayer, button.dataset.date);
      return;
    }
    if (button.dataset.action === "open-habit") {
      window.location.hash = `/habits?date=${encodeURIComponent(button.dataset.date || mapDate)}`;
      return;
    }
    if (button.dataset.action === "period-recap") {
      const { start, end, label } = button.dataset;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? "") || start > end) return;
      openPeriodRecap(start, end, label || "حصاد الفترة");
      return;
    }
    if (button.dataset.action === "share-period" || button.dataset.action === "print-period") {
      const { start, end, label } = button.dataset;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? "") || start > end) return;
      const report = periodReport(start, end, label || "حصاد الفترة");
      if (button.dataset.action === "share-period") void shareTextReport(report);
      else printStructuredReport(report.title, report.period, report.summary, report.sections);
      return;
    }
    if (button.dataset.action === "save-wake-time") {
      const input = sleepDialog?.querySelector("[data-wake-time]");
      const time = input?.value || currentTimeValue();
      if (clockMinutes(time) === null) {
        showToast("أدخل وقت استيقاظ صحيحًا أولاً.", { isError: true });
        return;
      }
      if (await saveSleepLogWithFeedback(mapDate, { wakeTime: time }, `سُجّل استيقاظك عند ${timeLabel(time)} وبدأ يومك الشخصي من ذلك الوقت.`)) {
        button.textContent = "تحديث وقت الاستيقاظ";
        finishSleepEntrySave(mapDate, ".space-sleep-card");
      }
      return;
    }
    if (button.dataset.action === "save-previous-bedtime") {
      const time = sleepDialog?.querySelector("[data-previous-bedtime]")?.value;
      if (clockMinutes(time) === null) {
        showToast("أدخل وقت نوم الليلة السابقة صحيحًا أولاً.", { isError: true });
        return;
      }
      const previousDate = dateOffset(mapDate, -1);
      if (await saveSleepLogWithFeedback(previousDate, { bedTime: time }, `سُجّل نوم الليلة السابقة عند ${timeLabel(time)}.`)) {
        button.textContent = "تحديث وقت النوم";
        finishSleepEntrySave(mapDate, ".space-sleep-card");
      }
      return;
    }
    if (button.dataset.action === "save-nap") {
      const start = sleepDialog?.querySelector("[data-nap-start]")?.value;
      const duration = Number(sleepDialog?.querySelector("[data-nap-duration]")?.value);
      if (clockMinutes(start) === null || !Number.isInteger(duration) || duration < 1 || duration > 240) {
        showToast("أدخل وقت بداية القيلولة ومدتها بين دقيقة و٢٤٠ دقيقة.", { isError: true });
        return;
      }
      if (await saveSleepLogWithFeedback(mapDate, { napStart: start, napDurationMin: duration, napSkipped: false }, `سُجّلت قيلولتك: ${formatSleepDuration(duration)}.`)) {
        button.textContent = "تحديث القيلولة";
        finishSleepEntrySave(mapDate, ".space-sleep-card");
      }
      return;
    }
    if (button.dataset.action === "skip-nap") {
      if (await saveSleepLogWithFeedback(mapDate, { napStart: null, napDurationMin: 0, napSkipped: true }, "سُجّل أنك لم تأخذ قيلولة اليوم.")) {
        finishSleepEntrySave(mapDate, ".space-sleep-card");
      }
      return;
    }
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
        const completing = task.status !== "done";
        const completionDetails = task.status === "done"
          ? null
          : await requestCompletionDetails({ title: task.title });
        if (task.status !== "done" && !completionDetails) return;
        await toggleTask(task, completionDetails);
        if (completing) {
          animateMapCompletion(mapNodeSelector(".space-node-task", "data-task-id", task.id));
        }
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
        const needsCompletionDetails = nextComplete && !/الضحى|أذكار الصباح|أذكار المساء/.test(habit.title ?? "");
        const details = needsCompletionDetails
          ? await requestCompletionDetails({ title: habit.title, date: today })
          : null;
        if (needsCompletionDetails && !details) return;
        let next = setDayComplete(habit, today, nextComplete);
        if (details) next = setCompletionDetails(next, today, details);
        await update("habits", next);
        if (nextComplete) {
          animateMapCompletion(mapNodeSelector(".space-node-habit", "data-habit-id", habit.id));
        }
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
        if (!wasComplete && value >= progress.total) {
          animateMapCompletion(mapNodeSelector(".space-node-habit", "data-habit-id", habit.id));
        }
      } else if (button.dataset.action === "toggle-prayer") {
        const logged = new Set(habit.itemLog?.[today] ?? []);
        const wasLogged = logged.has(button.dataset.itemId);
        if (wasLogged) logged.delete(button.dataset.itemId);
        else logged.add(button.dataset.itemId);
        let next = setItemsLogged(habit, today, [...logged]);
        const becameComplete = !wasLogged;
        if (!wasLogged && dayProgress(next, today).complete) {
          const details = await requestCompletionDetails({ title: habit.title, date: today });
          if (!details) return;
          next = setCompletionDetails(next, today, details);
        }
        await update("habits", next);
        if (becameComplete) {
          const nightItem = button.matches(".space-night-prayer");
          const cardSelector = nightItem ? ".space-night-prayer" : ".space-node-habit";
          animateMapCompletion(`${mapNodeSelector(cardSelector, "data-habit-id", habit.id)}[data-item-id="${CSS.escape(button.dataset.itemId)}"]`);
        }
      }
    } catch (error) {
      console.error("تعذّر تحديث العادة من خارطة اليوم:", error);
      showToast(error.message || "تعذّر تحديث العادة. حاول مجدداً.", { isError: true });
    }
  }, { signal });

  app.addEventListener("input", (event) => {
    const nameInput = event.target.closest("[data-story-name]");
    if (!nameInput) return;
    const dialog = nameInput.closest("#space-day-story-dialog");
    const story = currentDayStory(dialog);
    activeStoryEvents = story.events;
    dialog.querySelectorAll("[data-story-index]").forEach((button, index) => {
      button.querySelector("strong").textContent = story.events[index].title;
    });
    updateDayStoryPosition(dialog, activeStoryIndex);
  }, { signal });

  app.addEventListener("input", (event) => {
    const seek = event.target.closest("[data-story-seek]");
    if (seek) updateDayStoryPosition(seek.closest("#space-day-story-dialog"), Number(seek.value));
  }, { signal });

  app.addEventListener("keydown", (event) => {
    const card = event.target.closest("[data-card-action]");
    if (!card || event.target !== card || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    card.click();
  }, { signal });

  app.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-prayer-log-form]");
    if (!form) return;
    event.preventDefault();
    const habit = records.habits.find((item) => item.id === form.dataset.habitId);
    if (!habit) {
      showToast("تعذّر العثور على عادة الصلاة. حدّث الصفحة وحاول مجدداً.", { isError: true });
      return;
    }
    const date = form.dataset.date;
    const items = prayerItemsFor(habit, form.dataset.prayer);
    const selected = new Set([...form.querySelectorAll('input[name="item-id"]:checked')].map((input) => input.value));
    const logged = new Set(habit.itemLog?.[date] ?? []);
    for (const item of items) {
      if (selected.has(item.id)) logged.add(item.id);
      else logged.delete(item.id);
    }
    try {
      const next = setItemsLogged(habit, date, [...logged]);
      const prayerItems = items.filter((item) => item.category === "فرض");
      const wasComplete = prayerItems.length > 0 && prayerItems.every((item) => (habit.itemLog?.[date] ?? []).includes(item.id));
      const isComplete = prayerItems.length > 0 && prayerItems.every((item) => logged.has(item.id));
      await update("habits", next);
      records.habits = records.habits.map((item) => item.id === next.id ? next : item);
      showToast(`حُفظ تسجيل صلاة ${form.dataset.prayer}.`);
      form.closest("dialog")?.close();
      render();
      if (!wasComplete && isComplete) {
        animateMapCompletion(mapNodeSelector(".space-node-prayer", "data-prayer", form.dataset.prayer));
      }
    } catch (error) {
      console.error("تعذّر حفظ تفاصيل الصلاة:", error);
      showToast(error.message || "تعذّر حفظ تفاصيل الصلاة. حاول مجدداً.", { isError: true });
    }
  }, { signal });

  app.addEventListener("change", (event) => {
    const prayerItem = event.target.closest("[data-prayer-item] input");
    if (prayerItem) {
      const group = prayerItem.closest("[data-prayer-category-group]");
      const inputs = [...group.querySelectorAll("[data-prayer-item] input")];
      const done = inputs.filter((input) => input.checked).length;
      group.querySelector("[data-prayer-count]").textContent =
        `${formatArabicNumber(done)} / ${formatArabicNumber(inputs.length)}`;
      return;
    }
    const subtask = event.target.closest('[data-action="toggle-subtask"]');
    if (subtask) {
      const task = records.tasks.find((item) => item.id === subtask.dataset.taskId);
      if (!task) return;
      const checklist = (task.checklist ?? []).map((item) =>
        typeof item === "string" ? { text: item, done: false } : { ...item });
      const item = checklist[Number(subtask.dataset.index)];
      if (!item) return;
      item.done = subtask.checked;
      const date = subtask.dataset.date || mapDate;
      const completionLog = Array.isArray(item.completionLog) ? item.completionLog : [];
      item.completionLog = [
        ...completionLog.filter((entry) => entry?.date !== date),
        { date, completed: subtask.checked },
      ];
      item.completedAt = subtask.checked && date === localDateString() ? new Date().toISOString() : null;
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
  await ensureDailyRitualHabits();
  if (!isCurrent()) return;
  const storeNames = ["tasks", "habits", "objectives", "keyResults", "lifeAreas", "sessions", "device", "profile"];
  const values = await Promise.all(storeNames.map((name) => getRecords(name)));
  if (!isCurrent()) return;
  const requestedDate = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("date") ?? "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    mapDate = requestedDate;
    mapMode = "day";
    mapParentMode = null;
    saveMapSelection();
  }
  records = Object.fromEntries(storeNames.map((name, index) => [name, values[index]]));
  isMounted = true;
  document.querySelector("#page-title").textContent = "اليوم";
  const app = document.querySelector("#app");
  if (!app) return;
  bindEvents(app);
  render();
  window.clearInterval(clockInterval);
  updateLiveClock();
  clockInterval = window.setInterval(updateLiveClock, 15_000);
  unsubscribe = subscribe((state, change) => {
    if (!change.storeName || storeNames.includes(change.storeName)) {
      records = Object.fromEntries(storeNames.map((name) => [name, state[name] ?? records[name]]));
      if (document.querySelector("#space-sleep-dialog[open], #space-prayer-log-dialog[open], #space-period-recap-dialog[open], #space-day-story-dialog[open]")) return;
      render();
    }
  });
}

export function unmountTodayView() {
  isMounted = false;
  periodDayMetricsCache.clear();
  window.clearInterval(storyPlaybackInterval);
  storyPlaybackInterval = undefined;
  activeStoryEvents = [];
  unsubscribe?.();
  unsubscribe = undefined;
  eventController?.abort();
  eventController = undefined;
  window.clearInterval(clockInterval);
  clockInterval = undefined;
}

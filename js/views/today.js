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
import { formatDuration } from "../utils/task-metrics.js";
import { shareTextReport } from "../export/share.js";
import { printStructuredReport } from "../export/pdf.js";

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
let isMounted = false;
let records = { tasks: [], habits: [], objectives: [], keyResults: [], lifeAreas: [], sessions: [], device: [], profile: [] };
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

function priorityLabel(priority) {
  return ["عاجلة ومهمة", "مهمة", "عاجلة", "عادية"][priority] ?? "عادية";
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
  const prayerEvents = schedule?.times ?? Object.keys(PRAYER_ITEM_NAMES).map((name) => ({ name, time: null }));
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
  const wakeMinute = clockMinutes(wakeTimeFor(today));
  const startMinute = wakeMinute ?? 0;
  const routeEvents = [{
    type: "day-start",
    time: startMinute,
    sortMinute: startMinute,
    priority: -1,
    label: wakeMinute === null ? "بداية اليوم" : "بداية يومك",
  }, ...orderedEvents, {
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
  dialog.showModal();
}

function renderDayStart(date) {
  return `<article class="space-day-start" aria-label="بداية يومك من وقت الاستيقاظ">
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
  const outsidePersonalDay = !isWithinPersonalDay(mapDate, task.dueTime);
  const progressState = `${done ? "is-done" : progress ? "is-partial" : "is-pending"}${outsidePersonalDay ? " is-outside-personal-day" : ""}`;
  const priorityPercent = (4 - priority) * 25;
  const detailsOpen = expandedMapTaskDetails.has(task.id);
  const bedtimeWarning = task.status !== "done" && isHeavyTaskNearBedtime(task, mapDate);
  const meta = [overdue ? "متأخرة" : "", outsidePersonalDay ? "خارج نافذة يومك الشخصي" : "", bedtimeWarning ? "ثقيلة قرب النوم · يُفضّل تقديمها" : "", checklist.length ? `${formatArabicNumber(checklistDone)} / ${formatArabicNumber(checklist.length)} فرعية` : task.estimateMin ? `${formatArabicNumber(task.estimateMin)} د` : ""]
    .filter(Boolean)
    .join(" · ");
  return `<article class="space-node space-node-task priority-${priority} ${progressState}" data-priority-level="${priority}" style="--task-progress:${progress}%;--priority-progress:${priorityPercent}%">
    <span class="space-node-orbit" aria-hidden="true">✦</span>
    <div class="space-node-copy">
      <strong>${escapeHtml(task.title)}</strong>
      ${meta ? `<span class="space-node-meta">${escapeHtml(meta)}</span>` : ""}
      ${bedtimeWarning ? `<span class="space-bedtime-warning">أولوية عالية ضمن آخر ٣ ساعات قبل النوم</span>` : ""}
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
  const outsidePersonalDay = !isWithinPersonalDay(today, habit.dailyTime);
  const progressState = `${progress.complete ? "is-done" : progress.percent ? "is-partial" : "is-pending"}${outsidePersonalDay ? " is-outside-personal-day" : ""}`;
  const unit = habit.unit ? ` ${escapeHtml(habit.unit)}` : "";
  const progressText = progress.mode === "items"
    ? `${formatArabicNumber(progress.done)} / ${formatArabicNumber(progress.target)} بنود`
    : progress.mode === "count"
      ? `${formatArabicNumber(progress.done)} / ${formatArabicNumber(progress.total)}${unit}`
      : "";
  const ritualWisdom = /الضحى/.test(habit.title ?? "")
    ? { text: "ويجزئ من ذلك ركعتان يركعهما من الضحى", source: "مسلم، ٧٢٠" }
    : /أذكار الصباح|أذكار المساء/.test(habit.title ?? "")
      ? { text: "ألا بذكر الله تطمئن القلوب", source: "الرعد، ٢٨" }
      : null;
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
      ${outsidePersonalDay ? `<span class="space-node-meta">خارج نافذة يومك الشخصي</span>` : ""}
      ${ritualWisdom ? `<details class="space-ritual-wisdom"><summary>الفضل والذكر</summary><span>«${escapeHtml(ritualWisdom.text)}» <b>${escapeHtml(ritualWisdom.source)}</b></span></details>` : ""}
      <div class="space-node-progress-row" role="img" aria-label="إنجاز العادة ${formatArabicNumber(progress.percent)} بالمئة">
        <i class="space-node-progress" aria-hidden="true"><b></b></i>
        <strong>${formatArabicNumber(progress.percent)}٪</strong>
      </div>
    </div>
    ${action}
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
  return `<article class="space-node space-node-prayer priority-${priority} ${status}" data-priority-level="${priority}" aria-label="${escapeHtml(prayer.name)}: الفرض ${formatArabicNumber(fardDone)} من ${formatArabicNumber(fardItems.length)}${sunnahItems.length ? `، السنة ${formatArabicNumber(sunnahDone)} من ${formatArabicNumber(sunnahItems.length)}` : ""}">
    <span class="space-node-orbit" aria-hidden="true">☼</span>
    <div class="space-node-copy">
      <strong>${escapeHtml(prayer.name)}</strong>
      ${Number.isFinite(prayer.time) ? `<span class="space-node-meta">${escapeHtml(formatPrayerTime(prayer.time))}</span>` : ""}
      ${items.length ? `<span class="space-node-meta">الفرض ${formatArabicNumber(fardDone)} / ${formatArabicNumber(fardItems.length)}${sunnahItems.length ? ` · السنة ${formatArabicNumber(sunnahDone)} / ${formatArabicNumber(sunnahItems.length)}` : ""}</span>` : ""}
      ${wisdom ? `<details class="space-prayer-wisdom"><summary>حكمة</summary><span>«${escapeHtml(wisdom.text)}» <b>${escapeHtml(wisdom.source)}</b></span></details>` : ""}
    </div>
    <button class="space-node-check space-prayer-open" type="button" data-action="open-prayer-log" data-habit-id="${escapeHtml(habit?.id ?? "")}" data-prayer="${escapeHtml(prayer.name)}" data-date="${escapeHtml(today)}" aria-pressed="${complete}" aria-label="تسجيل صلاة ${escapeHtml(prayer.name)}">${complete ? "✓" : "○"}</button>
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
    const progress = buildScore(dayTasks(event.today), dayHabits(event.today), event.today);
    return `${renderNightNode(event, index)}
      <div class="space-map-stop is-day-close" data-event-kind="day-close" style="--node-index:${index};animation-delay:760ms">
        <span class="space-map-connector" aria-hidden="true"></span>
        <button class="space-night-recap" type="button" data-action="period-recap" data-start="${event.today}" data-end="${event.today}" data-label="حصاد اليوم">
          <span class="space-night-moon" aria-hidden="true">☾</span>
          <span class="space-night-heading"><small>ختام اليوم</small><strong>اطّلع على حصادك</strong></span>
          <span class="space-night-recap-score">${formatArabicNumber(progress.percent)}٪</span>
        </button>
      </div>`;
  }

  const time = event.type === "day-start"
    ? event.time === null ? "" : timeLabel(minuteTime(event.time))
    : event.type === "prayer"
      ? Number.isFinite(event.prayer.time) ? formatPrayerTime(event.prayer.time) : ""
      : timeLabel(event.displayTime ?? event.time);
  const label = event.type === "day-start" ? event.label
    : event.type === "prayer" ? event.prayer.name
      : event.type === "task" ? "مهمة"
        : "عادة";
  const node = event.type === "day-start"
    ? renderDayStart(mapDate)
    : event.type === "task" ? renderTaskNode(event.task)
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
  const stopStatus = event.type === "day-start" ? ""
    : progress >= 1 ? " is-stop-done"
      : progress > 0 ? " is-stop-partial"
        : " is-stop-pending";
  const eventMinute = Number.isFinite(event.sortMinute) ? event.sortMinute : event.time;
  const eventKind = event.type;
  const progressState = progress >= 1 ? "done" : progress > 0 ? "partial" : "pending";
  return `<div class="space-map-stop${index % 2 ? " is-left" : " is-right"}${event.type === "day-start" ? " is-start" : ""}${stopStatus}"${Number.isFinite(eventMinute) ? ` data-event-minute="${eventMinute}"` : ""} data-event-kind="${eventKind}" data-stop-status="${progressState}" style="--node-index:${index};animation-delay:${Math.min(index * 55, 700)}ms">
    ${event.type === "day-start" ? `<span class="space-map-time">${escapeHtml(time || "٠٠:٠٠")} · ${escapeHtml(label)}</span>` : `<span class="space-map-time">${event.displayTime && !event.time ? "مرن · " : ""}${escapeHtml(time || "وقتك")}</span>`}
    <span class="space-map-connector" aria-hidden="true"></span>
    <div class="space-map-event" data-kind="${event.type}" aria-label="${escapeHtml(label)}">${node}</div>
  </div>`;
}

function buildScore(tasks, habits, today) {
  const countedTasks = tasks.filter((task) => isWithinPersonalDay(today, task.dueTime));
  const countedHabits = habits.filter((habit) => isWithinPersonalDay(today, habit.dailyTime));
  const taskDone = countedTasks.filter((task) => task.status === "done").length;
  const taskProgress = countedTasks.reduce((total, task) => total + taskCompletion(task), 0);
  const habitProgress = countedHabits.reduce((total, habit) => total + dayProgress(habit, today).percent / 100, 0);
  const total = countedTasks.length + countedHabits.length;
  return {
    percent: total ? Math.round((taskProgress + habitProgress) / total * 100) : 0,
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
  const { start, end } = mapBounds();
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
    <button class="space-map-recap-action" type="button" data-action="period-recap" data-start="${start}" data-end="${end}" data-label="حصاد ${MAP_MODE_LABELS[mapMode]}">
      <span aria-hidden="true">✦</span> افتح حصاد الفترة وتفاصيلها
    </button>
  </section>`;
}

function taskDatesInRange(task, start, end) {
  const subtaskDates = (Array.isArray(task.checklist) ? task.checklist : []).flatMap((item) =>
    typeof item === "string" ? [] : (item.completionLog ?? []).filter((entry) => entry?.completed).map((entry) => entry.date));
  const completionDates = (task.completionLog ?? []).map((entry) => entry?.completedAt);
  const loggedTimeDates = (task.timeLog ?? []).map((entry) => entry?.date);
  return [task.scheduled, task.due, task.createdAt, task.completedAt, ...completionDates, ...subtaskDates, ...loggedTimeDates]
    .some((value) => {
      const date = datePart(value);
      return date && date >= start && date <= end;
    });
}

function renderPeriodRecap(start, end, label) {
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
  const habitRows = habits.map((habit) => {
    const created = datePart(habit.createdAt);
    const scheduledDates = dates.filter((date) => (!created || date >= created) && scheduledHabit(habit, date));
    const completedDates = scheduledDates.filter((date) => dayProgress(habit, date).complete);
    return { habit, scheduledDates, completedDates };
  }).filter((row) => row.scheduledDates.length);
  const scheduledHabitDays = habitRows.reduce((total, row) => total + row.scheduledDates.length, 0);
  const completedHabitDays = habitRows.reduce((total, row) => total + row.completedDates.length, 0);
  const totalItems = tasks.length + scheduledHabitDays;
  const progress = totalItems ? Math.round((completedTasks + completedHabitDays) / totalItems * 100) : 0;
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
    return `<article class="space-recap-detail"><strong>${escapeHtml(task.title)}</strong><span>${done ? "مكتملة" : taskProgress ? `${formatArabicNumber(taskProgress)}٪ تقدم` : "مفتوحة"}${checklist.length ? ` · ${formatArabicNumber(checklistDone)}/${formatArabicNumber(checklist.length)} فرعية` : ""}</span></article>`;
  }).join("");
  const habitCards = habitRows.map(({ habit, scheduledDates, completedDates }) => {
    const percent = Math.round(completedDates.length / scheduledDates.length * 100);
    return `<article class="space-recap-detail"><strong>${escapeHtml(habit.title)}</strong><span>${formatArabicNumber(completedDates.length)} من ${formatArabicNumber(scheduledDates.length)} يومًا · ${formatArabicNumber(percent)}٪</span></article>`;
  }).join("");
  const personalWin = completedTasks || completedHabitDays
    ? `أنجزت ${formatArabicNumber(completedTasks)} مهمة وحافظت على ${formatArabicNumber(completedHabitDays)} يومًا من العادات. كل خطوة ساهمت في وصولك.`
    : "قد لا يكون اليوم كاملاً، لكن مراجعتك له خطوة مهمة نحو يوم أفضل.";
  return `<div class="space-recap-content">
    <header class="space-recap-heading">
      <div><p>محطتك تستحق الاحتفاء</p><h2>${escapeHtml(label)}</h2><span><bdi dir="ltr">${escapeHtml(start)} — ${escapeHtml(end)}</bdi></span></div>
      <button class="icon-button" type="button" data-action="close-recap" aria-label="إغلاق">×</button>
    </header>
    <section class="space-recap-hero">
      <div class="space-recap-progress" style="--recap-progress:${progress}%"><strong>${formatArabicNumber(progress)}<small>٪</small></strong><span>إنجاز الفترة</span></div>
      <div class="space-recap-stats">
        <article><span>مهام مكتملة</span><strong>${formatArabicNumber(completedTasks)}</strong><small>من ${formatArabicNumber(tasks.length)} مهمة</small></article>
        <article><span>أيام عادات مكتملة</span><strong>${formatArabicNumber(completedHabitDays)}</strong><small>من ${formatArabicNumber(scheduledHabitDays)} يومًا مجدولًا</small></article>
        <article><span>أهداف ضمن رحلتك</span><strong>${formatArabicNumber(objectives.length)}</strong><small>${formatArabicNumber(objectives.filter((objective) => objective.status === "done").length)} مكتملة</small></article>
      </div>
    </section>
    <section class="space-recap-time">
      <article><span>مدد الإنجاز المسجّلة</span><strong>${formatDuration(completionMinutes)}</strong></article>
      <article><span>جلسات التركيز</span><strong>${formatDuration(focusMinutes)}</strong><small>${formatArabicNumber(focusSessions.length)} جلسة</small></article>
      <article><span>وقت العمل اليدوي</span><strong>${formatDuration(taskManualMinutes)}</strong></article>
    </section>
    ${areaCards ? `<section class="space-recap-section"><h3>مجالات شاركت فيها</h3><div class="space-recap-area-grid">${areaCards}</div></section>` : ""}
    ${objectiveCards ? `<section class="space-recap-section"><h3>أهدافك ونتائجك</h3><div class="space-recap-list">${objectiveCards}</div></section>` : ""}
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

function openPeriodRecap(start, end, label) {
  const dialog = document.querySelector("#space-period-recap-dialog");
  if (!dialog) return;
  dialog.innerHTML = renderPeriodRecap(start, end, label);
  dialog.showModal();
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
  </section>
  <dialog class="space-period-recap-dialog" id="space-period-recap-dialog" aria-label="حصاد الفترة"></dialog>
  <dialog class="space-prayer-log-dialog" id="space-prayer-log-dialog" aria-label="تسجيل الصلاة"></dialog>
  <dialog class="space-sleep-dialog" id="space-sleep-dialog" aria-label="تفاصيل النوم والقيلولة"></dialog>`;
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
    const button = event.target.closest("[data-action]");
    if (!button) return;
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
      await saveSleepLogWithFeedback(mapDate, { wakeTime: time }, `سُجّل استيقاظك عند ${timeLabel(time)} وبدأ يومك الشخصي من ذلك الوقت.`);
      return;
    }
    if (button.dataset.action === "save-previous-bedtime") {
      const time = sleepDialog?.querySelector("[data-previous-bedtime]")?.value;
      if (clockMinutes(time) === null) {
        showToast("أدخل وقت نوم الليلة السابقة صحيحًا أولاً.", { isError: true });
        return;
      }
      const previousDate = dateOffset(mapDate, -1);
      await saveSleepLogWithFeedback(previousDate, { bedTime: time }, `سُجّل نوم الليلة السابقة عند ${timeLabel(time)}.`);
      return;
    }
    if (button.dataset.action === "save-nap") {
      const start = sleepDialog?.querySelector("[data-nap-start]")?.value;
      const duration = Number(sleepDialog?.querySelector("[data-nap-duration]")?.value);
      if (clockMinutes(start) === null || !Number.isInteger(duration) || duration < 1 || duration > 240) {
        showToast("أدخل وقت بداية القيلولة ومدتها بين دقيقة و٢٤٠ دقيقة.", { isError: true });
        return;
      }
      await saveSleepLogWithFeedback(mapDate, { napStart: start, napDurationMin: duration }, `سُجّلت قيلولتك: ${formatSleepDuration(duration)}.`);
      return;
    }
    if (button.dataset.action === "skip-nap") {
      await saveSleepLogWithFeedback(mapDate, { napStart: null, napDurationMin: 0 }, "سُجّل أنك لم تأخذ قيلولة اليوم.");
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
        const needsCompletionDetails = nextComplete && !/الضحى|أذكار الصباح|أذكار المساء/.test(habit.title ?? "");
        const details = needsCompletionDetails
          ? await requestCompletionDetails({ title: habit.title, date: today })
          : null;
        if (needsCompletionDetails && !details) return;
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
      await update("habits", next);
      showToast(`حُفظ تسجيل صلاة ${form.dataset.prayer}.`);
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
  window.clearInterval(clockInterval);
  clockInterval = undefined;
}

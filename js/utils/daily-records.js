import { localDateString } from "./dates.js";

const MONTH_NAMES = Array.from({ length: 12 }, (_item, index) =>
  new Intl.DateTimeFormat("ar", { month: "long" }).format(new Date(2026, index, 1)));

function dateOnly(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : localDateString(date);
}

function taskActiveOn(task, date) {
  if (task.status === "done") return false;
  const start = dateOnly(task.scheduled || task.due);
  if (!start) return false;
  const due = dateOnly(task.due);
  if (due) return date >= (start < due ? start : due) && date <= (start > due ? start : due);
  return date >= start && date <= localDateString();
}

function scheduledHabit(habit, date) {
  const createdDate = dateOnly(habit.createdAt);
  if (createdDate && date < createdDate) return false;
  const days = habit.schedule === "weekdays" ? [1, 2, 3, 4, 5]
    : habit.schedule === "weekends" ? [0, 6]
      : Array.isArray(habit.schedule) ? habit.schedule.map(Number)
        : [0, 1, 2, 3, 4, 5, 6];
  return days.includes(new Date(`${date}T12:00:00`).getDay());
}

function habitCompleteOn(habit, date) {
  const historyDone = Array.isArray(habit.history)
    ? habit.history.includes(date)
    : Boolean(habit.history?.[date]);
  if (historyDone) return true;
  if (habit.mode === "count") {
    return (Number(habit.progress?.[date]) || 0) >= Math.max(1, Number(habit.targetPerDay) || 1);
  }
  if (habit.mode === "items") {
    const items = habit.items ?? [];
    const required = /صلاة|الصلوات/.test(habit.title ?? "")
      ? items.filter((item) => item.category === "فرض")
      : items;
    const target = /صلاة|الصلوات/.test(habit.title ?? "") || habit.requireAllItems
      ? required.length
      : Math.max(1, Number(habit.targetItemsPerDay) || items.length);
    return target > 0 && (habit.itemLog?.[date] ?? []).filter((id) =>
      required.some((item) => item.id === id)).length >= target;
  }
  return false;
}

function dayProgress(records, date, view) {
  if (view === "habits") {
    const habits = (records.habits ?? []).filter((habit) =>
      (!habit.archived && scheduledHabit(habit, date)) || habitCompleteOn(habit, date));
    const completed = habits.filter((habit) => habitCompleteOn(habit, date)).length;
    return { total: habits.length, completed };
  }
  const tasks = (records.tasks ?? []).filter((task) =>
    task.status === "done"
      ? dateOnly(task.completedAt) === date
      : taskActiveOn(task, date));
  const completed = tasks.filter((task) => task.status === "done").length;
  return { total: tasks.length, completed };
}

function completionClass({ total, completed }) {
  if (!total) return "record-level-empty";
  if (completed >= total) return "record-level-complete";
  const ratio = completed / total;
  if (ratio === 0) return "record-level-none";
  if (ratio < 0.4) return "record-level-low";
  if (ratio < 0.75) return "record-level-mid";
  return "record-level-high";
}

function renderCalendar(records, state) {
  const { month, year, view } = state;
  const daysCount = new Date(year, month, 0).getDate();
  const offset = new Date(year, month - 1, 1).getDay();
  const dates = Array.from({ length: daysCount }, (_item, index) =>
    `${year}-${String(month).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`);
  return `<div class="daily-record-calendar" aria-label="أيام الشهر">
    ${["ح", "ن", "ث", "ر", "خ", "ج", "س"].map((day) => `<span class="daily-record-weekday">${day}</span>`).join("")}
    ${Array.from({ length: offset }, () => `<span class="daily-record-day-spacer" aria-hidden="true"></span>`).join("")}
    ${dates.map((date) => {
      const progress = dayProgress(records, date, view);
      return `<button class="daily-record-day ${completionClass(progress)}" type="button" data-record-date="${date}" aria-label="${date}" title="${date}">
        <strong>${Number(date.slice(-2))}</strong>
      </button>`;
    }).join("")}
  </div>`;
}

function renderRecordContent(dialog, records, state) {
  const content = dialog.querySelector("[data-record-content]");
  if (!content) return;
  content.innerHTML = `<div class="daily-record-controls">
      <label>الشهر<select data-record-month>${MONTH_NAMES.map((name, index) =>
        `<option value="${index + 1}"${state.month === index + 1 ? " selected" : ""}>${name}</option>`).join("")}</select></label>
      <label>السنة<input type="number" data-record-year min="2000" max="${new Date().getFullYear()}" value="${state.year}"></label>
    </div>
    ${renderCalendar(records, state)}
    <div class="daily-record-legend" aria-label="مفتاح ألوان الإنجاز">
      <span><i class="record-level-empty"></i> بلا نشاط</span>
      <span><i class="record-level-none"></i> بلا إنجاز</span>
      <span><i class="record-level-low"></i> إنجاز بسيط</span>
      <span><i class="record-level-mid"></i> إنجاز متوسط</span>
      <span><i class="record-level-high"></i> إنجاز متقدم</span>
      <span><i class="record-level-complete"></i> مكتمل</span>
    </div>`;
}

export function dailyRecordButtonMarkup() {
  return `<button class="button button-secondary daily-record-open" type="button" data-action="open-daily-records">السجل اليومي</button>`;
}

export function dailyRecordDialogMarkup(view, initialDate) {
  const recordType = view === "habits" ? "العادات" : "المهام";
  return `<dialog class="daily-record-dialog" id="daily-record-dialog" data-initial-date="${initialDate}">
      <header><div><p>محطات إنجازك</p><h2>سجل ${recordType}</h2></div><button class="icon-button" type="button" data-action="close-daily-records" aria-label="إغلاق">×</button></header>
      <div data-record-content></div>
    </dialog>`;
}

export function bindDailyRecordDialog(app, getRecords, signal, view) {
  const dialog = app.querySelector("#daily-record-dialog");
  if (!dialog) return;
  const now = new Date();
  const initialDate = /^\d{4}-\d{2}-\d{2}$/.test(dialog.dataset.initialDate ?? "")
    ? new Date(`${dialog.dataset.initialDate}T12:00:00`)
    : now;
  const state = { month: initialDate.getMonth() + 1, year: initialDate.getFullYear(), view };
  const refresh = () => renderRecordContent(dialog, getRecords(), state);
  refresh();

  app.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action], [data-record-date]");
    if (!button) return;
    if (button.dataset.action === "open-daily-records") {
      dialog.showModal();
      refresh();
    } else if (button.dataset.action === "close-daily-records") {
      dialog.close();
    } else if (button.dataset.recordDate) {
      dialog.close();
      const route = view === "habits" ? "#/habits" : "#/tasks";
      window.location.hash = `${route}?date=${encodeURIComponent(button.dataset.recordDate)}`;
    }
  }, { signal });

  app.addEventListener("change", (event) => {
    const monthPicker = event.target.closest("[data-record-month]");
    const yearPicker = event.target.closest("[data-record-year]");
    if (monthPicker) state.month = Number(monthPicker.value);
    if (yearPicker && Number.isInteger(Number(yearPicker.value))) {
      state.year = Math.max(2000, Math.min(new Date().getFullYear(), Number(yearPicker.value)));
    }
    if (monthPicker || yearPicker) refresh();
  }, { signal });
}

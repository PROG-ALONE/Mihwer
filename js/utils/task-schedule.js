import { localDateString } from "./dates.js";

function dateOnly(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : localDateString(date);
}

function taskDateRange(task) {
  const scheduled = dateOnly(task.scheduled);
  const due = dateOnly(task.due);
  if (!scheduled && !due) return null;
  const first = scheduled || due;
  const last = due || scheduled;
  return first <= last ? { start: first, end: last } : { start: last, end: first };
}

export function isTaskScheduledOn(task, date, includePeriod = false) {
  const scheduled = dateOnly(task.scheduled);
  const due = dateOnly(task.due);
  if (includePeriod && task.spreadAcrossPeriod) {
    const range = taskDateRange(task);
    if (range && date >= range.start && date <= range.end) return true;
  }
  return scheduled === date || due === date;
}

export function isTaskScheduledInRange(task, start, end, includePeriod = false) {
  const scheduled = dateOnly(task.scheduled);
  const due = dateOnly(task.due);
  if (includePeriod && task.spreadAcrossPeriod) {
    const range = taskDateRange(task);
    if (range && range.start <= end && range.end >= start) return true;
  }
  return [scheduled, due].some((date) => date && date >= start && date <= end);
}

export function isTaskCountedOn(task, date) {
  if (task.spreadAcrossPeriod) {
    const range = taskDateRange(task);
    if (range) return range.end === date;
  }
  return isTaskScheduledOn(task, date);
}

export function isTaskCountedInRange(task, start, end) {
  if (task.spreadAcrossPeriod) {
    const range = taskDateRange(task);
    if (range) return range.end >= start && range.end <= end;
  }
  return isTaskScheduledInRange(task, start, end);
}

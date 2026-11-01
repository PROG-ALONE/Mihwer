import { localDateString } from "./dates.js";

export const RECURRENCE_OPTIONS = [
  { value: "", label: "بدون تكرار" },
  { value: "daily", label: "يومياً" },
  { value: "weekly", label: "أسبوعياً" },
  { value: "monthly", label: "شهرياً" },
];

export function nextOccurrence(dateString, recurrence) {
  const date = dateString ? new Date(`${dateString}T12:00:00`) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error("تاريخ التكرار غير صالح.");
  if (recurrence === "daily") date.setDate(date.getDate() + 1);
  else if (recurrence === "weekly") date.setDate(date.getDate() + 7);
  else if (recurrence === "monthly") {
    const originalDay = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + 1);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(originalDay, lastDay));
  } else {
    throw new Error(`وتيرة تكرار غير مدعومة: ${recurrence}`);
  }
  return localDateString(date);
}

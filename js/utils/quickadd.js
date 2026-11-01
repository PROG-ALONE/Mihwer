import { parseNaturalDate } from "./dates.js";

const PRIORITIES = {
  1: { important: true, urgent: true },
  2: { important: true, urgent: false },
  3: { important: false, urgent: true },
  4: { important: false, urgent: false },
};

export function parseQuickAdd(input, now = new Date()) {
  let title = input.trim();
  if (!title) return null;

  const task = {
    title,
    scheduled: null,
    due: null,
    important: false,
    urgent: false,
    estimateMin: null,
    tags: [],
    projectName: null,
    referenceName: null,
    recurrence: null,
  };

  const date = parseNaturalDate(title, now);
  if (date) {
    task.scheduled = date.date;
    task.due = date.date;
    title = title.replace(date.token, " ");
  }

  title = title.replace(/(?:^|\s)!(1|2|3|4)(?=$|\s)/, (_match, priority) => {
    Object.assign(task, PRIORITIES[priority]);
    return " ";
  });
  if (/(?:^|\s)عاجل(?=$|\s)/.test(title)) {
    task.urgent = true;
    title = title.replace(/(?:^|\s)عاجل(?=$|\s)/, " ");
  }
  if (/(?:^|\s)مهم(?=$|\s)/.test(title)) {
    task.important = true;
    title = title.replace(/(?:^|\s)مهم(?=$|\s)/, " ");
  }

  title = title.replace(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu, (_match, tag) => {
    task.tags.push(tag);
    return " ";
  });

  title = title.replace(/(?:^|\s)~(\d+(?:\.\d+)?)(د|دقيقة|دقائق|س|ساعة|ساعات)(?=$|\s)/, (_match, amount, unit) => {
    task.estimateMin = Math.round(Number(amount) * (unit.startsWith("س") ? 60 : 1));
    return " ";
  });

  title = title.replace(/(?:^|\s)(يوميًا|يوميا|يومياً|كل\s*يوم|أسبوعيًا|أسبوعيا|أسبوعياً|اسبوعيا|اسبوعياً|كل\s*أسبوع|كل\s*اسبوع|شهريًا|شهريا|شهرياً|كل\s*شهر)(?=$|\s)/, (match) => {
    if (/يوميًا|يوميا|يومياً|كل\s*يوم/.test(match)) task.recurrence = "daily";
    else if (/أسبوعيًا|أسبوعيا|أسبوعياً|اسبوعيا|اسبوعياً|كل\s*أسبوع|كل\s*اسبوع/.test(match)) task.recurrence = "weekly";
    else task.recurrence = "monthly";
    return " ";
  });

  title = title.replace(/(?:^|\s)@([\p{L}\p{N}_-]+)/u, (_match, reference) => {
    task.referenceName = reference;
    return " ";
  }).replace(/\s+/g, " ").trim();
  if (!title) return null;
  task.title = title;
  return task;
}

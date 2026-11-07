function validMinutes(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
}

export function completedSubtasksOn(tasks, date) {
  return tasks.flatMap((task) => (Array.isArray(task.checklist) ? task.checklist : []).flatMap((item) => {
    if (!item || typeof item === "string") return [];
    const completed = (Array.isArray(item.completionLog) ? item.completionLog : []).some((entry) =>
      entry?.date === date && entry.completed === true);
    return completed ? [{ task, item }] : [];
  }));
}

export function completedSubtaskCount(tasks, start, end = start) {
  let count = 0;
  for (const task of tasks) {
    for (const item of Array.isArray(task.checklist) ? task.checklist : []) {
      if (typeof item === "string") continue;
      count += (Array.isArray(item.completionLog) ? item.completionLog : []).filter((entry) =>
        entry?.completed === true && entry.date >= start && entry.date <= end).length;
    }
  }
  return count;
}

export function manualTaskMinutes(tasks, start, end) {
  return tasks.reduce((total, task) => total + (Array.isArray(task.timeLog) ? task.timeLog : []).reduce((minutes, entry) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry?.date ?? "") || entry.date < start || entry.date > end) return minutes;
    return minutes + validMinutes(entry.minutes);
  }, 0), 0);
}

export function totalRecordedTaskMinutes(task) {
  const focusMinutes = validMinutes(task.timeSpentMin);
  const manualMinutes = (Array.isArray(task.timeLog) ? task.timeLog : []).reduce((sum, entry) => sum + validMinutes(entry?.minutes), 0);
  return focusMinutes + manualMinutes;
}

export function formatDuration(value) {
  const minutes = Math.round(validMinutes(value));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const number = (amount) => String(amount).replace(/\d/g, (digit) => "٠١٢٣٤٥٦٧٨٩"[Number(digit)]);
  if (!hours) return `${number(remainder)} د`;
  return remainder ? `${number(hours)} س ${number(remainder)} د` : `${number(hours)} س`;
}

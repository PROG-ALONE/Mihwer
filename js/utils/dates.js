const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = new Map([
  ["الأحد", 0], ["الاحد", 0], ["حد", 0],
  ["الاثنين", 1], ["الإثنين", 1], ["اثنين", 1],
  ["الثلاثاء", 2], ["ثلاثاء", 2],
  ["الأربعاء", 3], ["الاربعاء", 3], ["أربعاء", 3],
  ["الخميس", 4], ["خميس", 4],
  ["الجمعة", 5], ["جمعة", 5],
  ["السبت", 6], ["سبت", 6],
]);

export function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseNaturalDate(text, now = new Date()) {
  const source = text.trim();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (/اليوم/.test(source)) return { date: localDateString(today), token: "اليوم" };
  if (/بعد\s*غد/.test(source)) {
    const date = new Date(today.getTime() + DAY_MS * 2);
    return { date: localDateString(date), token: source.match(/بعد\s*غد/)[0] };
  }
  if (/غدًا|غدا|بكرة|بكره/.test(source)) {
    const date = new Date(today.getTime() + DAY_MS);
    return { date: localDateString(date), token: source.match(/غدًا|غدا|بكرة|بكره/)[0] };
  }

  const iso = source.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const [, year, month, day] = iso;
    const candidate = new Date(Number(year), Number(month) - 1, Number(day));
    if (candidate.getFullYear() === Number(year) && candidate.getMonth() === Number(month) - 1 && candidate.getDate() === Number(day)) {
      return { date: localDateString(candidate), token: iso[0] };
    }
  }

  const short = source.match(/(?:^|\s)(\d{1,2})\/(\d{1,2})(?=$|\s)/);
  if (short) {
    const day = Number(short[1]);
    const month = Number(short[2]);
    let year = now.getFullYear();
    let candidate = new Date(year, month - 1, day);
    if (candidate.getMonth() !== month - 1 || candidate.getDate() !== day) return null;
    if (candidate < today) {
      year += 1;
      candidate = new Date(year, month - 1, day);
    }
    return { date: localDateString(candidate), token: short[0].trim() };
  }

  for (const [name, weekday] of WEEKDAYS) {
    const pattern = new RegExp(`(?:^|\\s)${name}(?=$|\\s)`);
    const match = source.match(pattern);
    if (match) {
      const date = new Date(today);
      let offset = (weekday - date.getDay() + 7) % 7;
      if (offset === 0) offset = 7;
      date.setDate(date.getDate() + offset);
      return { date: localDateString(date), token: match[0].trim() };
    }
  }

  return null;
}

export function formatDate(dateString) {
  if (!dateString) return "بلا تاريخ";
  const date = new Date(`${dateString}T12:00:00`);
  if (Number.isNaN(date.getTime())) return dateString;
  return new Intl.DateTimeFormat("ar", { weekday: "long", day: "numeric", month: "short" }).format(date);
}

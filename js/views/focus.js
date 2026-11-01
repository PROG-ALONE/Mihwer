import { add, getRecords, subscribe, update } from "../store.js";
import { showToast } from "../utils/notifications.js";

const DEFAULT_SETTINGS = { focusDurationMin: 25, shortBreakMin: 5, longBreakMin: 15 };

let unsubscribe;
let eventController;
let timerInterval;
let records = { tasks: [], habits: [], sessions: [], profile: [] };
let settings = DEFAULT_SETTINGS;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function activeSession() {
  return records.sessions.find((session) => session.status === "active");
}

function remainingMilliseconds(session, now = Date.now()) {
  const duration = Number(session.plannedDurationMin ?? session.durationMin ?? settings.focusDurationMin) * 60_000;
  const start = new Date(session.start).getTime();
  const pauseMs = Number(session.pausedDurationMs ?? 0);
  const end = session.pausedAt ? new Date(session.pausedAt).getTime() : now;
  return Math.max(0, duration - Math.max(0, end - start - pauseMs));
}

function formatClock(milliseconds) {
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function sessionTask(session) {
  return records.tasks.find((task) => task.id === session.taskId);
}

function sessionHabit(session) {
  return records.habits.find((habit) => habit.id === session.habitId);
}

function sessionTarget(session) {
  return sessionTask(session) ?? sessionHabit(session);
}

function returnRoute(session) {
  if (session?.taskId) return "#/tasks";
  if (session?.habitId) return "#/habits";
  return "#/today";
}

function requestedTarget() {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const taskId = query.get("task");
  if (taskId && records.tasks.some((task) => task.id === taskId)) return { type: "task", id: taskId };
  const habitId = query.get("habit");
  if (habitId && records.habits.some((habit) => habit.id === habitId)) return { type: "habit", id: habitId };
  return null;
}

function renderActive(session) {
  const paused = Boolean(session.pausedAt);
  const target = sessionTarget(session);
  const duration = Number(session.plannedDurationMin ?? session.durationMin ?? settings.focusDurationMin);
  return `<article class="focus-active-card" data-session-id="${escapeHtml(session.id)}">
    <div class="focus-timer-ring" aria-live="off"><span id="focus-countdown">${formatClock(remainingMilliseconds(session))}</span><small>${session.type === "break" ? "استراحة" : "تركيز"}</small></div>
    <p class="focus-kicker">${paused ? "المؤقت متوقف مؤقتاً" : session.type === "break" ? "خذ استراحة قصيرة" : target ? `جلسة مرتبطة بـ ${session.taskId ? "مهمة" : "عادة"}` : "مساحة لمهمة واحدة"}</p>
    <h2>${target ? escapeHtml(target.title) : session.type === "break" ? "استعد للخطوة التالية" : "تركيز حر"}</h2>
    <p class="focus-description">${duration} دقيقة · ${session.interruptions ?? 0} مقاطعات</p>
    <a class="focus-back-link" href="${returnRoute(session)}">العودة إلى ${session.taskId ? "المهام" : session.habitId ? "العادات" : "اليوم"}</a>
    <div class="focus-controls">
      <button class="button button-primary" type="button" data-action="${paused ? "resume" : "pause"}">${paused ? "استئناف" : "إيقاف مؤقت"}</button>
      <button class="button button-secondary" type="button" data-action="interrupt">تسجيل مقاطعة</button>
      <button class="button button-secondary" type="button" data-action="finish">${session.type === "break" ? "إنهاء الاستراحة" : "إنهاء الجلسة"}</button>
    </div>
  </article>`;
}

function render() {
  const app = document.querySelector("#app");
  if (!app) return;
  const active = activeSession();
  const today = new Date().toLocaleDateString("en-CA");
  const sessionsToday = records.sessions.filter((session) => session.start?.slice(0, 10) === today);
  const focusToday = sessionsToday.filter((session) => session.type !== "break" && session.status === "completed");
  const focusMinutes = focusToday.reduce((total, session) => total + Number(session.durationMin ?? 0), 0);
  const doneTasks = records.tasks.filter((task) => task.status === "done");
  const target = requestedTarget();
  const selectedTarget = target ? `${target.type}:${target.id}` : "";
  const targetTask = target?.type === "task" ? records.tasks.find((task) => task.id === target.id) : null;
  const targetHabit = target?.type === "habit" ? records.habits.find((habit) => habit.id === target.id) : null;
  const proposedDuration = Number(targetTask?.estimateMin || targetHabit?.focusDurationMin || settings.focusDurationMin);
  const initialDuration = Number.isInteger(proposedDuration) && proposedDuration >= 1 && proposedDuration <= 180
    ? proposedDuration : settings.focusDurationMin;
  const taskOptions = records.tasks.filter((task) => task.status !== "done")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((task) => `<option value="task:${escapeHtml(task.id)}"${selectedTarget === `task:${task.id}` ? " selected" : ""}>${escapeHtml(task.title)}</option>`).join("");
  const habitOptions = records.habits.filter((habit) => !habit.archived)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((habit) => `<option value="habit:${escapeHtml(habit.id)}"${selectedTarget === `habit:${habit.id}` ? " selected" : ""}>${escapeHtml(habit.title)}</option>`).join("");

  app.innerHTML = `
    <section class="focus-page" aria-label="مؤقت التركيز">
      ${active ? renderActive(active) : `<article class="focus-start-card">
        <div class="focus-start-copy"><p class="focus-kicker">ابدأ بخطوة واحدة</p><h2>وقت هادئ للعمل المركّز</h2><p>سيبقى المؤقت جارياً عند التنقل بين الشاشات، ويُحفظ محلياً على جهازك.</p></div>
        <form id="focus-start-form">
          <label>نوع الجلسة<select name="type"><option value="focus">تركيز</option><option value="break">استراحة قصيرة</option><option value="long-break">استراحة طويلة</option></select></label>
          <label>المدة بالدقائق<input name="duration" type="number" min="1" max="180" value="${initialDuration}" required></label>
          <label>المهمة أو العادة المرتبطة<select name="target"><option value="">تركيز حر</option>${taskOptions ? `<optgroup label="المهام">${taskOptions}</optgroup>` : ""}${habitOptions ? `<optgroup label="العادات">${habitOptions}</optgroup>` : ""}</select></label>
          <button class="button button-focus" type="submit">ابدأ المؤقت</button>
        </form>
      </article>`}
      <div class="focus-stats-grid">
        <article class="today-panel focus-stat"><span>تركيز اليوم</span><strong>${focusMinutes} د</strong></article>
        <article class="today-panel focus-stat"><span>جلسات اليوم</span><strong>${focusToday.length}</strong></article>
        <article class="today-panel focus-stat"><span>مهام أُنجزت</span><strong>${doneTasks.length}</strong></article>
      </div>
      <section class="today-panel focus-history">
        <div class="today-section-heading"><div><p class="today-kicker">مساحاتك الماضية</p><h2>جلسات اليوم</h2></div></div>
        ${sessionsToday.length ? `<div class="focus-session-list">${sessionsToday.sort((a, b) => b.start.localeCompare(a.start)).map((session) => {
          const target = sessionTarget(session);
          const start = new Intl.DateTimeFormat("ar", { hour: "numeric", minute: "2-digit" }).format(new Date(session.start));
          const status = session.status === "completed" ? "مكتملة" : session.status === "active" ? "جارية" : "متوقفة";
          return `<article class="focus-history-row"><span class="focus-session-dot ${session.status === "completed" ? "is-done" : ""}"></span><span class="focus-history-title">${target ? escapeHtml(target.title) : session.type === "break" ? "استراحة" : "تركيز حر"}</span><span>${start}</span><span>${Number(session.durationMin ?? session.plannedDurationMin ?? 0)} د</span><span>${status}</span></article>`;
        }).join("")}</div>` : `<p class="today-empty">لم تبدأ جلسة بعد. اختر مهمة أو امنح نفسك وقتاً للتركيز الحر.</p>`}
      </section>
      <p class="focus-status" role="status" aria-live="polite"></p>
    </section>`;
  bindEvents(app);
  updateCountdown();
}

function setStatus(message, isError = false) {
  showToast(message, { isError });
  const status = document.querySelector(".focus-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = isError ? "error" : "success";
}

async function completeSession(session, manual = false) {
  if (session.status !== "active") return;
  const now = new Date().toISOString();
  const actualDuration = manual
    ? Math.max(1, Math.round((Number(session.plannedDurationMin ?? settings.focusDurationMin) * 60_000 - remainingMilliseconds(session)) / 60_000))
    : Number(session.plannedDurationMin ?? session.durationMin ?? settings.focusDurationMin);
  await update("sessions", {
    ...session,
    end: now,
    durationMin: actualDuration,
    status: "completed",
    pausedAt: null,
    updatedAt: now,
  });
  if (session.type !== "break" && session.taskId) {
    const task = records.tasks.find((item) => item.id === session.taskId);
    if (task) {
      await update("tasks", {
        ...task,
        timeSpentMin: Number(task.timeSpentMin ?? 0) + actualDuration,
        updatedAt: now,
      });
    }
  }
  if (session.type !== "break" && session.habitId) {
    const habit = records.habits.find((item) => item.id === session.habitId);
    if (habit) {
      await update("habits", {
        ...habit,
        focusSpentMin: Number(habit.focusSpentMin ?? 0) + actualDuration,
        updatedAt: now,
      });
    }
  }
}

async function refreshRecords() {
  const [tasks, habits, sessions, profile] = await Promise.all([
    getRecords("tasks"),
    getRecords("habits"),
    getRecords("sessions"),
    getRecords("profile"),
  ]);
  records = { tasks, habits, sessions, profile };
  const userProfile = profile.find((item) => item.id === "user") ?? profile[0];
  settings = {
    ...DEFAULT_SETTINGS,
    ...(userProfile?.focusSettings ?? {}),
  };
}

function updateCountdown() {
  const session = activeSession();
  const display = document.querySelector("#focus-countdown");
  if (!session || !display) return;
  const remaining = remainingMilliseconds(session);
  display.textContent = formatClock(remaining);
  if (!session.pausedAt && remaining <= 0) {
    completeSession(session).catch((error) => {
      console.error("تعذّر إنهاء جلسة التركيز:", error);
      setStatus(error.message, true);
    });
  }
}

function bindEvents(app) {
  eventController?.abort();
  eventController = new AbortController();
  const { signal } = eventController;

  app.addEventListener("change", (event) => {
    const select = event.target.closest('select[name="target"]');
    if (!select) return;
    const [type, id] = select.value.split(":");
    const task = type === "task" ? records.tasks.find((item) => item.id === id) : null;
    const habit = type === "habit" ? records.habits.find((item) => item.id === id) : null;
    const proposed = Number(task?.estimateMin || habit?.focusDurationMin || settings.focusDurationMin);
    app.querySelector("#focus-start-form").elements.duration.value = String(
      Number.isInteger(proposed) && proposed >= 1 && proposed <= 180 ? proposed : settings.focusDurationMin,
    );
  }, { signal });

  app.addEventListener("submit", async (event) => {
    const form = event.target.closest("#focus-start-form");
    if (!form) return;
    event.preventDefault();
    if (activeSession()) {
      setStatus("هناك جلسة نشطة بالفعل.", true);
      return;
    }
    const type = form.elements.type.value;
    const duration = Number(form.elements.duration.value);
    if (!Number.isInteger(duration) || duration < 1 || duration > 180) {
      setStatus("اختر مدة بين دقيقة واحدة و3 ساعات.", true);
      return;
    }
    const now = new Date().toISOString();
    const [targetType, targetId] = form.elements.target.value.split(":");
    const session = {
      id: crypto.randomUUID(),
      taskId: type === "focus" && targetType === "task" ? targetId : null,
      habitId: type === "focus" && targetType === "habit" ? targetId : null,
      type: type === "long-break" ? "break" : type,
      start: now,
      end: null,
      durationMin: duration,
      plannedDurationMin: duration,
      interruptions: 0,
      status: "active",
      pausedAt: null,
      pausedDurationMs: 0,
      createdAt: now,
    };
    try {
      await add("sessions", session);
      setStatus("بدأت الجلسة. أحسنت اختيار وقتك.");
    } catch (error) {
      console.error("تعذّر بدء جلسة التركيز:", error);
      setStatus(error.message, true);
    }
  }, { signal });

  app.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const session = activeSession();
    if (!session) return;
    const now = new Date().toISOString();
    try {
      if (button.dataset.action === "pause") {
        await update("sessions", { ...session, pausedAt: now, updatedAt: now });
      } else if (button.dataset.action === "resume") {
        const pausedMs = Date.now() - new Date(session.pausedAt).getTime();
        await update("sessions", { ...session, pausedAt: null, pausedDurationMs: Number(session.pausedDurationMs ?? 0) + pausedMs, updatedAt: now });
      } else if (button.dataset.action === "interrupt") {
        await update("sessions", { ...session, interruptions: Number(session.interruptions ?? 0) + 1, updatedAt: now });
        setStatus("سُجّلت المقاطعة. خذ وقتك ثم عد بهدوء.");
      } else if (button.dataset.action === "finish") {
        await completeSession(session, true);
        setStatus("انتهت الجلسة وسُجّل وقتها.");
      }
    } catch (error) {
      console.error("تعذّر تحديث جلسة التركيز:", error);
      setStatus(error.message, true);
    }
  }, { signal });
}

export async function mountFocusView(isCurrent = () => true) {
  unsubscribe?.();
  await refreshRecords();
  if (!isCurrent()) return;
  document.querySelector("#page-title").textContent = "جلسة التركيز";
  render();
  clearInterval(timerInterval);
  timerInterval = window.setInterval(updateCountdown, 1000);
  unsubscribe = subscribe(async (_state, change) => {
    if (!change.storeName || ["tasks", "habits", "sessions", "profile"].includes(change.storeName)) {
      try {
        await refreshRecords();
        if (isCurrent() && window.location.hash.startsWith("#/focus")) render();
      } catch (error) {
        console.error("تعذّر تحديث شاشة التركيز:", error);
        setStatus(error.message, true);
      }
    }
  });
}

export function unmountFocusView() {
  unsubscribe?.();
  unsubscribe = undefined;
  eventController?.abort();
  eventController = undefined;
  clearInterval(timerInterval);
  timerInterval = undefined;
}

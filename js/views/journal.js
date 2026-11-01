import { add, getRecords, subscribe, update } from "../store.js";
import { getPlanConfig } from "../utils/plans.js";
import { localDateString } from "../utils/dates.js";
import { showToast } from "../utils/notifications.js";

const WEEKLY_QUESTIONS = [
  ["wins", "ما الذي سار جيداً هذا الأسبوع؟"],
  ["obstacles", "ما الذي واجهك؟ وما الذي تحتاجه لتسهيله؟"],
  ["next", "ما الخطوة الصغيرة التي تود البدء بها؟"],
];

const PERIOD_QUESTIONS = [
  ["achievements", "ما أهم ما أنجزته خلال هذه الفترة؟"],
  ["lessons", "ما الذي تعلّمته عن طريقتك في العمل؟"],
  ["adjustments", "ما الذي يستحق التعديل في الفترة القادمة؟"],
  ["focus", "ما الهدف الذي يستحق تركيزك الآن؟"],
];

const YEAR_QUESTIONS = [
  ["highlights", "ما اللحظات أو الإنجازات التي تود تذكّرها؟"],
  ["growth", "كيف تغيّرت أو نضجت هذا العام؟"],
  ["gratitude", "ما الذي تشعر بالامتنان له؟"],
  ["direction", "ما الاتجاه الذي تريد اتخاذه في العام القادم؟"],
];

let unsubscribe;
let eventController;
let records = { journal: [], reviews: [], tasks: [], habits: [], sessions: [], profile: [] };
let activeDate = localDateString();
let activeTab = "daily";
let plan = getPlanConfig("quarterly");

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function reviewPeriod(type, date = new Date()) {
  const year = date.getFullYear();
  if (type === "weekly") {
    const day = new Date(year, date.getMonth(), date.getDate());
    const weekday = day.getDay();
    day.setDate(day.getDate() - weekday);
    return `${localDateString(day)}_${localDateString(new Date(day.getTime() + 6 * 86_400_000))}`;
  }
  if (type === "annual") return String(year);
  if (plan.id === "monthly") return `${year}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  if (plan.id === "trimester") return `${year}-T${Math.floor(date.getMonth() / 4) + 1}`;
  return `${year}-Q${Math.floor(date.getMonth() / 3) + 1}`;
}

function reviewTypes() {
  const mainType = plan.id === "monthly" ? "monthly" : plan.id === "trimester" ? "trimester" : "quarterly";
  const mainLabel = plan.id === "monthly" ? "مراجعة شهرية" : plan.id === "trimester" ? "مراجعة الفترة (100)" : "مراجعة ربع سنوية";
  const date = new Date();
  return [
    { type: "weekly", label: "مراجعة أسبوعية", questions: WEEKLY_QUESTIONS, period: reviewPeriod("weekly", date) },
    { type: mainType, label: mainLabel, questions: PERIOD_QUESTIONS, period: reviewPeriod(mainType, date) },
    { type: "annual", label: "مراجعة سنوية", questions: YEAR_QUESTIONS, period: reviewPeriod("annual", date) },
  ];
}

function dailySummary(date) {
  const entries = records.journal.find((entry) => entry.date === date);
  const tasks = records.tasks.filter((task) => task.completedAt?.slice(0, 10) === date && task.status === "done");
  const sessions = records.sessions.filter((session) => session.start?.slice(0, 10) === date && session.status === "completed");
  return { entry: entries, completedTasks: tasks.length, focusMinutes: sessions.reduce((sum, session) => sum + Number(session.durationMin ?? 0), 0) };
}

function renderReviewPrompt(review) {
  const existing = records.reviews.find((item) => item.type === review.type && item.period === review.period);
  const answers = existing?.answers ?? {};
  return `<article class="review-prompt-card">
    <div class="review-prompt-heading"><div><p class="today-kicker">${review.type === "weekly" ? "وقفة قصيرة" : review.type === "annual" ? "نظرة واسعة" : "وقفة عميقة"}</p><h3>${review.label}</h3></div><span>${existing ? "محفوظة" : "جاهزة متى شئت"}</span></div>
    <form class="review-form" data-review-type="${review.type}" data-review-period="${review.period}">
      ${review.questions.map(([key, question]) => `<label>${question}<textarea name="${key}" rows="2" maxlength="1200">${escapeHtml(answers[key] ?? "")}</textarea></label>`).join("")}
      <button class="button button-secondary" type="submit">${existing ? "تحديث المراجعة" : "حفظ المراجعة"}</button>
    </form>
  </article>`;
}

function renderTimeline() {
  const entries = [...records.journal].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
  if (!entries.length) return `<p class="today-empty">لا توجد تدوينات سابقة بعد.</p>`;
  return `<div class="journal-timeline">${entries.map((entry) => `
    <button class="journal-timeline-item${entry.date === activeDate ? " is-active" : ""}" type="button" data-date="${entry.date}">
      <span>${escapeHtml(new Intl.DateTimeFormat("ar", { day: "numeric", month: "short" }).format(new Date(`${entry.date}T12:00:00`)))}</span>
      <strong>${entry.mood ? `${["", "☁", "◔", "◑", "◕", "☀"][Number(entry.mood)]}` : "·"}</strong>
      <span>${escapeHtml((entry.text ?? "").slice(0, 56) || "تدوينة قصيرة")}</span>
    </button>`).join("")}</div>`;
}

function render() {
  const app = document.querySelector("#app");
  if (!app) return;
  const { entry, completedTasks, focusMinutes } = dailySummary(activeDate);
  const todayReviewTypes = reviewTypes();
  const lastPeriodReview = [...records.reviews]
    .filter((review) => review.type === todayReviewTypes[1].type)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const dueReview = !lastPeriodReview || lastPeriodReview.period !== todayReviewTypes[1].period;

  app.innerHTML = `
    <section class="journal-page" aria-label="اليوميات والمراجعات">
      <header class="journal-heading"><div><p class="goals-kicker">تأمل بلا أحكام</p><h2>مساحة لك</h2></div><div class="journal-tabs" role="tablist"><button type="button" data-tab="daily" aria-selected="${activeTab === "daily"}">اليوميات</button><button type="button" data-tab="reviews" aria-selected="${activeTab === "reviews"}">المراجعات</button></div></header>
      ${activeTab === "daily" ? `
        <div class="journal-columns">
          <section class="today-panel journal-editor">
            <div class="today-section-heading"><div><p class="today-kicker">تدوينة يومية</p><h2>${escapeHtml(new Intl.DateTimeFormat("ar", { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${activeDate}T12:00:00`)))}</h2></div><input id="journal-date" type="date" value="${activeDate}" aria-label="تاريخ التدوينة"></div>
            <div class="journal-day-summary"><span>${completedTasks} مهام أُنجزت</span><span>${focusMinutes} دقيقة تركيز</span></div>
            <form id="journal-form">
              <label>ما الذي حدث اليوم؟<textarea name="text" rows="6" maxlength="5000" placeholder="اكتب كما أنت…">${escapeHtml(entry?.text ?? "")}</textarea></label>
              <label>ما الذي تشعر بالامتنان له؟<textarea name="gratitude" rows="2" maxlength="1000" placeholder="شيء صغير يكفي…">${escapeHtml(entry?.gratitude ?? "")}</textarea></label>
              <label>أبرز حدث اليوم<input name="highlight" maxlength="300" value="${escapeHtml(entry?.highlight ?? "")}"></label>
              <label>مزاجك اليوم<select name="mood"><option value="">اختر ما يناسبك</option>${["متعب جداً", "متعب", "متوازن", "جيد", "ممتاز"].map((label, index) => `<option value="${index + 1}"${Number(entry?.mood) === index + 1 ? " selected" : ""}>${index + 1} · ${label}</option>`).join("")}</select></label>
              <button class="button button-primary" type="submit">${entry ? "حفظ التعديلات" : "حفظ التدوينة"}</button>
            </form>
          </section>
          <aside class="today-panel journal-history"><h2>أيام سابقة</h2>${renderTimeline()}</aside>
        </div>` : `
        <section class="review-overview">
          <div class="review-reminder${dueReview ? "" : " is-complete"}"><span aria-hidden="true">${dueReview ? "◷" : "✓"}</span><div><strong>${dueReview ? "حان وقت مراجعة الفترة" : "مراجعة الفترة الحالية محفوظة"}</strong><span>${todayReviewTypes[1].label} · ${plan.name} · كل ${plan.id === "monthly" ? 30 : plan.id === "trimester" ? 120 : 90} يوماً تقريباً</span></div></div>
          <p class="today-muted">تُحفظ كل مراجعة مرتبطة بفترتها، ويمكنك تحديث إجاباتها لاحقاً.</p>
          <div class="review-cards">${todayReviewTypes.map(renderReviewPrompt).join("")}</div>
          <section class="today-panel review-history"><h2>المراجعات السابقة</h2>${records.reviews.length ? records.reviews.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map((review) => `<article><strong>${escapeHtml(todayReviewTypes.find((item) => item.type === review.type)?.label ?? review.type)}</strong><span>${escapeHtml(review.period)}</span><time>${escapeHtml(new Intl.DateTimeFormat("ar", { dateStyle: "medium" }).format(new Date(review.createdAt)))}</time></article>`).join("") : `<p class="today-empty">ستظهر مراجعاتك هنا بعد حفظ أول مراجعة.</p>`}</section>
        </section>`}
      <p class="journal-status" role="status" aria-live="polite"></p>
    </section>`;
  bindEvents(app);
}

function setStatus(message, isError = false) {
  showToast(message, { isError });
  const element = document.querySelector(".journal-status");
  if (!element) return;
  element.textContent = message;
  element.dataset.state = isError ? "error" : "success";
}

async function refreshRecords() {
  const names = Object.keys(records);
  const values = await Promise.all(names.map((name) => getRecords(name)));
  records = Object.fromEntries(names.map((name, index) => [name, values[index]]));
  const profile = records.profile.find((item) => item.id === "user") ?? records.profile[0];
  plan = getPlanConfig(profile?.activePlan);
}

function bindEvents(app) {
  eventController?.abort();
  eventController = new AbortController();
  const { signal } = eventController;
  app.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
    activeTab = button.dataset.tab;
    render();
  }, { signal }));

  app.querySelector("#journal-date")?.addEventListener("change", (event) => {
    activeDate = event.currentTarget.value || localDateString();
    render();
  }, { signal });

  app.addEventListener("click", (event) => {
    const button = event.target.closest("[data-date]");
    if (button) {
      activeDate = button.dataset.date;
      activeTab = "daily";
      render();
    }
  }, { signal });

  app.addEventListener("submit", async (event) => {
    const dailyForm = event.target.closest("#journal-form");
    const reviewForm = event.target.closest(".review-form");
    if (!dailyForm && !reviewForm) return;
    event.preventDefault();
    try {
      const now = new Date().toISOString();
      if (dailyForm) {
        const existing = records.journal.find((entry) => entry.date === activeDate);
        const entry = {
          ...(existing ?? {}),
          id: existing?.id ?? crypto.randomUUID(),
          date: activeDate,
          mood: dailyForm.elements.mood.value ? Number(dailyForm.elements.mood.value) : null,
          text: dailyForm.elements.text.value.trim(),
          gratitude: dailyForm.elements.gratitude.value.trim(),
          highlight: dailyForm.elements.highlight.value.trim(),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        if (existing) await update("journal", entry);
        else await add("journal", entry);
        setStatus("حُفظت تدوينتك.");
      } else {
        const type = reviewForm.dataset.reviewType;
        const period = reviewForm.dataset.reviewPeriod;
        const existing = records.reviews.find((review) => review.type === type && review.period === period);
        const answers = Object.fromEntries([...reviewForm.elements]
          .filter((control) => control.name)
          .map((control) => [control.name, control.value.trim()]));
        const review = {
          ...(existing ?? {}),
          id: existing?.id ?? crypto.randomUUID(),
          type,
          period,
          answers,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        if (existing) await update("reviews", review);
        else await add("reviews", review);
        setStatus("حُفظت مراجعتك المرتبطة بالفترة.");
      }
    } catch (error) {
      console.error("تعذّر حفظ اليوميات أو المراجعة:", error);
      setStatus(error.message, true);
    }
  }, { signal });
}

export async function mountJournalView(isCurrent = () => true) {
  unsubscribe?.();
  await refreshRecords();
  if (!isCurrent()) return;
  document.querySelector("#page-title").textContent = "اليوميات والمراجعات";
  render();
  unsubscribe = subscribe(async (_state, change) => {
    if (!change.storeName || Object.hasOwn(records, change.storeName)) {
      try {
        await refreshRecords();
        if (isCurrent() && window.location.hash.startsWith("#/journal")) render();
      } catch (error) {
        console.error("تعذّر تحديث اليوميات:", error);
        setStatus(error.message, true);
      }
    }
  });
}

export function unmountJournalView() {
  unsubscribe?.();
  unsubscribe = undefined;
  eventController?.abort();
  eventController = undefined;
}

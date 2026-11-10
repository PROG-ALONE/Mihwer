import { getRouteFromHash, renderNavigation, renderRoute } from "./router.js";
import { initializeStore } from "./store.js";
import { mountTodayView, unmountTodayView } from "./views/today.js";
import { mountGoalsView, unmountGoalsView } from "./views/goals.js";
import { mountHabitsView, unmountHabitsView } from "./views/habits.js";
import { mountFocusView, unmountFocusView } from "./views/focus.js";
import { mountJournalView, unmountJournalView } from "./views/journal.js";
import { mountReportsView, unmountReportsView } from "./views/reports.js";
import { mountTasksView, unmountTasksView } from "./views/tasks.js?v=118";
import { bindSettingsActions, checkBackupReminder } from "./views/settings.js";
import { showToast } from "./utils/notifications.js";
import { mountPeriodDashboard } from "./views/dashboard.js?v=112";

const app = document.querySelector("#app");
const navigation = document.querySelector("#primary-navigation");
const moreNavigation = document.querySelector("#more-navigation");
const moreDialog = document.querySelector("#more-dialog");
const pageTitle = document.querySelector("#page-title");
const themeToggle = document.querySelector("#theme-toggle");
const themeDialog = document.querySelector("#theme-dialog");
const connectionStatus = document.querySelector("#connection-status");
const themes = {
  midnight: { label: "منتصف الليل", color: "#0c1220" },
  rose: { label: "وردي غباري", color: "#fbf0f3" },
  sage: { label: "أخضر هادئ", color: "#edf4ee" },
  ocean: { label: "أزرق هادئ", color: "#eef5f8" },
  sand: { label: "رملي", color: "#f7f1e8" },
  light: { label: "فاتح واضح", color: "#ffffff" },
};
const legacyThemes = {
  dark: "midnight",
  lavender: "light",
  blossom: "rose",
  lilac: "light",
  sunshine: "sand",
  forest: "sage",
  clarity: "light",
};

let renderSequence = 0;
let mountedRoute;
const animatedCountSelector = "[data-count]";
const LATEST_UPDATE_ID = "task-details-scroll-v140";

function showLatestUpdates() {
  const previousUpdateId = localStorage.getItem("mihwar-seen-update");
  if (previousUpdateId === LATEST_UPDATE_ID) return;
  localStorage.setItem("mihwar-seen-update", LATEST_UPDATE_ID);
  if (!previousUpdateId) return;
  showToast("آخر التحديثات:\n• إصلاح التمرير داخل تفاصيل المهام على الهاتف\n• سجل بصري لأيام الشهر، تتغير ألوانه حسب الإنجاز\n• اختر الشهر والسنة واضغط يوماً لفتح تبويب المهام أو العادات عليه\n• نافذة تعديل أقصر مع إخفاء تفاصيل البنود حتى فتحها", { duration: 8000 });
}

function arabicDigits(value) {
  return String(value).replace(/\d/g, (digit) => "٠١٢٣٤٥٦٧٨٩"[digit]);
}

function animateCardCount(counter) {
  const target = Number(counter.dataset.count);
  if (!Number.isFinite(target) || target < 0) return;
  if (counter._countAnimation || counter.dataset.countAnimated === "true") return;
  counter.dataset.countAnimated = "true";
  const startedAt = performance.now();
  const duration = 520;
  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - ((1 - progress) ** 3);
    counter.textContent = arabicDigits(Math.round(target * eased));
    if (progress < 1) counter._countAnimation = requestAnimationFrame(tick);
  };
  counter.textContent = arabicDigits(0);
  counter._countAnimation = requestAnimationFrame(tick);
}

async function render() {
  const sequence = ++renderSequence;
  const route = getRouteFromHash();
  document.body.classList.toggle("today-route", route.id === "today");
  const taskView = route.id === "tasks"
    && new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("view") === "habits";
  const routeKey = route.id === "tasks" ? `tasks:${taskView ? "habits" : "tasks"}` : route.id;
  if (window.matchMedia("(max-width: 720px)").matches) window.scrollTo(0, 0);
  else document.querySelector("#page-scroll-container")?.scrollTo(0, 0);
  const periodDashboard = document.querySelector("#period-dashboard");
  if (periodDashboard) periodDashboard.hidden = true;
  if (mountedRoute && mountedRoute !== routeKey) {
    if (mountedRoute === "today") unmountTodayView();
    if (mountedRoute === "goals") unmountGoalsView();
    if (mountedRoute === "habits" || mountedRoute === "tasks:habits") unmountHabitsView();
    if (mountedRoute === "focus") unmountFocusView();
    if (mountedRoute === "journal") unmountJournalView();
    if (mountedRoute === "reports") unmountReportsView();
    if (mountedRoute === "tasks" || mountedRoute === "tasks:tasks") unmountTasksView();
    mountedRoute = undefined;
  }
  renderNavigation(navigation, moreNavigation, route);
  renderRoute(route, app, pageTitle);
  if (route.id === "settings") bindSettingsActions();
  if (route.id === "today") {
    await mountTodayView(() => sequence === renderSequence);
    if (sequence === renderSequence) mountedRoute = "today";
  }
  if (route.id === "goals") {
    await mountGoalsView(() => sequence === renderSequence);
    if (sequence === renderSequence) mountedRoute = "goals";
  }
  if (route.id === "habits") {
    await mountHabitsView(() => sequence === renderSequence);
    if (sequence === renderSequence) mountedRoute = "habits";
  }
  if (route.id === "focus") {
    await mountFocusView(() => sequence === renderSequence);
    if (sequence === renderSequence) mountedRoute = "focus";
  }
  if (route.id === "journal") {
    await mountJournalView(() => sequence === renderSequence);
    if (sequence === renderSequence) mountedRoute = "journal";
  }
  if (route.id === "reports") {
    await mountReportsView(() => sequence === renderSequence);
    if (sequence === renderSequence) mountedRoute = "reports";
  }
  if (route.id === "tasks") {
    if (taskView) await mountHabitsView(() => sequence === renderSequence);
    else await mountTasksView(() => sequence === renderSequence);
    if (sequence === renderSequence) mountedRoute = routeKey;
  }
}

function applyTheme(theme) {
  const selectedTheme = Object.hasOwn(themes, theme) ? theme : legacyThemes[theme] ?? "midnight";
  document.documentElement.dataset.theme = selectedTheme;
  themeToggle.setAttribute("aria-label", `اختيار المظهر، الحالي: ${themes[selectedTheme].label}`);
  document.querySelector('meta[name="theme-color"]').content = themes[selectedTheme].color;
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === selectedTheme));
  });
  localStorage.setItem("mihwar-theme", selectedTheme);
}

function updateConnectionStatus() {
  if (!connectionStatus) return;
  const offline = !navigator.onLine;
  connectionStatus.hidden = !offline;
  connectionStatus.dataset.state = offline ? "offline" : "online";
  connectionStatus.querySelector(".connection-status-label").textContent = offline
    ? "تعمل دون اتصال — بياناتك محفوظة هنا"
    : "متصل";
}

const storedTheme = localStorage.getItem("mihwar-theme");
const initialTheme = storedTheme ?? "midnight";
applyTheme(initialTheme);
updateConnectionStatus();
window.addEventListener("online", updateConnectionStatus);
window.addEventListener("offline", updateConnectionStatus);

themeToggle.addEventListener("click", () => themeDialog.showModal());
themeDialog.addEventListener("click", (event) => {
  const choice = event.target.closest("[data-theme-choice]");
  if (choice) {
    applyTheme(choice.dataset.themeChoice);
    themeDialog.close();
    return;
  }
  if (event.target.closest("[data-theme-close]") || event.target === themeDialog) {
    themeDialog.close();
  }
});

navigation.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-open-more]");
  if (!trigger) return;
  moreDialog.showModal();
  trigger.setAttribute("aria-expanded", "true");
});
app.addEventListener("click", (event) => {
  if (!event.target.closest("[data-open-more]")) return;
  moreDialog.showModal();
  navigation.querySelector("[data-open-more]")?.setAttribute("aria-expanded", "true");
});

app.addEventListener("pointerover", (event) => {
  const card = event.target.closest("article, .today-overview, .period-progress-hero");
  if (!card || card.contains(event.relatedTarget)) return;
  card.querySelectorAll(animatedCountSelector).forEach(animateCardCount);
});
moreNavigation.addEventListener("click", (event) => {
  if (event.target.closest("a.nav-link")) closeMoreDialog();
});
moreDialog.addEventListener("click", (event) => {
  if (event.target.closest("[data-more-close]") || event.target === moreDialog) closeMoreDialog();
});
function closeMoreDialog() {
  if (moreDialog.open) moreDialog.close();
  navigation.querySelector("[data-open-more]")?.setAttribute("aria-expanded", "false");
}
moreDialog.addEventListener("close", closeMoreDialog);
moreDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeMoreDialog();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !moreDialog.open) return;
  event.preventDefault();
  closeMoreDialog();
});

window.addEventListener("hashchange", () => {
  closeMoreDialog();
  render();
});
window.addEventListener("mihwar:data-imported", () => window.location.reload());
const onboarding = document.querySelector("#onboarding-dialog");
if (!localStorage.getItem("mihwar-onboarding-complete")) {
  onboarding.showModal();
  onboarding.addEventListener("close", () => {
    localStorage.setItem("mihwar-onboarding-complete", "true");
  }, { once: true });
}
if (!window.location.hash) {
  window.location.hash = "#/today";
} else {
  render();
}

initializeStore()
  .then(() => {
    mountPeriodDashboard();
    checkBackupReminder();
    showLatestUpdates();
  })
  .catch((error) => {
    console.error("تعذّر تهيئة قاعدة البيانات أو لوحة الفترات:", error);
  });

if ("serviceWorker" in navigator && ["https:", "http:"].includes(window.location.protocol)) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.error("تعذّر تسجيل Service Worker:", error);
    });
  });
}

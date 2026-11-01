import { getRouteFromHash, renderNavigation, renderRoute } from "./router.js";
import { initializeStore } from "./store.js";
import { mountTodayView, unmountTodayView } from "./views/today.js";
import { mountGoalsView, unmountGoalsView } from "./views/goals.js";
import { mountHabitsView, unmountHabitsView } from "./views/habits.js";
import { mountFocusView, unmountFocusView } from "./views/focus.js";
import { mountJournalView, unmountJournalView } from "./views/journal.js";
import { mountReportsView, unmountReportsView } from "./views/reports.js";
import { mountTasksView, unmountTasksView } from "./views/tasks.js";
import { bindSettingsActions } from "./views/settings.js";
import { renderHelp } from "./views/help.js";

const app = document.querySelector("#app");
const navigation = document.querySelector("#primary-navigation");
const moreNavigation = document.querySelector("#more-navigation");
const moreDialog = document.querySelector("#more-dialog");
const pageTitle = document.querySelector("#page-title");
const themeToggle = document.querySelector("#theme-toggle");
const themeDialog = document.querySelector("#theme-dialog");
const themes = {
  dark: { label: "ليلي", color: "#11101e" },
  light: { label: "فاتح", color: "#f5f3fc" },
  sage: { label: "نعناعي", color: "#edf4ee" },
  ocean: { label: "بحري", color: "#eef5f8" },
  rose: { label: "وردي", color: "#fbf0f3" },
};

let renderSequence = 0;
let mountedRoute;

async function render() {
  const sequence = ++renderSequence;
  const route = getRouteFromHash();
  if (mountedRoute && mountedRoute !== route.id) {
    if (mountedRoute === "today") unmountTodayView();
    if (mountedRoute === "goals") unmountGoalsView();
    if (mountedRoute === "habits") unmountHabitsView();
    if (mountedRoute === "focus") unmountFocusView();
    if (mountedRoute === "journal") unmountJournalView();
    if (mountedRoute === "reports") unmountReportsView();
    if (mountedRoute === "tasks") unmountTasksView();
    mountedRoute = undefined;
  }
  renderNavigation(navigation, moreNavigation, route);
  renderRoute(route, app, pageTitle);
  if (route.id === "settings") bindSettingsActions();
  if (route.id === "help") renderHelp(app);
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
    await mountTasksView(() => sequence === renderSequence);
    if (sequence === renderSequence) mountedRoute = "tasks";
  }
}

function applyTheme(theme) {
  const selectedTheme = Object.hasOwn(themes, theme) ? theme : "dark";
  document.documentElement.dataset.theme = selectedTheme;
  themeToggle.setAttribute("aria-label", `اختيار المظهر، الحالي: ${themes[selectedTheme].label}`);
  document.querySelector('meta[name="theme-color"]').content = themes[selectedTheme].color;
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === selectedTheme));
  });
  localStorage.setItem("mihwar-theme", selectedTheme);
}

const storedTheme = localStorage.getItem("mihwar-theme");
const initialTheme = storedTheme ?? "dark";
applyTheme(initialTheme);

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

initializeStore().catch((error) => {
  console.error("تعذّر تهيئة قاعدة البيانات:", error);
});

if ("serviceWorker" in navigator && ["https:", "http:"].includes(window.location.protocol)) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.error("تعذّر تسجيل Service Worker:", error);
    });
  });
}

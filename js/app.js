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
const pageTitle = document.querySelector("#page-title");
const themeToggle = document.querySelector("#theme-toggle");

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
  renderNavigation(navigation, route);
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
  document.documentElement.dataset.theme = theme;
  themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
  localStorage.setItem("mihwar-theme", theme);
}

const storedTheme = localStorage.getItem("mihwar-theme");
const initialTheme = storedTheme ?? "dark";
applyTheme(initialTheme);

themeToggle.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

window.addEventListener("hashchange", render);
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

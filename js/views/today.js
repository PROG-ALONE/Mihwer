export async function mountTodayView(isCurrent = () => true) {
  if (!isCurrent()) return;
  document.querySelector("#page-title").textContent = "اليوم";
  const app = document.querySelector("#app");
  if (!app) return;
  app.replaceChildren();
}

export function unmountTodayView() {}

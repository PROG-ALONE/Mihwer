let hideTimer;

export function showToast(message, { isError = false, duration = 3600 } = {}) {
  const toast = document.querySelector("#app-toast");
  if (!toast) return;

  window.clearTimeout(hideTimer);
  toast.querySelector(".app-toast-message").textContent = message;
  toast.dataset.state = isError ? "error" : "success";
  toast.setAttribute("role", isError ? "alert" : "status");
  toast.setAttribute("aria-hidden", "false");
  toast.classList.add("is-visible");
  hideTimer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
    toast.setAttribute("aria-hidden", "true");
  }, duration);
}

document.querySelector("#app-toast-close")?.addEventListener("click", () => {
  window.clearTimeout(hideTimer);
  const toast = document.querySelector("#app-toast");
  toast?.classList.remove("is-visible");
  toast?.setAttribute("aria-hidden", "true");
});

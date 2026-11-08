let dialog;
let pendingResolve;
let completionResult = null;

function localDateTimeValue(value = new Date()) {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function getDialog() {
  if (dialog) return dialog;
  document.body.insertAdjacentHTML("beforeend", `
    <dialog class="completion-dialog" id="completion-dialog" aria-labelledby="completion-dialog-title">
      <form id="completion-dialog-form">
        <div class="completion-dialog-heading">
          <span class="completion-dialog-mark" aria-hidden="true">✓</span>
          <div><p>تسجيل الإنجاز</p><h2 id="completion-dialog-title"></h2></div>
          <button class="icon-button" type="button" data-completion-cancel aria-label="إغلاق">×</button>
        </div>
        <label>متى أنجزتها؟<input name="completedAt" type="datetime-local" required></label>
        <label>كم استغرق إنجازها؟<span class="completion-duration-field"><input name="durationMin" type="number" min="1" max="1440" step="1" inputmode="numeric" required><span>دقيقة</span></span></label>
        <div class="completion-dialog-actions">
          <button class="button button-secondary" type="button" data-completion-cancel>إلغاء</button>
          <button class="button button-primary" type="submit">حفظ الإنجاز</button>
        </div>
      </form>
    </dialog>`);
  dialog = document.querySelector("#completion-dialog");
  const form = dialog.querySelector("#completion-dialog-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const completedAt = new Date(form.elements.completedAt.value);
    const durationMin = Number(form.elements.durationMin.value);
    if (Number.isNaN(completedAt.getTime()) || !Number.isInteger(durationMin) || durationMin < 1 || durationMin > 1440) {
      form.reportValidity();
      return;
    }
    completionResult = { completedAt: completedAt.toISOString(), durationMin };
    dialog.close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target.closest("[data-completion-cancel]")) dialog.close();
  });
  dialog.addEventListener("close", () => {
    const resolve = pendingResolve;
    pendingResolve = undefined;
    if (resolve) resolve(completionResult);
    completionResult = null;
  });
  return dialog;
}

export function requestCompletionDetails({ title, date, durationMin } = {}) {
  if (pendingResolve) {
    return Promise.reject(new Error("أغلق نافذة تسجيل الإنجاز الحالية أولاً."));
  }
  const completionDialog = getDialog();
  const form = completionDialog.querySelector("#completion-dialog-form");
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? date : localDateTimeValue().slice(0, 10);
  const currentDate = localDateTimeValue();
  const completedAtInput = form.elements.completedAt;
  completedAtInput.value = currentDate.slice(0, 10) === targetDate
    ? currentDate
    : `${targetDate}T12:00`;
  if (date === targetDate) {
    completedAtInput.min = `${targetDate}T00:00`;
    completedAtInput.max = `${targetDate}T23:59`;
  } else {
    completedAtInput.removeAttribute("min");
    completedAtInput.removeAttribute("max");
  }
  form.elements.durationMin.value = Number.isInteger(durationMin) && durationMin > 0
    ? String(durationMin)
    : "";
  completionDialog.querySelector("#completion-dialog-title").textContent = title ?? "إنجاز جديد";
  return new Promise((resolve) => {
    pendingResolve = resolve;
    completionDialog.showModal();
    form.elements.durationMin.focus();
  });
}

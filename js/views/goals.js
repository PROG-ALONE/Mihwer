import { add, getRecords, remove, subscribe, update } from "../store.js";
import { getObjectiveProgress, getObjectiveStatus, getKeyResultProgress } from "../utils/okr.js";
import { getObjectivePeriod, getPlanConfig, setObjectivePeriod } from "../utils/plans.js";
import { showToast } from "../utils/notifications.js";

const STATUS_LABELS = {
  "on-track": "يسير",
  "at-risk": "معرّض",
  blocked: "متعطّل",
  done: "مكتمل",
};

const STATUS_OPTIONS = ["on-track", "at-risk", "blocked", "done"];
const DEFAULT_LIFE_AREAS = [
  { id: "mihwar-area-health", name: "الصحة", color: "#16a889" },
  { id: "mihwar-area-work", name: "العمل", color: "#6258d9" },
  { id: "mihwar-area-relationships", name: "العائلة والعلاقات", color: "#c05d7a" },
  { id: "mihwar-area-finances", name: "المال", color: "#d28a36" },
  { id: "mihwar-area-learning", name: "التعلّم", color: "#4d84c4" },
  { id: "mihwar-area-growth", name: "النمو الشخصي", color: "#75854e" },
];

let unsubscribe;
let eventController;
let records = { lifeAreas: [], objectives: [], keyResults: [], tasks: [], projects: [], profile: [] };
let plan = getPlanConfig("quarterly");
let selectedYear = new Date().getFullYear();
let errorMessage = "";
let successMessage = "";
const expandedObjectiveDetails = new Set();

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function objectiveStatus(objective) {
  return getObjectiveStatus(objective, records.keyResults);
}

function areaColor(area) {
  return /^#[0-9a-f]{6}$/i.test(area.color ?? "") ? area.color : "#6258d9";
}

function renderLifeAreas() {
  const areas = records.lifeAreas
    .filter((area) => !area.archived && records.objectives.some((objective) =>
      objective.lifeAreaId === area.id &&
      Number(objective.year) === selectedYear &&
      objective.status !== "archived"))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!areas.length) return `<div class="goals-empty">أضف هدفك الأول واختر المجال المناسب؛ ستظهر أهدافك هنا.</div>`;
  return areas.map((area) => `
    <section class="life-area-row">
      <div class="life-area-heading">
        <span class="life-area-color" style="--area-color:${areaColor(area)}"></span>
        <span class="life-area-name">${escapeHtml(area.name)}</span>
        <span class="life-area-count">الأهداف: ${records.objectives.filter((objective) =>
          objective.lifeAreaId === area.id &&
          Number(objective.year) === selectedYear &&
          objective.status !== "archived").length}</span>
      </div>
      <div class="goal-objectives">
        ${records.objectives
          .filter((objective) =>
            objective.lifeAreaId === area.id &&
            Number(objective.year) === selectedYear &&
            objective.status !== "archived")
          .sort((a, b) => getObjectivePeriod(a, plan) - getObjectivePeriod(b, plan))
          .map(renderObjective)
          .join("") || `<p class="goal-area-empty">لا توجد أهداف في هذا المجال لهذه السنة. أضف هدفك الأول.</p>`}
      </div>
    </section>`).join("");
}

function renderObjective(objective) {
  const keyResults = records.keyResults.filter((result) => result.objectiveId === objective.id);
  const progress = getObjectiveProgress(objective, records.keyResults);
  const status = objectiveStatus(objective);
  const period = plan.columns[getObjectivePeriod(objective, plan) - 1] ?? "";
  const linkedTasks = records.tasks.filter((task) =>
    task.objectiveId === objective.id || keyResults.some((result) => result.id === task.keyResultId));
  return `<details class="objective-card status-${status}" data-objective-id="${escapeHtml(objective.id)}" data-objective-details="${escapeHtml(objective.id)}"${expandedObjectiveDetails.has(objective.id) ? " open" : ""}>
    <summary class="objective-card-summary">
      <div class="objective-card-heading">
        <span class="objective-title-button">${escapeHtml(objective.title)}</span>
        <div class="objective-summary-labels">
          <span class="objective-period">${escapeHtml(period)} · ${escapeHtml(String(objective.year ?? selectedYear))}</span>
          <span class="objective-status status-label-${status}">${STATUS_LABELS[status]}</span>
        </div>
      </div>
      <div class="goal-progress-overview">
        <div class="goal-progress-line" role="progressbar" aria-label="تقدم ${escapeHtml(objective.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
          <span style="width:${progress}%"></span>
        </div>
        <span><strong>${progress}%</strong> منجز</span>
      </div>
      <div class="objective-summary-footer">
        <span>النتائج الرئيسية: ${keyResults.length}</span>
        ${linkedTasks.length ? `<span>${linkedTasks.length} مهام مرتبطة</span>` : ""}
      </div>
    </summary>
    <div class="objective-details-content">
    <div class="objective-details-heading">
      <div><span class="goals-kicker">تفاصيل الهدف</span><strong>النتائج ومؤشرات الإنجاز</strong></div>
      <button class="text-button objective-edit-title" type="button" data-action="edit-objective" data-objective-id="${escapeHtml(objective.id)}">تعديل الهدف</button>
    </div>
    ${objective.description ? `<p class="objective-description">${escapeHtml(objective.description)}</p>` : `<p class="objective-description objective-description-empty">أضف وصفاً يوضّح ما الذي يعنيه تحقيق هذا الهدف.</p>`}
    <div class="objective-results">
      ${keyResults.length ? keyResults.map((result) => {
        const resultProgress = getKeyResultProgress(result);
        return `<div class="key-result-row" data-key-result-id="${escapeHtml(result.id)}">
          <div class="key-result-info">
            <span class="key-result-title">${escapeHtml(result.title)}</span>
            <span class="key-result-values">${escapeHtml(String(result.current ?? 0))} / ${escapeHtml(String(result.target ?? 0))}${result.unit ? ` ${escapeHtml(result.unit)}` : ""}</span>
          </div>
          <div class="key-result-progress" role="progressbar" aria-label="تقدم ${escapeHtml(result.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${resultProgress}">
            <span style="width:${resultProgress}%"></span>
          </div>
          <button class="icon-button key-result-edit" type="button" data-action="edit-key-result" data-key-result-id="${escapeHtml(result.id)}" aria-label="تعديل ${escapeHtml(result.title)}">✎</button>
        </div>`;
      }).join("") : `<p class="objective-results-empty">لم تُضف نتائج رئيسية بعد. أضف نتيجة قابلة للقياس لتتبّع تقدّم الهدف.</p>`}
    </div>
    <div class="objective-card-actions">
      <button class="text-button" type="button" data-action="new-key-result" data-objective-id="${escapeHtml(objective.id)}">+ نتيجة رئيسية</button>
      <label class="visually-hidden" for="status-${escapeHtml(objective.id)}">حالة الهدف</label>
      <select id="status-${escapeHtml(objective.id)}" class="objective-status-select" data-action="set-status" data-objective-id="${escapeHtml(objective.id)}" aria-label="حالة ${escapeHtml(objective.title)}">
        ${STATUS_OPTIONS.map((value) => `<option value="${value}"${objective.status === value || (!objective.status && value === "on-track") ? " selected" : ""}>${STATUS_LABELS[value]}</option>`).join("")}
      </select>
      ${linkedTasks.length ? `<a class="linked-task-count" href="#/tasks">عرض المهام المرتبطة · ${linkedTasks.length}</a>` : ""}
      <button class="icon-button objective-archive" type="button" data-action="archive-objective" data-objective-id="${escapeHtml(objective.id)}" aria-label="أرشفة الهدف">×</button>
    </div>
    </div>
  </details>`;
}

function render() {
  const app = document.querySelector("#app");
  if (!app) return;
  const years = [...new Set([...records.objectives.map((objective) => Number(objective.year)).filter(Number.isFinite), new Date().getFullYear()])]
    .sort((a, b) => a - b);
  const areas = records.lifeAreas.filter((area) => !area.archived);
  const yearObjectives = records.objectives.filter((objective) => Number(objective.year) === selectedYear && objective.status !== "archived");
  const completedObjectives = yearObjectives.filter((objective) => objective.status === "done").length;
  const keyResultCount = records.keyResults.filter((result) => yearObjectives.some((objective) => objective.id === result.objectiveId)).length;
  app.innerHTML = `
    <section class="goals-page" aria-label="الأهداف والنتائج الرئيسية">
      <div class="goals-heading">
        <div><p class="goals-kicker">محور السنة</p><h2>أهدافك</h2><p class="goals-subtitle">${plan.name} · ${plan.columns.length} ${plan.columns.length === 12 ? "شهراً" : "فترات"}</p></div>
        <div class="goals-heading-actions">
          <label class="visually-hidden" for="goals-year">السنة</label>
          <select id="goals-year" aria-label="السنة">${years.map((year) => `<option value="${year}"${year === selectedYear ? " selected" : ""}>${year}</option>`).join("")}</select>
          <button class="button button-primary" type="button" data-action="new-objective">هدف جديد</button>
        </div>
      </div>
      <p class="goals-overview">${yearObjectives.length} هدف · ${yearObjectives.length - completedObjectives} قيد التقدّم · ${completedObjectives} مكتمل · ${keyResultCount} نتيجة رئيسية</p>
      ${areas.length ? `<div class="goal-areas">
        ${renderLifeAreas()}
      </div>` : `<div class="goals-empty-state">${renderLifeAreas()}</div>`}
      <p class="goals-status" role="status" aria-live="polite" data-state="${errorMessage ? "error" : "success"}">${escapeHtml(errorMessage || successMessage)}</p>
      <dialog class="goal-dialog" id="goal-dialog">
        <form id="goal-form">
          <div class="dialog-heading"><h2 id="goal-dialog-title">هدف جديد</h2><button class="icon-button" type="button" data-action="close-dialog" aria-label="إغلاق">×</button></div>
          <input type="hidden" name="id">
          <label>عنوان الهدف<input name="title" required maxlength="200"></label>
          <label>الوصف<textarea name="description" rows="3" maxlength="1000"></textarea></label>
          <div class="goal-dialog-fields">
            <label>مجال الحياة<select name="lifeAreaId" required>${areas.map((area) => `<option value="${escapeHtml(area.id)}">${escapeHtml(area.name)}</option>`).join("")}</select></label>
            <label>فترة الهدف<select name="period">${plan.columns.map((column, index) => `<option value="${index + 1}">${column}</option>`).join("")}</select></label>
            <label>السنة<input name="year" type="number" min="2000" max="2100" value="${selectedYear}" required></label>
            <label>الحالة<select name="status">${STATUS_OPTIONS.map((status) => `<option value="${status}">${STATUS_LABELS[status]}</option>`).join("")}</select></label>
          </div>
          <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-dialog">إلغاء</button><button class="button button-primary" type="submit">حفظ الهدف</button></div>
        </form>
      </dialog>
      <dialog class="goal-dialog" id="key-result-dialog">
        <form id="key-result-form">
          <div class="dialog-heading"><h2 id="key-result-dialog-title">نتيجة رئيسية</h2><button class="icon-button" type="button" data-action="close-dialog" aria-label="إغلاق">×</button></div>
          <input type="hidden" name="id"><input type="hidden" name="objectiveId">
          <label>عنوان النتيجة<input name="title" required maxlength="200"></label>
          <label>وصف المقياس<input name="metric" maxlength="120" placeholder="مثال: عدد المشاريع"></label>
          <div class="goal-dialog-fields">
            <label>البداية<input name="start" type="number" step="any" required></label>
            <label>المستهدف<input name="target" type="number" step="any" required></label>
            <label>الحالي<input name="current" type="number" step="any" required></label>
            <label>الوحدة<input name="unit" maxlength="30" placeholder="مشروع، ساعة…"></label>
          </div>
          <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-dialog">إلغاء</button><button class="button button-primary" type="submit">حفظ النتيجة</button></div>
        </form>
      </dialog>
    </section>`;
  bindEvents(app);
}

function setStatus(message, isError = false) {
  errorMessage = isError ? message : "";
  successMessage = isError ? "" : message;
  showToast(message, { isError });
  const status = document.querySelector(".goals-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = isError ? "error" : "success";
}

async function refreshRecords() {
  const names = Object.keys(records);
  const values = await Promise.all(names.map((name) => getRecords(name)));
  records = Object.fromEntries(names.map((name, index) => [name, values[index]]));
  const profile = records.profile.find((item) => item.id === "user") ?? records.profile[0];
  plan = getPlanConfig(profile?.activePlan);
}

function openObjectiveDialog(objective, areaId, period) {
  const form = document.querySelector("#goal-form");
  const dialog = document.querySelector("#goal-dialog");
  form.reset();
  form.elements.id.value = objective?.id ?? "";
  form.elements.title.value = objective?.title ?? "";
  form.elements.description.value = objective?.description ?? "";
  form.elements.lifeAreaId.value = objective?.lifeAreaId ?? areaId ?? records.lifeAreas.find((area) => !area.archived)?.id ?? "";
  form.elements.period.value = String(objective ? getObjectivePeriod(objective, plan) : period ?? 1);
  form.elements.year.value = objective?.year ?? selectedYear;
  form.elements.status.value = objective?.status ?? "on-track";
  document.querySelector("#goal-dialog-title").textContent = objective ? "تعديل الهدف" : "هدف جديد";
  dialog.showModal();
}

function openKeyResultDialog(objectiveId, keyResult) {
  const form = document.querySelector("#key-result-form");
  form.reset();
  form.elements.id.value = keyResult?.id ?? "";
  form.elements.objectiveId.value = keyResult?.objectiveId ?? objectiveId;
  form.elements.title.value = keyResult?.title ?? "";
  form.elements.metric.value = keyResult?.metric ?? "";
  form.elements.start.value = keyResult?.start ?? 0;
  form.elements.target.value = keyResult?.target ?? 1;
  form.elements.current.value = keyResult?.current ?? keyResult?.start ?? 0;
  form.elements.unit.value = keyResult?.unit ?? "";
  document.querySelector("#key-result-dialog-title").textContent = keyResult ? "تعديل النتيجة الرئيسية" : "إضافة نتيجة رئيسية";
  document.querySelector("#key-result-dialog").showModal();
}

function bindEvents(app) {
  eventController?.abort();
  eventController = new AbortController();
  const { signal } = eventController;
  app.addEventListener("click", (event) => {
    const summary = event.target.closest(".objective-card-summary");
    if (!summary) return;
    const details = summary.parentElement;
    const id = details.dataset.objectiveDetails;
    if (details.open) expandedObjectiveDetails.delete(id);
    else expandedObjectiveDetails.add(id);
  }, { capture: true, signal });

  app.querySelector("#goals-year").addEventListener("change", (event) => {
    selectedYear = Number(event.currentTarget.value);
    render();
  }, { signal });

  app.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "new-objective") {
      openObjectiveDialog(null, button.dataset.areaId, button.dataset.period);
      return;
    }
    if (action === "edit-objective") {
      const objective = records.objectives.find((item) => item.id === button.dataset.objectiveId);
      if (objective) openObjectiveDialog(objective);
      return;
    }
    if (action === "new-key-result") {
      openKeyResultDialog(button.dataset.objectiveId);
      return;
    }
    if (action === "edit-key-result") {
      const result = records.keyResults.find((item) => item.id === button.dataset.keyResultId);
      if (result) openKeyResultDialog(result.objectiveId, result);
      return;
    }
    if (action === "close-dialog") {
      button.closest("dialog")?.close();
      return;
    }
    if (action === "archive-objective") {
      const objective = records.objectives.find((item) => item.id === button.dataset.objectiveId);
      if (!objective) return;
      if (!window.confirm(`أرشفة الهدف «${objective.title}»؟ ستبقى المهام المرتبطة به محفوظة.`)) return;
      try {
        await update("objectives", { ...objective, status: "archived", updatedAt: new Date().toISOString() });
        setStatus("أُرشف الهدف.");
      } catch (error) {
        console.error("تعذّرت أرشفة الهدف:", error);
        setStatus(error.message, true);
      }
      return;
    }
  }, { signal });

  app.addEventListener("change", async (event) => {
    const select = event.target.closest('[data-action="set-status"]');
    if (!select) return;
    const objective = records.objectives.find((item) => item.id === select.dataset.objectiveId);
    if (!objective) return;
    try {
      await update("objectives", { ...objective, status: select.value, updatedAt: new Date().toISOString() });
      setStatus("تحدّثت حالة الهدف.");
    } catch (error) {
      console.error("تعذّر تحديث حالة الهدف:", error);
      setStatus(error.message, true);
    }
  }, { signal });

  app.addEventListener("submit", async (event) => {
    const goalForm = event.target.closest("#goal-form");
    const resultForm = event.target.closest("#key-result-form");
    if (!goalForm && !resultForm) return;
    event.preventDefault();
    try {
      const now = new Date().toISOString();
      if (goalForm) {
        const existing = records.objectives.find((item) => item.id === goalForm.elements.id.value);
        const fields = setObjectivePeriod({
          ...(existing ?? {}),
          id: existing?.id ?? crypto.randomUUID(),
          title: goalForm.elements.title.value.trim(),
          description: goalForm.elements.description.value.trim(),
          lifeAreaId: goalForm.elements.lifeAreaId.value,
          year: Number(goalForm.elements.year.value),
          status: goalForm.elements.status.value,
          order: existing?.order ?? records.objectives.length,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        }, plan, Number(goalForm.elements.period.value));
        if (existing) await update("objectives", fields);
        else await add("objectives", fields);
        goalForm.closest("dialog").close();
        setStatus(existing ? "حُفظت تعديلات الهدف." : "أُضيف الهدف.");
      } else if (resultForm) {
        const existing = records.keyResults.find((item) => item.id === resultForm.elements.id.value);
        const result = {
          ...(existing ?? {}),
          id: existing?.id ?? crypto.randomUUID(),
          objectiveId: resultForm.elements.objectiveId.value,
          title: resultForm.elements.title.value.trim(),
          metric: resultForm.elements.metric.value.trim(),
          start: Number(resultForm.elements.start.value),
          target: Number(resultForm.elements.target.value),
          current: Number(resultForm.elements.current.value),
          unit: resultForm.elements.unit.value.trim(),
          updatedAt: now,
        };
        if (![result.start, result.target, result.current].every(Number.isFinite) || result.target === result.start) {
          throw new Error("يجب أن يكون المستهدف مختلفاً عن قيمة البداية.");
        }
        if (existing) await update("keyResults", result);
        else await add("keyResults", result);
        resultForm.closest("dialog").close();
        setStatus(existing ? "حُفظت تعديلات النتيجة الرئيسية." : "أُضيفت النتيجة الرئيسية.");
      }
    } catch (error) {
      console.error("تعذّر حفظ بيانات الأهداف:", error);
      setStatus(error.message, true);
    }
  }, { signal });
}

export async function mountGoalsView(isCurrent = () => true) {
  unsubscribe?.();
  await ensureDefaultLifeAreas();
  await refreshRecords();
  if (!isCurrent()) return;
  document.querySelector("#page-title").textContent = "الأهداف";
  render();
  unsubscribe = subscribe(async (_state, change) => {
    if (!change.storeName || Object.hasOwn(records, change.storeName)) {
      try {
        await refreshRecords();
        if (isCurrent() && window.location.hash.startsWith("#/goals")) render();
      } catch (error) {
        console.error("تعذّر تحديث مصفوفة الأهداف:", error);
        setStatus(error.message, true);
      }
    }
  });
}

async function ensureDefaultLifeAreas() {
  const areas = await getRecords("lifeAreas");
  const missingAreas = DEFAULT_LIFE_AREAS.filter((area) => !areas.some((existing) => existing.id === area.id));
  if (!missingAreas.length) return;
  const now = new Date().toISOString();
  await Promise.all(missingAreas.map((area, index) => {
    return update("lifeAreas", {
      ...area,
      icon: "◎",
      order: areas.length + index,
      archived: false,
      createdAt: now,
      updatedAt: now,
    });
  }));
}

export function unmountGoalsView() {
  unsubscribe?.();
  unsubscribe = undefined;
  eventController?.abort();
  eventController = undefined;
}

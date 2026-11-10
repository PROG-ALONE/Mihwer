import { add, getRecords, remove, subscribe, update } from "../store.js";
import { formatDate, localDateString } from "../utils/dates.js";
import { nextOccurrence, RECURRENCE_OPTIONS } from "../utils/recurrence.js";
import { parseQuickAdd } from "../utils/quickadd.js";
import { showToast } from "../utils/notifications.js";
import { formatDuration, totalRecordedTaskMinutes } from "../utils/task-metrics.js";
import { isTaskScheduledOn } from "../utils/task-schedule.js";
import { ensureDefaultLifeAreas } from "../utils/life-areas.js";
import { requestCompletionDetails } from "../utils/completion-dialog.js";
import { printStructuredReport } from "../export/pdf.js";
import { bindDailyRecordDialog, dailyRecordButtonMarkup, dailyRecordDialogMarkup } from "../utils/daily-records.js";

const PRIORITY_LABELS = ["مهم وعاجل", "مهم وغير عاجل", "عاجل وغير مهم", "غير عاجل وغير مهم"];
const PRIORITY_GUIDANCE = ["ابدأ بها الآن", "حدّد لها وقتاً", "أنجزها بسرعة", "أجّلها أو استبعدها"];

let unsubscribe;
let records = { tasks: [], habits: [], projects: [], objectives: [], keyResults: [], lifeAreas: [] };
let statusFilter = "active";
let priorityModeEnabled = localStorage.getItem("mihwar-task-priority-mode") === "true";
let taskQuery = "";
let taskProjectFilter = "";
let selectedPriority = null;
let eventController;
let editorSubtasksPending = false;
const expandedTaskSubtasks = new Set();
const expandedTaskDetails = new Set();
const collapsedTaskSubtasks = new Set();
const collapsedTaskDetails = new Set();

function arabicDigits(value) {
  return String(value).replace(/\d/g, (digit) => "٠١٢٣٤٥٦٧٨٩"[Number(digit)]);
}

function animateTaskCounter(counter) {
  const target = Math.max(0, Number(counter.dataset.count) || 0);
  const duration = Math.min(850, 260 + target * 45);
  const startedAt = performance.now();
  counter.textContent = arabicDigits(0);
  counter.classList.remove("is-counting");
  requestAnimationFrame(() => counter.classList.add("is-counting"));
  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - ((1 - progress) ** 3);
    counter.textContent = arabicDigits(Math.round(target * eased));
    if (progress < 1) requestAnimationFrame(tick);
    else counter.classList.remove("is-counting");
  };
  requestAnimationFrame(tick);
}

function initializeTaskCounters(root) {
  root.querySelectorAll("[data-count]").forEach((counter) => {
    counter.textContent = arabicDigits(counter.dataset.count);
  });
  root.addEventListener("pointerover", (event) => {
    const counter = event.target.closest("[data-count]");
    if (!counter || counter.contains(event.relatedTarget)) return;
    animateTaskCounter(counter);
  });
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function priorityIndex(task) {
  if (Number.isInteger(task.priority) && task.priority >= 0 && task.priority <= 3) return task.priority;
  if (task.important && task.urgent) return 0;
  if (task.important) return 1;
  if (task.urgent) return 2;
  return 3;
}

function taskLifeAreaId(task) {
  if (task.lifeAreaId) return task.lifeAreaId;
  const objectiveId = task.objectiveId ??
    records.keyResults.find((result) => result.id === task.keyResultId)?.objectiveId;
  return records.objectives.find((objective) => objective.id === objectiveId)?.lifeAreaId ?? "";
}

function selectedDateFilter() {
  const date = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("date") ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function isTaskOnDate(task, date) {
  if (task.status === "done") return Boolean(task.completedAt) && localDateString(new Date(task.completedAt)) === date;
  if (isTaskScheduledOn(task, date, true)) return true;
  const start = task.scheduled || task.due;
  if (!start) return false;
  const firstDate = /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : localDateString(new Date(start));
  const due = task.due
    ? /^\d{4}-\d{2}-\d{2}$/.test(task.due) ? task.due : localDateString(new Date(task.due))
    : "";
  if (!due) return date >= firstDate && date <= localDateString();
  const endDate = due;
  const first = firstDate < endDate ? firstDate : endDate;
  const last = firstDate > endDate ? firstDate : endDate;
  return date >= first && date <= last;
}

function currentTasks() {
  const date = selectedDateFilter();
  return records.tasks.filter((task) => statusFilter === "done"
    ? task.status === "done"
    : task.status !== "done").filter((task) => !date || isTaskOnDate(task, date)).filter((task) => {
    const query = taskQuery.trim().toLocaleLowerCase("ar");
    const haystack = [task.title, task.notes, ...(task.tags ?? [])].join(" ").toLocaleLowerCase("ar");
    return (!query || haystack.includes(query)) && (!taskProjectFilter || task.projectId === taskProjectFilter);
  });
}

function normalizedChecklist(task) {
  return (task.checklist ?? []).map((item) => typeof item === "string"
    ? { id: crypto.randomUUID(), text: item, done: false, completionLog: [] }
    : { ...item, completionLog: Array.isArray(item.completionLog) ? item.completionLog : [] });
}

function subtaskItemContent(item, index) {
  return `
    <div class="subtask-row">
      <label><input type="checkbox" data-action="toggle-subtask" data-index="${index}" ${item.done ? "checked" : ""}> <span>${escapeHtml(item.text)}</span></label>
      <div class="subtask-item-actions">
        <button class="subtask-action-button is-edit" type="button" data-action="edit-subtask" data-index="${index}" aria-label="تعديل المهمة الفرعية">✎ تعديل</button>
        <button class="subtask-action-button is-delete" type="button" data-action="delete-subtask" data-index="${index}" aria-label="حذف المهمة الفرعية">حذف</button>
      </div>
    </div>`;
}

function subtasksBlock(task) {
  const items = normalizedChecklist(task);
  const doneCount = items.filter((item) => item.done).length;
  const percent = items.length ? Math.round((doneCount / items.length) * 100) : 0;
  const heading = items.length ? `مهام فرعية · ${doneCount} من ${items.length} مكتملة` : "أضف أول مهمة فرعية";
  const isOpen = expandedTaskSubtasks.has(task.id) ||
    (items.length > 0 && !collapsedTaskSubtasks.has(task.id));
  return `
    <details class="subtasks"${isOpen ? " open" : ""} aria-label="${heading}">
      <summary>${heading}</summary>
      ${items.length ? `<div class="subtask-progress" role="progressbar" aria-label="إنجاز المهام الفرعية" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${percent}%"></span></div>` : ""}
      <form class="subtask-add" data-subtask-form>
        <input type="text" name="text" placeholder="أضف مهمة فرعية…" aria-label="مهمة فرعية جديدة" maxlength="200">
        <button class="button button-secondary" type="submit">إضافة</button>
      </form>
      <ul class="subtask-list">
        ${items.map((item, index) => `
          <li class="${item.done ? "is-done" : ""}">
            ${subtaskItemContent(item, index)}
          </li>`).join("")}
      </ul>
    </details>`;
}

async function saveChecklist(task, checklist) {
  editorSubtasksPending = true;
  try {
    await update("tasks", { ...task, checklist, updatedAt: new Date().toISOString() });
  } finally {
    editorSubtasksPending = false;
  }
}

function taskCard(task) {
  const done = task.status === "done";
  const taskDate = task.due || task.scheduled;
  const overdue = !done && taskDate && taskDate < localDateString();
  const checklist = normalizedChecklist(task);
  const detailsOpen = expandedTaskDetails.has(task.id) ||
    (checklist.length > 0 && !collapsedTaskDetails.has(task.id));
  const trackedMinutes = totalRecordedTaskMinutes(task);
  const lifeArea = records.lifeAreas.find((area) => area.id === taskLifeAreaId(task));
  const checklistDone = checklist.filter((item) => item.done).length;
  const priority = priorityIndex(task);
  const completionLabel = done ? "مكتملة" : overdue ? "متأخرة" : "قيد الإنجاز";
  return `
    <article class="task-card${done ? " is-done" : ""}" data-priority="${priorityIndex(task)}" data-task-id="${escapeHtml(task.id)}">
      <span class="task-color-dot" aria-hidden="true"></span>
      <div class="task-card-heading">
        <label class="task-check" aria-label="${done ? "إعادة فتح المهمة" : "إنجاز المهمة"}">
          <input type="checkbox" data-action="toggle" ${done ? "checked" : ""}>
          <span aria-hidden="true"></span>
        </label>
        <button class="task-card-summary" type="button" data-action="toggle-task-details" aria-expanded="${detailsOpen}" aria-label="إظهار تفاصيل المهمة: ${escapeHtml(task.title)}">
          <span class="task-title">${escapeHtml(task.title)}</span>
          ${lifeArea ? `<span class="task-card-meta">${escapeHtml(lifeArea.name)}</span>` : ""}
        </button>
        <div class="task-card-actions">
          <button class="icon-button task-card-edit" type="button" data-action="edit" aria-label="تعديل ${escapeHtml(task.title)}">✎</button>
        </div>
      </div>
      <div class="task-card-details${detailsOpen ? " is-open" : ""}"${detailsOpen ? "" : " hidden"}>
        <div class="task-details-topline">
          <strong>تفاصيل المهمة</strong>
          <span class="task-details-status${done ? " is-done" : overdue ? " is-overdue" : ""}">${completionLabel}</span>
        </div>
        <div class="task-details-facts">
          <span><small>الأولوية</small><strong>${PRIORITY_LABELS[priority]}</strong></span>
          ${task.spreadAcrossPeriod && task.scheduled && task.due
            ? `<span><small>الفترة</small><strong>${escapeHtml(formatDate(task.scheduled))} – ${escapeHtml(formatDate(task.due))}</strong></span>`
            : taskDate ? `<span><small>الموعد</small><strong>${escapeHtml(formatDate(taskDate))}${task.dueTime ? ` · ${escapeHtml(task.dueTime)}` : ""}</strong></span>` : ""}
          ${task.spreadAcrossPeriod ? `<span><small>نوع المهمة</small><strong>ممتدة على فترة</strong></span>` : ""}
          ${lifeArea ? `<span><small>المجال</small><strong>${escapeHtml(lifeArea.name)}</strong></span>` : ""}
          ${task.estimateMin ? `<span><small>الوقت المتوقع</small><strong>${formatDuration(task.estimateMin)}</strong></span>` : ""}
          ${trackedMinutes ? `<span><small>الوقت المسجّل</small><strong>${formatDuration(trackedMinutes)}</strong></span>` : ""}
        </div>
        ${task.notes ? `<p class="task-details-notes">${escapeHtml(task.notes)}</p>` : ""}
        <div class="task-details-actions">
          <a class="task-focus-link" href="#/focus?task=${encodeURIComponent(task.id)}">◉ ابدأ التركيز</a>
          ${checklist.length ? `<span class="task-details-progress" aria-label="إنجاز ${checklistDone} من ${checklist.length} مهام فرعية"><i style="--subtask-progress:${Math.round(checklistDone / checklist.length * 100)}%"></i>${checklistDone}/${checklist.length} خطوات</span>` : ""}
        </div>
        ${subtasksBlock(task)}
      </div>
      </article>
    `;
}

function renderList(tasks) {
  if (!tasks.length) {
    if (selectedDateFilter()) return `<div class="tasks-empty">لا توجد مهام مسجلة لهذا اليوم بعد.</div>`;
    const emptyMessage = statusFilter === "done"
      ? "لا توجد مهام منجزة بعد."
      : "ابدأ بإضافة مهمتك الأولى من زر + أعلاه.";
    return `<div class="tasks-empty">${emptyMessage}</div>`;
  }
  return `<div class="task-list">${tasks.map(taskCard).join("")}</div>`;
}

function visibleTasksReport(tasks, date) {
  const title = date ? "مهام اليوم" : statusFilter === "done" ? "المهام المنجزة" : "المهام قيد الإنجاز";
  const period = date ? formatDate(date) : "القائمة الحالية";
  const completed = tasks.filter((task) => task.status === "done").length;
  const sections = PRIORITY_LABELS.map((priorityLabel, priority) => {
    const priorityTasks = tasks.filter((task) => priorityIndex(task) === priority);
    return {
      title: `${priorityLabel} · ${arabicDigits(priorityTasks.length)}`,
      items: priorityTasks.map((task) => {
        const checklist = normalizedChecklist(task);
        const dueDate = task.due || task.scheduled;
        const details = [
          { label: "الحالة", value: task.status === "done" ? "مكتملة" : "قيد الإنجاز" },
          ...(dueDate ? [{ label: "الموعد", value: `${formatDate(dueDate)}${task.dueTime ? ` · ${task.dueTime}` : ""}` }] : []),
          ...(task.lifeAreaId ? [{ label: "المجال", value: records.lifeAreas.find((area) => area.id === task.lifeAreaId)?.name ?? "—" }] : []),
          ...(task.projectId ? [{ label: "المشروع", value: records.projects.find((project) => project.id === task.projectId)?.name ?? "—" }] : []),
          ...(task.notes ? [{ label: "ملاحظات", value: task.notes }] : []),
          ...checklist.map((item) => ({ label: item.done ? "✓" : "○", value: item.text })),
        ];
        return {
          title: task.title,
          detail: task.status === "done" ? "مكتملة" : "قيد الإنجاز",
          details,
        };
      }),
    };
  }).filter((section) => section.items.length);
  return {
    title,
    period,
    summary: [
      { label: "عدد المهام", value: arabicDigits(tasks.length) },
      { label: "المكتملة", value: arabicDigits(completed) },
      { label: "قيد الإنجاز", value: arabicDigits(tasks.length - completed) },
    ],
    sections,
  };
}

function toggleTaskDetails(card) {
  const taskId = card?.dataset.taskId;
  const details = card?.querySelector(":scope > .task-card-details");
  if (!taskId || !details) return;
  const open = details.hidden;
  details.hidden = !open;
  details.classList.toggle("is-open", open);
  const summary = card.querySelector('[data-action="toggle-task-details"]');
  summary?.setAttribute("aria-expanded", String(open));
  if (open) {
    expandedTaskDetails.add(taskId);
    collapsedTaskDetails.delete(taskId);
    requestAnimationFrame(() => card.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "nearest",
    }));
  } else {
    expandedTaskDetails.delete(taskId);
    collapsedTaskDetails.add(taskId);
  }
}

function renderPriorityBoard(tasks) {
  if (!tasks.length) return renderList(tasks);
  const groups = PRIORITY_LABELS.map((label, index) => ({
    label,
    index,
    tasks: tasks.filter((task) => priorityIndex(task) === index),
  }));

  return `<div class="task-priority-board">
    ${groups.map((group) => `
      <section class="task-priority-group priority-card-${group.index}" aria-label="${group.label}">
        <header><h3>${group.label}</h3><span>${group.tasks.length}</span></header>
        <div class="task-list">${group.tasks.length ? group.tasks.map(taskCard).join("") : `<p class="task-priority-empty">فارغة</p>`}</div>
      </section>`).join("")}
  </div>`;
}

function renderPriorityCards(tasks) {
  const groups = PRIORITY_LABELS.map((label, index) => ({
    label,
    index,
    tasks: tasks.filter((task) => priorityIndex(task) === index),
  }));
  const selected = selectedPriority === null ? null : groups[selectedPriority];
  return `<section class="task-priority-overview" aria-label="أولويات المهام">
    <div class="task-priority-cards">
      ${groups.map((group) => `<button class="task-priority-card priority-card-${group.index}${group.tasks.length ? " has-tasks" : ""}${selectedPriority === group.index ? " is-selected" : ""}" type="button" data-action="select-priority" data-priority="${group.index}" aria-pressed="${selectedPriority === group.index}">
        <span class="task-priority-spark" aria-hidden="true"></span>
        <span>${group.label}</span>
        <strong class="task-count" data-count="${group.tasks.length}">٠</strong>
        <small>${group.tasks.length ? statusFilter === "done" ? "مهام مكتملة" : "مهام لم تُنجز" : "لا توجد مهام"}</small>
      </button>`).join("")}
    </div>
    ${selected ? `<section class="task-priority-details" aria-label="تفاصيل ${selected.label}">
      <header><div><p class="goals-kicker">تفاصيل الأولوية</p><h3>${selected.label}</h3></div><span>${selected.tasks.length} مهام</span></header>
      <div class="task-list">${selected.tasks.length ? selected.tasks.map(taskCard).join("") : `<p class="task-priority-empty">لا توجد مهام ضمن هذه الأولوية.</p>`}</div>
    </section>` : `<p class="task-priority-hint">اضغط على إحدى البطاقات لعرض المهام غير المنجزة تحتها.</p>`}
  </section>`;
}

function render() {
  const app = document.querySelector("#app");
  if (!app) return;
  const tasks = currentTasks().sort((first, second) => {
    const firstOrder = Number.isFinite(first.order) ? first.order : Date.parse(first.createdAt ?? "") || 0;
    const secondOrder = Number.isFinite(second.order) ? second.order : Date.parse(second.createdAt ?? "") || 0;
    return firstOrder - secondOrder;
  });
  const activeCount = records.tasks.filter((task) => task.status !== "done").length;
  const date = selectedDateFilter();
  const scopedTasks = date ? records.tasks.filter((task) => isTaskOnDate(task, date)) : records.tasks;
  const scopedActiveCount = scopedTasks.filter((task) => task.status !== "done").length;
  const doneCount = scopedTasks.filter((task) => task.status === "done").length;
  const body = renderList(tasks);
  const visibleTotal = tasks.length;

  app.innerHTML = `
    <section class="tasks-page" aria-label="إدارة المهام">
      <header class="tasks-heading">
        <div><p class="goals-kicker">${date ? `يوم ${escapeHtml(formatDate(date))}` : "مساحة الإنجاز"}</p><h2>${date ? "مهام اليوم" : "المهام"}</h2><p class="tasks-heading-note"><span class="task-count" data-count="${visibleTotal}">٠</span> مهمة في القائمة <span class="swipe-delete-hint">· اسحب البطاقة للحذف</span></p></div>
        <div class="tasks-heading-actions">
          ${dailyRecordButtonMarkup()}
          <button class="button button-secondary" type="button" data-action="share-task-list">حفظ القائمة PDF</button>
          <button class="tasks-heading-add" type="button" data-action="new-task" aria-label="إضافة مهمة"><span aria-hidden="true">＋</span></button>
        </div>
      </header>
      ${date ? `<a class="day-filter-back-link" href="#/today?date=${encodeURIComponent(date)}">↗ العودة إلى خارطة اليوم</a>` : ""}
      ${dailyRecordDialogMarkup("tasks", date || localDateString())}
      <nav class="task-status-tabs" aria-label="حالة المهام">
        <button type="button" class="${statusFilter === "active" ? "is-active" : ""}" data-status="active" aria-pressed="${statusFilter === "active"}">قيد الإنجاز <strong class="task-count" data-count="${date ? scopedActiveCount : activeCount}">٠</strong></button>
        <button type="button" class="${statusFilter === "done" ? "is-active" : ""}" data-status="done" aria-pressed="${statusFilter === "done"}">المنجزة <strong class="task-count" data-count="${doneCount}">٠</strong></button>
      </nav>
      <nav class="task-layout-switch" aria-label="عرض المهام">
        <button type="button" class="${!priorityModeEnabled ? "is-active" : ""}" data-layout="queue" aria-pressed="${!priorityModeEnabled}">قائمة المهام <strong class="task-count" data-count="${visibleTotal}">٠</strong></button>
        <button type="button" class="${priorityModeEnabled ? "is-active" : ""}" data-layout="priority" aria-pressed="${priorityModeEnabled}">الأولويات</button>
      </nav>
      ${priorityModeEnabled ? renderPriorityCards(tasks) : `<section class="task-queue-section" aria-label="قائمة المهام">${body}</section>`}
      <dialog class="task-dialog task-add-dialog" id="task-add-dialog">
        <div class="task-add-dialog-heading"><span class="task-add-mark" aria-hidden="true">＋</span><div><h2>إضافة مهمة</h2><p>اختر بطاقة الأولوية لإضافتها إلى طابورك</p></div><button class="icon-button" type="button" data-action="close-add" aria-label="إغلاق">×</button></div>
        <form class="quick-add-form task-add-form" id="quick-add-form">
          <label class="task-add-title-label" for="quick-add-input">ماذا تريد أن تنجز؟</label>
          <input id="quick-add-input" name="task" autocomplete="off" placeholder="اكتب المهمة هنا…" required maxlength="240">
          <label>المجال<select name="lifeAreaId"><option value="">بدون مجال</option>${records.lifeAreas.filter((area) => !area.archived).map((area) => `<option value="${escapeHtml(area.id)}">${escapeHtml(area.name)}</option>`).join("")}</select></label>
        <div class="task-add-priority-grid" aria-label="اختر أولوية المهمة">
            ${PRIORITY_LABELS.map((label, index) => `<button class="task-add-priority-card priority-card-${index}" type="button" data-action="add-task-priority" data-priority="${index}">
              <span>${label}</span><small>${PRIORITY_GUIDANCE[index]}</small>
            </button>`).join("")}
        </div>
        </form>
      </dialog>
      <dialog class="task-dialog" id="task-dialog">
        <div class="dialog-heading">
          <h2>تفاصيل المهمة</h2>
          <button class="icon-button" type="button" data-action="close-editor" aria-label="إغلاق">×</button>
        </div>
        <div class="task-editor-subtasks" id="task-editor-subtasks"></div>
        <form id="task-editor-form" method="dialog">
          <input type="hidden" name="id">
          <label>عنوان المهمة<input name="title" required maxlength="240"></label>
          <div class="editor-fields">
            <label>تاريخ الجدولة<input name="scheduled" type="date"></label>
            <label>تاريخ الاستحقاق<input name="due" type="date"></label>
            <label>الأولوية<select name="priority">${PRIORITY_LABELS.map((label, index) => `<option value="${index}">${label}</option>`).join("")}</select></label>
            <label>المجال<select name="lifeAreaId"><option value="">من الهدف أو دون مجال</option>${records.lifeAreas.filter((area) => !area.archived).map((area) => `<option value="${escapeHtml(area.id)}">${escapeHtml(area.name)}</option>`).join("")}</select></label>
          </div>
          <label class="task-span-period-toggle">
            <input name="spreadAcrossPeriod" type="checkbox">
            <span><strong>مهمة ممتدة على فترة</strong><small>تظهر خلال المدة، ويُحتسب وزنها في يوم الاستحقاق فقط، بينما تُسجّل إنجازاتك الفرعية في أيامها.</small></span>
          </label>
          <details class="task-editor-extra">
            <summary>تفاصيل إضافية</summary>
            <label>ملاحظات<textarea name="notes" rows="3"></textarea></label>
            <div class="editor-fields">
              <label>وقت التنفيذ<input name="dueTime" type="time"></label>
              <label>مدة التركيز المستهدفة بالدقائق<input name="estimateMin" type="number" min="1" max="180" step="1"></label>
              <label>وقت أُنجز اليوم بالدقائق<input name="timeLogTodayMin" type="number" min="0" max="1440" step="1" value="0"><small>يُضاف إلى سجل اليوم ولا يستبدل أوقات التركيز السابقة.</small></label>
            </div>
            <div class="editor-fields">
              <label>المشروع<select name="projectId"><option value="">الوارد</option>${records.projects.filter((project) => !project.archived).map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("")}</select></label>
              <label>الهدف<select name="objectiveId"><option value="">بلا هدف</option>${records.objectives.map((objective) => `<option value="${escapeHtml(objective.id)}">${escapeHtml(objective.title)}</option>`).join("")}</select></label>
              <label>النتيجة الرئيسية<select name="keyResultId"><option value="">بلا نتيجة</option>${records.keyResults.map((keyResult) => `<option value="${escapeHtml(keyResult.id)}">${escapeHtml(keyResult.title)}</option>`).join("")}</select></label>
              <label>التكرار<select name="recurrence">${RECURRENCE_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join("")}</select></label>
            </div>
            <button class="button button-secondary project-create" type="button" data-action="new-project">إنشاء مشروع</button>
            <label>الوسوم<input name="tags" placeholder="عمل، دراسة"></label>
          </details>
          <div class="dialog-actions">
            <a class="button button-secondary" id="task-focus-action" href="#/focus">ابدأ التركيز</a>
            <button class="button button-primary" type="submit">حفظ التعديلات</button>
          </div>
        </form>
      </dialog>
    </section>`;

  bindEvents(app);
  bindDailyRecordDialog(app, () => records, eventController?.signal, "tasks");
  initializeTaskCounters(app);
}

function setStatus(message, isError = false) {
  showToast(message, { isError });
}

async function createTask(input, priorityOverride = null, dueDate = "", dueTime = "", focusDuration = "", lifeAreaId = null) {
  const parsed = parseQuickAdd(input);
  if (!parsed) throw new Error("اكتب عنواناً للمهمة أولاً.");
  if (priorityOverride !== null && (!Number.isInteger(priorityOverride) || priorityOverride < 0 || priorityOverride > 3)) {
    throw new Error("اختر إحدى بطاقات الأولوية.");
  }
  const priority = priorityOverride ?? priorityIndex(parsed);
  const focusDurationMin = focusDuration === "" ? parsed.estimateMin : Number(focusDuration);
  if (focusDurationMin !== null && (!Number.isInteger(focusDurationMin) || focusDurationMin < 1 || focusDurationMin > 180)) {
    throw new Error("مدة التركيز يجب أن تكون بين دقيقة واحدة و3 ساعات.");
  }
  const taskDate = dueDate || parsed.due || parsed.scheduled || selectedDateFilter() || localDateString();
  const task = {
    id: crypto.randomUUID(),
    title: parsed.title,
    notes: "",
    projectId: null,
    objectiveId: null,
    keyResultId: null,
    lifeAreaId: lifeAreaId || null,
    scheduled: taskDate,
    due: taskDate,
    dueTime: dueTime || null,
    important: priority === 0 || priority === 1,
    urgent: priority === 0 || priority === 2,
    estimateMin: focusDurationMin,
    tags: parsed.tags,
    checklist: [],
    spreadAcrossPeriod: false,
    timeLog: [],
    recurrence: parsed.recurrence,
    status: "open",
    completedAt: null,
    timeSpentMin: 0,
    order: Date.now(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (parsed.referenceName) {
    const name = parsed.referenceName.toLocaleLowerCase("ar");
    const project = records.projects.find((item) => item.name.toLocaleLowerCase("ar") === name);
    const objective = records.objectives.find((item) => item.title.toLocaleLowerCase("ar") === name);
    const keyResult = records.keyResults.find((item) => item.title.toLocaleLowerCase("ar") === name);
    if (project) task.projectId = project.id;
    else if (objective) {
      task.objectiveId = objective.id;
      if (!task.lifeAreaId) task.lifeAreaId = objective.lifeAreaId ?? null;
    }
    else if (keyResult) {
      task.keyResultId = keyResult.id;
      task.objectiveId = keyResult.objectiveId ?? null;
      if (!task.lifeAreaId) task.lifeAreaId = records.objectives.find((item) => item.id === task.objectiveId)?.lifeAreaId ?? null;
    }
    else throw new Error(`لم يُعثر على مشروع أو هدف باسم «${parsed.referenceName}». أنشئه أولاً.`);
  }

  await add("tasks", task);
}

async function toggleTask(task, completionDetails = null) {
  const now = new Date().toISOString();
  if (task.status !== "done") {
    if (!completionDetails) throw new Error("يلزم تسجيل وقت الإنجاز ومدته أولاً.");
    const completionLog = [
      ...(Array.isArray(task.completionLog) ? task.completionLog : []),
      completionDetails,
    ];
    await update("tasks", {
      ...task,
      status: "done",
      completedAt: completionDetails.completedAt,
      completionLog,
      updatedAt: now,
    });
    if (task.recurrence) {
      const nextDate = nextOccurrence(task.scheduled || task.due, task.recurrence);
      await add("tasks", {
        ...task,
        id: crypto.randomUUID(),
        checklist: normalizedChecklist(task).map((item) => ({
          ...item,
          id: crypto.randomUUID(),
          done: false,
          completedAt: null,
          completionLog: [],
        })),
        timeSpentMin: 0,
        timeLog: [],
        scheduled: nextDate,
        due: task.due ? nextDate : null,
        status: "open",
        completedAt: null,
        completionLog: [],
        timeSpentMin: 0,
        order: Date.now(),
        createdAt: now,
        updatedAt: now,
      });
    }
  } else {
    await update("tasks", { ...task, status: "open", completedAt: null, updatedAt: now });
  }
}

async function deleteTask(task) {
  await remove("tasks", task.id);
  expandedTaskSubtasks.delete(task.id);
  expandedTaskDetails.delete(task.id);
  collapsedTaskSubtasks.delete(task.id);
  collapsedTaskDetails.delete(task.id);
  setStatus("حُذفت المهمة.");
}

function bindEvents(app) {
  eventController?.abort();
  eventController = new AbortController();
  const { signal } = eventController;
  let swipeState = null;
  let suppressClickUntil = 0;
  app.querySelector("#task-dialog")?.addEventListener("close", () => render(), { signal });

  app.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" || event.target.closest("a, input, label, details, summary, .task-card-details, button:not(.task-card-summary)")) return;
    const card = event.target.closest(".task-card[data-task-id]");
    if (!card) return;
    swipeState = { card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    card.classList.add("is-swipe-ready");
  }, { signal });

  app.addEventListener("pointermove", (event) => {
    if (!swipeState || event.pointerId !== swipeState.pointerId) return;
    const deltaX = event.clientX - swipeState.startX;
    const deltaY = event.clientY - swipeState.startY;
    if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 10) {
      swipeState.card.classList.remove("is-swipe-ready", "is-swipe-delete");
      swipeState.card.style.transform = "";
      swipeState = null;
      return;
    }
    if (Math.abs(deltaX) < 8) return;
    if (!swipeState.card.hasPointerCapture(event.pointerId)) {
      swipeState.card.setPointerCapture(event.pointerId);
    }
    swipeState.moved = true;
    const distance = Math.max(-150, Math.min(150, deltaX));
    swipeState.card.style.transform = `translateX(${distance}px)`;
    swipeState.card.classList.toggle("is-swipe-delete", Math.abs(distance) >= 90);
    event.preventDefault();
  }, { signal, passive: false });

  app.addEventListener("pointerup", async (event) => {
    if (!swipeState || event.pointerId !== swipeState.pointerId) return;
    const { card, moved } = swipeState;
    const shouldDelete = card.classList.contains("is-swipe-delete");
    const task = records.tasks.find((item) => item.id === card.dataset.taskId);
    swipeState = null;
    if (moved) suppressClickUntil = Date.now() + 700;
    card.classList.remove("is-swipe-ready", "is-swipe-delete");
    card.style.transform = "";
    if (!moved || !shouldDelete || !task || !window.confirm(`هل تريد حذف «${task.title}»؟`)) return;
    try {
      await deleteTask(task);
    } catch (error) {
      console.error("تعذّر حذف المهمة بالسحب:", error);
      setStatus(error.message, true);
    }
  }, { signal });

  app.addEventListener("pointercancel", (event) => {
    if (!swipeState || event.pointerId !== swipeState.pointerId) return;
    swipeState.card.classList.remove("is-swipe-ready", "is-swipe-delete");
    swipeState.card.style.transform = "";
    swipeState = null;
  }, { signal });

  app.querySelector("[data-task-search]")?.addEventListener("input", (event) => {
    taskQuery = event.currentTarget.value;
    render();
    const search = app.querySelector("[data-task-search]");
    search?.focus();
    search?.setSelectionRange(taskQuery.length, taskQuery.length);
  }, { signal });
  app.querySelector("[data-task-project]")?.addEventListener("change", (event) => {
    taskProjectFilter = event.currentTarget.value;
    render();
  }, { signal });

  app.addEventListener("toggle", (event) => {
    const details = event.target.closest(".subtasks");
    if (!details) return;
    const taskId = details.closest("[data-task-id]")?.dataset.taskId;
    if (!taskId) return;
    if (details.open) {
      expandedTaskSubtasks.add(taskId);
      collapsedTaskSubtasks.delete(taskId);
    } else {
      expandedTaskSubtasks.delete(taskId);
      collapsedTaskSubtasks.add(taskId);
    }
  }, { capture: true, signal });

  app.querySelector("#quick-add-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = app.querySelector("#quick-add-input");
    if (input.value.trim()) setStatus("اختر بطاقة الأولوية لإضافة المهمة.");
  });

  app.querySelectorAll("[data-status]").forEach((button) => button.addEventListener("click", () => {
    statusFilter = button.dataset.status;
    render();
  }));

  app.addEventListener("change", async (event) => {
    const sub = event.target.closest('[data-action="toggle-subtask"]');
    if (sub) {
      const task = records.tasks.find((item) => item.id === sub.closest("[data-task-id]")?.dataset.taskId);
      if (!task) return;
      const items = normalizedChecklist(task);
      const item = items[Number(sub.dataset.index)];
      if (!item) return;
      item.done = sub.checked;
      const date = localDateString();
      const completionLog = Array.isArray(item.completionLog) ? item.completionLog : [];
      item.completionLog = [
        ...completionLog.filter((entry) => entry?.date !== date),
        { date, completed: sub.checked },
      ];
      item.completedAt = sub.checked ? new Date().toISOString() : null;
      try {
        await saveChecklist(task, items);
        if (items.every((entry) => entry.done) && task.status !== "done") {
          setStatus("اكتملت كل المهام الفرعية. يمكنك إنجاز المهمة الرئيسية.");
        }
      } catch (error) {
        setStatus(error.message, true);
      }
      return;
    }
    const checkbox = event.target.closest('[data-action="toggle"]');
    if (!checkbox) return;
    const taskElement = checkbox.closest("[data-task-id]");
    const task = records.tasks.find((item) => item.id === taskElement?.dataset.taskId);
    if (!task) return;
    try {
      const completionDetails = task.status === "done"
        ? null
        : await requestCompletionDetails({ title: task.title });
      if (task.status !== "done" && !completionDetails) {
        checkbox.checked = false;
        return;
      }
      await toggleTask(task, completionDetails);
      setStatus(task.status === "done" ? "أُعيد فتح المهمة، وأصبحت ضمن المهام قيد الإنجاز." : "أُنجزت المهمة، وتجدها في قائمة المنجزة.");
    } catch (error) {
      checkbox.checked = task.status === "done";
      console.error("تعذّر تحديث المهمة:", error);
      setStatus(error.message, true);
    }
  }, { signal });

  app.addEventListener("click", async (event) => {
    if (Date.now() < suppressClickUntil) return;
    const card = event.target.closest(".task-card[data-task-id]");
    const button = event.target.closest("[data-action], [data-layout]");
    if (!button && card && !event.target.closest("a, input, label, details, summary, button")) {
      toggleTaskDetails(card);
      return;
    }
    if (!button) return;
    if (button.dataset.layout) {
      priorityModeEnabled = button.dataset.layout === "priority";
      localStorage.setItem("mihwar-task-priority-mode", String(priorityModeEnabled));
      render();
      return;
    }
    if (button.dataset.action === "select-priority") {
      const priority = Number(button.dataset.priority);
      selectedPriority = selectedPriority === priority ? null : priority;
      render();
      return;
    }
    if (button.dataset.action === "toggle-task-details") {
      toggleTaskDetails(button.closest(".task-card"));
      return;
    }
    if (button.dataset.action === "share-task-list") {
      const tasks = currentTasks().filter((task) => !priorityModeEnabled || selectedPriority === null || priorityIndex(task) === selectedPriority);
      const report = visibleTasksReport(tasks, selectedDateFilter());
      printStructuredReport(report.title, report.period, report.summary, report.sections);
      return;
    }
    if (button.dataset.action === "new-task") {
      const form = app.querySelector("#quick-add-form");
      form.reset();
      app.querySelector("#task-add-dialog").showModal();
      requestAnimationFrame(() => app.querySelector("#quick-add-input")?.focus());
      return;
    }
    if (button.dataset.action === "add-task-priority") {
      const input = app.querySelector("#quick-add-input");
      const title = input.value.trim();
      if (!title) {
        input.reportValidity();
        return;
      }
      const selectedPriority = Number(button.dataset.priority);
      app.querySelector("#task-add-dialog")?.close();
      statusFilter = "active";
      try {
        const lifeAreaId = app.querySelector('#quick-add-form [name="lifeAreaId"]')?.value || null;
        await createTask(title, selectedPriority, "", "", "", lifeAreaId);
        setStatus("أُضيفت المهمة إلى طابورك.");
      } catch (error) {
        console.error("تعذّرت إضافة المهمة:", error);
        const dialog = app.querySelector("#task-add-dialog");
        const currentInput = app.querySelector("#quick-add-input");
        if (currentInput) currentInput.value = title;
        if (dialog && !dialog.open) dialog.showModal();
        currentInput?.focus();
        setStatus(error.message, true);
      }
      return;
    }
    if (button.dataset.action === "close-add") {
      app.querySelector("#task-add-dialog")?.close();
      return;
    }
    if (button.dataset.action === "new-project") {
      const name = window.prompt("اسم المشروع الجديد:");
      if (!name?.trim()) return;
      try {
        const project = {
          id: crypto.randomUUID(),
          name: name.trim(),
          color: "#6258d9",
          objectiveId: null,
          archived: false,
          order: records.projects.length,
          createdAt: new Date().toISOString(),
        };
        await add("projects", project);
        const projectSelect = app.querySelector('#task-editor-form [name="projectId"]');
        if (projectSelect) projectSelect.value = project.id;
        setStatus("أُنشئ المشروع.");
      } catch (error) {
        console.error("تعذّر إنشاء المشروع:", error);
        setStatus(error.message, true);
      }
      return;
    }
    if (button.dataset.action === "edit-subtask") {
      const taskId = button.closest("[data-task-id]")?.dataset.taskId
        ?? button.closest("#task-editor-subtasks")?.dataset.taskId;
      const task = records.tasks.find((item) => item.id === taskId);
      const index = Number(button.dataset.index);
      const item = task && normalizedChecklist(task)[index];
      const row = button.closest("li");
      if (!item || !row) return;
      row.innerHTML = `<form class="subtask-edit-form" data-subtask-edit-form data-index="${index}">
        <input type="text" name="text" value="${escapeHtml(item.text)}" maxlength="200" required aria-label="نص المهمة الفرعية">
        <button class="button button-primary" type="submit">حفظ</button>
        <button class="button button-secondary" type="button" data-action="cancel-subtask-edit" data-index="${index}">إلغاء</button>
      </form>`;
      const input = row.querySelector('input[name="text"]');
      input?.focus();
      input?.select();
      return;
    }
    if (button.dataset.action === "cancel-subtask-edit") {
      const taskId = button.closest("[data-task-id]")?.dataset.taskId
        ?? button.closest("#task-editor-subtasks")?.dataset.taskId;
      const task = records.tasks.find((item) => item.id === taskId);
      const index = Number(button.dataset.index);
      const item = task && normalizedChecklist(task)[index];
      const row = button.closest("li");
      if (item && row) row.innerHTML = subtaskItemContent(item, index);
      return;
    }
    if (button.dataset.action === "delete-subtask") {
      const taskId = button.closest("[data-task-id]")?.dataset.taskId
        ?? button.closest("#task-editor-subtasks")?.dataset.taskId;
      const task = records.tasks.find((item) => item.id === taskId);
      if (!task) return;
      const item = normalizedChecklist(task)[Number(button.dataset.index)];
      if (!item || !window.confirm(`هل تريد حذف المهمة الفرعية «${item.text}»؟`)) return;
      try {
        await saveChecklist(task, normalizedChecklist(task).filter((_, index) => index !== Number(button.dataset.index)));
        setStatus("حُذفت المهمة الفرعية.");
      } catch (error) {
        console.error("تعذّر حذف المهمة الفرعية:", error);
        setStatus(error.message, true);
      }
      return;
    }
    if (button.dataset.action === "edit") {
      const taskId = button.closest("[data-task-id]")?.dataset.taskId;
      const task = records.tasks.find((item) => item.id === taskId);
      const dialog = app.querySelector("#task-dialog");
      if (!task || !dialog) return;
      expandedTaskDetails.delete(task.id);
      collapsedTaskDetails.add(task.id);
      const card = button.closest(".task-card");
      const cardDetails = card?.querySelector(":scope > .task-card-details");
      if (cardDetails) cardDetails.hidden = true;
      card?.querySelector('[data-action="toggle-task-details"]')?.setAttribute("aria-expanded", "false");
      expandedTaskSubtasks.delete(task.id);
      collapsedTaskSubtasks.add(task.id);
      const form = dialog.querySelector("#task-editor-form");
      form.elements.id.value = task.id;
      form.elements.title.value = task.title;
      form.elements.notes.value = task.notes ?? "";
      form.elements.scheduled.value = task.scheduled ?? "";
      form.elements.due.value = task.due ?? "";
      form.elements.spreadAcrossPeriod.checked = Boolean(task.spreadAcrossPeriod);
      form.elements.dueTime.value = task.dueTime ?? "";
      form.elements.priority.value = String(priorityIndex(task));
      form.elements.estimateMin.value = task.estimateMin ?? "";
      form.elements.timeLogTodayMin.value = "0";
      form.elements.projectId.value = task.projectId ?? "";
      form.elements.objectiveId.value = task.objectiveId ?? "";
      form.elements.lifeAreaId.value = taskLifeAreaId(task);
      form.elements.keyResultId.value = task.keyResultId ?? "";
      form.elements.recurrence.value = task.recurrence ?? "";
      form.elements.tags.value = (task.tags ?? []).join("، ");
      const taskSubtasks = dialog.querySelector("#task-editor-subtasks");
      taskSubtasks.dataset.taskId = task.id;
      taskSubtasks.innerHTML = subtasksBlock(task);
      const focusAction = dialog.querySelector("#task-focus-action");
      focusAction.href = `#/focus?task=${encodeURIComponent(task.id)}`;
      focusAction.hidden = task.status === "done";
      dialog.showModal();
      return;
    }
    if (button.dataset.action === "close-editor") {
      app.querySelector("#task-dialog")?.close();
      return;
    }
  }, { signal });

  app.addEventListener("submit", async (event) => {
    const subtaskEditForm = event.target.closest("[data-subtask-edit-form]");
    if (subtaskEditForm) {
      event.preventDefault();
      const taskId = subtaskEditForm.closest("[data-task-id]")?.dataset.taskId
        ?? subtaskEditForm.closest("#task-editor-subtasks")?.dataset.taskId;
      const task = records.tasks.find((item) => item.id === taskId);
      const index = Number(subtaskEditForm.dataset.index);
      const text = subtaskEditForm.elements.text.value.trim();
      if (!task || !Number.isInteger(index) || !text) {
        setStatus("أدخل نص المهمة الفرعية.", true);
        return;
      }
      const checklist = normalizedChecklist(task);
      if (!checklist[index]) {
        setStatus("لم تعد المهمة الفرعية موجودة. حدّث القائمة وحاول مجدداً.", true);
        return;
      }
      try {
        subtaskEditForm.querySelector('button[type="submit"]').disabled = true;
        checklist[index].text = text;
        await saveChecklist(task, checklist);
        setStatus("حُفظ تعديل المهمة الفرعية.");
      } catch (error) {
        console.error("تعذّر حفظ تعديل المهمة الفرعية:", error);
        setStatus(error.message, true);
      }
      return;
    }
    const subtaskForm = event.target.closest("[data-subtask-form]");
    if (subtaskForm) {
      event.preventDefault();
      const taskId = subtaskForm.closest("[data-task-id]")?.dataset.taskId
        ?? subtaskForm.closest("#task-editor-subtasks")?.dataset.taskId;
      const task = records.tasks.find((item) => item.id === taskId);
      const input = subtaskForm.elements.text;
      const text = input?.value.trim();
      if (!task || !text) return;
      try {
        expandedTaskSubtasks.add(task.id);
        collapsedTaskSubtasks.delete(task.id);
        await saveChecklist(task, [...normalizedChecklist(task), {
          id: crypto.randomUUID(),
          text,
          done: false,
          completionLog: [],
        }]);
        input.value = "";
      } catch (error) {
        console.error("تعذّرت إضافة المهمة الفرعية:", error);
        setStatus(error.message, true);
      }
      return;
    }
    const form = event.target.closest("#task-editor-form");
    if (!form) return;
    event.preventDefault();
    const task = records.tasks.find((item) => item.id === form.elements.id.value);
    if (!task) {
      setStatus("لم تعد المهمة موجودة. حدّث الصفحة وحاول مجدداً.", true);
      return;
    }
    const keyResultId = form.elements.keyResultId.value || null;
    const keyResult = records.keyResults.find((item) => item.id === keyResultId);
    const objectiveId = form.elements.objectiveId.value || keyResult?.objectiveId || null;
    if (keyResult?.objectiveId && objectiveId !== keyResult.objectiveId) {
      setStatus("النتيجة الرئيسية المحددة لا تتبع الهدف المختار.", true);
      return;
    }
    const priority = Number(form.elements.priority.value);
    const manualMinutes = Number(form.elements.timeLogTodayMin.value || 0);
    if (!Number.isInteger(manualMinutes) || manualMinutes < 0 || manualMinutes > 1440) {
      setStatus("أدخل وقتاً صحيحاً بين 0 و1440 دقيقة.", true);
      return;
    }
    const scheduledInput = form.elements.scheduled.value || null;
    const dueInput = form.elements.due.value || null;
    const spreadAcrossPeriod = form.elements.spreadAcrossPeriod.checked;
    if (spreadAcrossPeriod && (!scheduledInput || !dueInput)) {
      setStatus("حدّد تاريخ الجدولة والاستحقاق لتفعيل المهمة الممتدة على فترة.", true);
      return;
    }
    const datesWereLinked = !spreadAcrossPeriod && Boolean(task.scheduled && task.scheduled === task.due);
    const scheduledChanged = scheduledInput !== (task.scheduled || null);
    const dueChanged = dueInput !== (task.due || null);
    let scheduled = scheduledInput;
    let due = dueInput;
    if (datesWereLinked && scheduledChanged && !dueChanged) due = scheduled;
    if (datesWereLinked && dueChanged && !scheduledChanged) scheduled = due;
    try {
      const timeLog = Array.isArray(task.timeLog) ? [...task.timeLog] : [];
      if (manualMinutes > 0) {
        timeLog.push({ date: localDateString(), minutes: manualMinutes, createdAt: new Date().toISOString() });
      }
      const saveButton = form.querySelector('button[type="submit"]');
      saveButton.disabled = true;
      await update("tasks", {
        ...task,
        title: form.elements.title.value.trim(),
        notes: form.elements.notes.value.trim(),
        scheduled,
        due,
        spreadAcrossPeriod,
        dueTime: form.elements.dueTime.value || null,
        important: priority === 0 || priority === 1,
        urgent: priority === 0 || priority === 2,
        estimateMin: form.elements.estimateMin.value ? Number(form.elements.estimateMin.value) : null,
        timeLog,
        projectId: form.elements.projectId.value || null,
        objectiveId,
        lifeAreaId: form.elements.lifeAreaId.value || null,
        keyResultId,
        recurrence: form.elements.recurrence.value || null,
        tags: form.elements.tags.value.split(/[,،]/).map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean),
        updatedAt: new Date().toISOString(),
      });
      form.closest("dialog")?.close();
      setStatus("حُفظت تعديلات المهمة.");
    } catch (error) {
      console.error("تعذّر حفظ تعديلات المهمة:", error);
      setStatus(error.message, true);
    } finally {
      const saveButton = form.querySelector('button[type="submit"]');
      if (saveButton) saveButton.disabled = false;
    }
  }, { signal });

}

export async function mountTasksView(isCurrent = () => true) {
  if (unsubscribe) unsubscribe();
  const loadedRecords = {
    tasks: await getRecords("tasks"),
    habits: await getRecords("habits"),
    projects: await getRecords("projects"),
    objectives: await getRecords("objectives"),
    keyResults: await getRecords("keyResults"),
    lifeAreas: await ensureDefaultLifeAreas(),
  };
  if (!isCurrent()) return;
  records = loadedRecords;
  document.querySelector("#page-title").textContent = "المهام";
  render();
  unsubscribe = subscribe((state, change) => {
    if (!change.storeName || ["tasks", "habits", "projects", "objectives", "keyResults", "lifeAreas"].includes(change.storeName)) {
      records = {
        ...records,
        tasks: state.tasks ?? records.tasks,
        habits: state.habits ?? records.habits,
        projects: state.projects ?? records.projects,
        objectives: state.objectives ?? records.objectives,
        keyResults: state.keyResults ?? records.keyResults,
        lifeAreas: state.lifeAreas ?? records.lifeAreas,
      };
      const editorDialog = document.querySelector("#task-dialog");
      if (change.storeName === "projects" && editorDialog?.open) {
        const projectSelect = editorDialog.querySelector('#task-editor-form [name="projectId"]');
        if (projectSelect) {
          const selectedProjectId = projectSelect.value;
          projectSelect.innerHTML = `<option value="">الوارد</option>${records.projects.filter((project) => !project.archived).map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("")}`;
          projectSelect.value = selectedProjectId;
        }
        return;
      }
      if (change.storeName === "tasks" && editorDialog?.open && editorSubtasksPending) {
        const taskId = editorDialog.querySelector('#task-editor-form [name="id"]')?.value;
        const task = records.tasks.find((item) => item.id === taskId);
        const subtasks = editorDialog.querySelector("#task-editor-subtasks");
        if (task && subtasks) {
          subtasks.innerHTML = subtasksBlock(task);
          return;
        }
      }
      if (editorDialog?.open) return;
      if (window.location.hash.startsWith("#/tasks")) render();
    }
  });
}

export function unmountTasksView() {
  unsubscribe?.();
  unsubscribe = undefined;
  eventController?.abort();
  eventController = undefined;
  expandedTaskDetails.clear();
  expandedTaskSubtasks.clear();
}

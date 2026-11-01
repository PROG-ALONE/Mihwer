import { STORE_NAMES, getAllData, replaceAllData } from "../db.js";
import { getRecords, add, update } from "../store.js";
import { getPlanConfig, getObjectivePeriod, setObjectivePeriod } from "../utils/plans.js";
import { logSync, syncAll, testGitHubConnection } from "../sync.js";
import { showToast } from "../utils/notifications.js";

const BACKUP_VERSION = 1;

function withoutCredentials(value) {
  if (Array.isArray(value)) return value.map(withoutCredentials);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(token|secret|password|credential)/i.test(key))
    .map(([key, child]) => [key, withoutCredentials(child)]));
}

function setStatus(message, isError = false) {
  showToast(message, { isError });
  const status = document.querySelector("#settings-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = isError ? "error" : "success";
}

async function exportBackup() {
  const data = await getAllData();
  const backup = {
    app: "mihwar",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    stores: withoutCredentials(data),
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `mihwar-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("تم تنزيل النسخة الاحتياطية بنجاح.");
}

function parseBackup(text) {
  let backup;
  try {
    backup = JSON.parse(text);
  } catch {
    throw new Error("الملف ليس JSON صالحاً.");
  }
  if (backup?.app !== "mihwar" || backup.version !== BACKUP_VERSION || !backup.stores || typeof backup.stores !== "object") {
    throw new Error("صيغة النسخة غير مدعومة أو لا تخص مِحوَر.");
  }
  for (const [storeName, records] of Object.entries(backup.stores)) {
    if (!STORE_NAMES.includes(storeName) || !Array.isArray(records)) {
      throw new Error("تحتوي النسخة على مخزن غير معروف أو بيانات غير صالحة.");
    }
    if (records.some((record) => !record || typeof record !== "object" || record.id === undefined || record.id === null)) {
      throw new Error(`تحتوي بيانات ${storeName} على سجل بلا معرّف صالح.`);
    }
  }
  return Object.fromEntries(STORE_NAMES.map((storeName) => [
    storeName,
    withoutCredentials(backup.stores[storeName] ?? []),
  ]));
}

async function importBackup(file) {
  if (!file) return;
  const importedData = parseBackup(await file.text());
  if (!window.confirm("سيستبدل الاستيراد كل البيانات الحالية على هذا الجهاز. هل تريد المتابعة؟")) {
    setStatus("أُلغي استيراد البيانات.");
    return;
  }
  await replaceAllData(importedData);
  setStatus("تم استيراد البيانات بنجاح. أعد تحميل الصفحة لتحديث العرض.");
  window.dispatchEvent(new CustomEvent("mihwar:data-imported"));
}

export function bindSettingsActions() {
  const refreshSyncPanel = async () => {
    const [profiles, logs] = await Promise.all([getRecords("profile"), getRecords("syncLog")]);
    const profile = profiles.find((item) => item.id === "user") ?? profiles[0];
    const gistStatus = document.querySelector("#gist-status");
    const gistLink = document.querySelector('[data-action="copy-gist"]');
    const logsElement = document.querySelector("#sync-log-list");
    if (gistStatus) gistStatus.textContent = profile?.gistId ? `مرتبط بـ Gist خاص · ${profile.gistId}` : "لا يوجد Gist مرتبط.";
    if (gistLink) {
      gistLink.hidden = !profile?.gistId;
      gistLink.dataset.gistUrl = profile?.gistId ? `https://gist.github.com/${profile.gistId}` : "";
    }
    if (logsElement) {
      logsElement.innerHTML = logs.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5).map((entry) =>
        `<div class="sync-log-row"><span>${entry.status === "success" ? "✓" : "!"}</span><strong>${entry.action === "sync" ? "مزامنة" : "اتصال"}</strong><time>${new Intl.DateTimeFormat("ar", { hour: "numeric", minute: "2-digit" }).format(new Date(entry.timestamp))}</time><span>${entry.status === "success" ? `${entry.recordsCount} سجل` : "تعذّرت"}</span></div>`).join("");
    }
  };

  const planSelect = document.querySelector("#active-plan");
  const planInfo = document.querySelector("#plan-info");
  if (planSelect) {
    const loadPlan = async () => {
      try {
        const profiles = await getRecords("profile");
        const profile = profiles.find((item) => item.id === "user") ?? profiles[0];
        const config = getPlanConfig(profile?.activePlan);
        planSelect.value = config.id;
        planInfo.textContent = `المراجعة المقترحة كل ${config.id === "monthly" ? 30 : config.id === "trimester" ? 120 : 90} يوماً · ${config.columns.length} أعمدة`;
      } catch (error) {
        console.error("تعذّر تحميل خطة التخطيط:", error);
        setStatus(`تعذّر تحميل الخطة: ${error.message}`, true);
      }
    };
    loadPlan();
    planSelect.addEventListener("change", async () => {
      const nextPlan = getPlanConfig(planSelect.value);
      try {
        const profiles = await getRecords("profile");
        const profile = profiles.find((item) => item.id === "user") ?? profiles[0];
        const previousPlan = getPlanConfig(profile?.activePlan);
        if (nextPlan.id !== previousPlan.id) {
          const objectives = await getRecords("objectives");
          for (const objective of objectives) {
            const oldPeriod = getObjectivePeriod(objective, previousPlan);
            const nextPeriod = Math.min(nextPlan.columns.length, Math.floor(((oldPeriod - 1) / previousPlan.columns.length) * nextPlan.columns.length) + 1);
            const adjusted = setObjectivePeriod(objective, nextPlan, nextPeriod);
            await update("objectives", { ...adjusted, updatedAt: new Date().toISOString() });
          }
        }
        const updatedProfile = {
          ...(profile ?? {}),
          id: profile?.id ?? "user",
          activePlan: nextPlan.id,
          createdAt: profile?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        if (profile) await update("profile", updatedProfile);
        else await add("profile", updatedProfile);
        planInfo.textContent = `المراجعة المقترحة كل ${nextPlan.id === "monthly" ? 30 : nextPlan.id === "trimester" ? 120 : 90} يوماً · ${nextPlan.columns.length} أعمدة`;
        setStatus("تمّ تبديل الخطة. ستظهر المصفوفة بالأعمدة الجديدة عند فتح الأهداف.");
      } catch (error) {
        console.error("تعذّر تغيير خطة التخطيط:", error);
        setStatus(`تعذّر تغيير الخطة: ${error.message}`, true);
        await loadPlan();
      }
    });
  }

  refreshSyncPanel().catch((error) => {
    console.error("تعذّر تحميل إعدادات المزامنة:", error);
    setStatus(`تعذّر تحميل حالة المزامنة: ${error.message}`, true);
  });

  const syncButton = document.querySelector('[data-action="sync-now"]');
  const githubStatus = document.querySelector("#github-status");
  async function loadProfile() {
    const profiles = await getRecords("profile");
    return profiles.find((item) => item.id === "user") ?? profiles[0] ?? null;
  }

  document.querySelector('[data-action="save-token"]')?.addEventListener("click", async () => {
    const input = document.querySelector("#github-token");
    const token = input.value.trim();
    if (!token) {
      setStatus("أدخل توكن GitHub أولاً.", true);
      return;
    }
    try {
      const profile = await loadProfile();
      const now = new Date().toISOString();
      const saved = {
        ...(profile ?? {}),
        id: profile?.id ?? "user",
        githubToken: token,
        deviceId: profile?.deviceId ?? crypto.randomUUID(),
        deviceIds: profile?.deviceIds ?? [],
        createdAt: profile?.createdAt ?? now,
        updatedAt: now,
      };
      if (profile) await update("profile", saved);
      else await add("profile", saved);
      input.value = "";
      input.placeholder = "توكن محفوظ على هذا الجهاز";
      setStatus("حُفظ التوكن محلياً. لا يُضمّن في النسخ الاحتياطية.");
    } catch (error) {
      console.error("تعذّر حفظ توكن GitHub:", error);
      setStatus(`تعذّر حفظ التوكن: ${error.message}`, true);
    }
  });

  document.querySelector('[data-action="test-github"]')?.addEventListener("click", async () => {
    const button = document.querySelector('[data-action="test-github"]');
    button.disabled = true;
    try {
      const profile = await loadProfile();
      const token = document.querySelector("#github-token").value.trim() || profile?.githubToken;
      const result = await testGitHubConnection(token ?? "");
      if (githubStatus) githubStatus.textContent = `متصل بحساب GitHub: ${result.login}`;
      await logSync("connection", "success");
      await refreshSyncPanel();
    } catch (error) {
      console.error("تعذّر اختبار اتصال GitHub:", error);
      if (githubStatus) githubStatus.textContent = error.message;
      await logSync("connection", "error", 0, error.message).catch((logError) => {
        console.error("تعذّر تسجيل محاولة الاتصال:", logError);
      });
      await refreshSyncPanel().catch((refreshError) => console.error("تعذّر تحديث سجل الاتصال:", refreshError));
    } finally {
      button.disabled = false;
    }
  });

  syncButton?.addEventListener("click", async () => {
    syncButton.disabled = true;
    if (githubStatus) githubStatus.textContent = "جارٍ مزامنة بياناتك…";
    try {
      const profile = await loadProfile();
      if (!profile?.githubToken) throw new Error("أدخل توكن GitHub واحفظه قبل المزامنة.");
      const result = await syncAll(profile);
      await logSync("sync", "success", result.recordsCount);
      if (githubStatus) githubStatus.textContent = `تمت المزامنة بنجاح · ${new Intl.DateTimeFormat("ar", { hour: "numeric", minute: "2-digit" }).format(new Date())}`;
      await refreshSyncPanel();
      window.dispatchEvent(new CustomEvent("mihwar:data-imported"));
    } catch (error) {
      console.error("تعذّرت مزامنة GitHub:", error);
      if (githubStatus) githubStatus.textContent = `تعذّرت المزامنة: ${error.message}`;
      await logSync("sync", "error", 0, error.message).catch((logError) => {
        console.error("تعذّر تسجيل فشل المزامنة:", logError);
      });
      await refreshSyncPanel().catch((refreshError) => console.error("تعذّر تحديث سجل المزامنة:", refreshError));
    } finally {
      syncButton.disabled = false;
    }
  });

  document.querySelector('[data-action="copy-gist"]')?.addEventListener("click", async (event) => {
    const url = event.currentTarget.dataset.gistUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setStatus("نُسخ رابط Gist. يحتاج الجهاز الآخر إلى توكن GitHub للوصول إليه.");
    } catch (error) {
      console.error("تعذّر نسخ رابط Gist:", error);
      setStatus(`تعذّر النسخ: ${error.message}`, true);
    }
  });

  const focusForm = document.querySelector("#focus-settings-form");
  if (focusForm) {
    getRecords("profile").then((profiles) => {
      const profile = profiles.find((item) => item.id === "user") ?? profiles[0];
      const focusSettings = profile?.focusSettings ?? {};
      focusForm.elements.focusDurationMin.value = focusSettings.focusDurationMin ?? 25;
      focusForm.elements.shortBreakMin.value = focusSettings.shortBreakMin ?? 5;
      focusForm.elements.longBreakMin.value = focusSettings.longBreakMin ?? 15;
    }).catch((error) => {
      console.error("تعذّر تحميل مدد التركيز:", error);
      setStatus(`تعذّر تحميل مدد التركيز: ${error.message}`, true);
    });
    focusForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const profiles = await getRecords("profile");
        const profile = profiles.find((item) => item.id === "user") ?? profiles[0];
        const now = new Date().toISOString();
        const updatedProfile = {
          ...(profile ?? {}),
          id: profile?.id ?? "user",
          focusSettings: {
            focusDurationMin: Number(focusForm.elements.focusDurationMin.value),
            shortBreakMin: Number(focusForm.elements.shortBreakMin.value),
            longBreakMin: Number(focusForm.elements.longBreakMin.value),
          },
          createdAt: profile?.createdAt ?? now,
          updatedAt: now,
        };
        if (profile) await update("profile", updatedProfile);
        else await add("profile", updatedProfile);
        setStatus("حُفظت مدد التركيز.");
      } catch (error) {
        console.error("تعذّر حفظ مدد التركيز:", error);
        setStatus(`تعذّر حفظ مدد التركيز: ${error.message}`, true);
      }
    });
  }

  document.querySelector("#export-data")?.addEventListener("click", async () => {
    try {
      await exportBackup();
    } catch (error) {
      console.error("تعذّر تصدير البيانات:", error);
      setStatus(`تعذّر التصدير: ${error.message}`, true);
    }
  });

  document.querySelector("#import-file")?.addEventListener("change", async (event) => {
    const input = event.currentTarget;
    try {
      await importBackup(input.files?.[0]);
    } catch (error) {
      console.error("تعذّر استيراد البيانات:", error);
      setStatus(`تعذّر الاستيراد: ${error.message}`, true);
    } finally {
      input.value = "";
    }
  });
}

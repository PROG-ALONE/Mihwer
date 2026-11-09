import { showToast } from "../utils/notifications.js";

function reportText({ title, period, summary = [], sections = [] }) {
  const lines = [
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `مِحوَر | ${title}`,
    `الفترة: ${period}`,
    `أُعدّ في: ${new Date().toLocaleString("ar")}`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  ];
  if (summary.length) {
    lines.push("", "الملخص", ...summary.map((item) => typeof item === "string"
      ? `• ${item}`
      : `• ${item.label}: ${item.value}${item.detail ? ` · ${item.detail}` : ""}`));
  }
  for (const section of sections) {
    lines.push("", section.title);
    if (!section.items.length) {
      lines.push("لا توجد سجلات.");
      continue;
    }
    for (const item of section.items) {
      if (typeof item === "string") {
        lines.push(`• ${item}`);
        continue;
      }
      lines.push(`• ${item.title}${item.detail ? ` — ${item.detail}` : ""}`);
      for (const detail of item.details ?? []) {
        lines.push(`  - ${typeof detail === "string" ? detail : `${detail.label}: ${detail.value}`}`);
      }
    }
  }
  return lines.join("\n");
}

function downloadReportFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function shareTextReport(report) {
  const text = reportText(report);
  const slug = report.title.replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/^-|-$/g, "").slice(0, 48) || "report";
  const filename = `mihwar-${slug}-${new Date().toISOString().slice(0, 10)}.txt`;
  const file = new File([text], filename, { type: "text/plain;charset=utf-8" });
  if (navigator.share) {
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: report.title, text: `تقرير ${report.title} من مِحوَر`, files: [file] });
      } else {
        await navigator.share({ title: report.title, text });
      }
      showToast("تم تجهيز التقرير للمشاركة.");
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error("تعذّرت مشاركة التقرير:", error);
    }
  }

  try {
    if (!navigator.clipboard?.writeText) throw new Error("ميزة نسخ التقرير غير متاحة في هذا المتصفح.");
    await navigator.clipboard.writeText(text);
    showToast("نُسخ التقرير المرتب. الصقه في رسالة للشخص الذي تريده.");
  } catch (error) {
    console.error("تعذّر نسخ التقرير:", error);
    try {
      downloadReportFile(file);
      showToast("تعذّرت المشاركة المباشرة؛ حُمّل التقرير لإرفاقه برسالتك.");
    } catch (downloadError) {
      console.error("تعذّر تنزيل التقرير:", downloadError);
      showToast(`تعذّر تجهيز التقرير: ${downloadError.message}`, { isError: true });
    }
  }
}

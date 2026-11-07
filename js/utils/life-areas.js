import { getRecords, update } from "../store.js";

export const DEFAULT_LIFE_AREAS = [
  { id: "mihwar-area-religion", name: "الدين", color: "#8b69c8" },
  { id: "mihwar-area-health", name: "الصحة", color: "#16a889" },
  { id: "mihwar-area-work", name: "العمل", color: "#6258d9" },
  { id: "mihwar-area-relationships", name: "العائلة والعلاقات", color: "#c05d7a" },
  { id: "mihwar-area-finances", name: "المال", color: "#d28a36" },
  { id: "mihwar-area-learning", name: "التعلّم", color: "#4d84c4" },
  { id: "mihwar-area-growth", name: "النمو الشخصي", color: "#75854e" },
];

export async function ensureDefaultLifeAreas() {
  const areas = await getRecords("lifeAreas");
  const missingAreas = DEFAULT_LIFE_AREAS.filter((area) => !areas.some((existing) => existing.id === area.id));
  if (!missingAreas.length) return areas;
  const now = new Date().toISOString();
  const additions = missingAreas.map((area, index) => ({
    ...area,
    icon: "◎",
    order: areas.length + index,
    archived: false,
    createdAt: now,
    updatedAt: now,
  }));
  await Promise.all(additions.map((area) => update("lifeAreas", area)));
  return [...areas, ...additions];
}

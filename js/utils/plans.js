export const PLAN_CONFIGS = {
  quarterly: {
    id: "quarterly",
    name: "ربع سنوي",
    columnType: "quarters",
    columns: ["Q1", "Q2", "Q3", "Q4"],
  },
  monthly: {
    id: "monthly",
    name: "شهري",
    columnType: "months",
    columns: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  },
  trimester: {
    id: "trimester",
    name: "ثلاثي (100)",
    columnType: "trimesters",
    columns: ["T1", "T2", "T3"],
  },
};

export function getPlanConfig(planId) {
  return PLAN_CONFIGS[planId] ?? PLAN_CONFIGS.quarterly;
}

export function getObjectivePeriod(objective, plan) {
  const period = Number(objective.period ?? objective.quarter);
  if (Number.isInteger(period) && period >= 1 && period <= plan.columns.length) return period;
  if (Number.isInteger(period) && plan.id === "quarterly" && period >= 1 && period <= 4) return period;
  if (Number.isInteger(period) && plan.id === "monthly" && period >= 1 && period <= 12) return period;
  if (Number.isInteger(period) && plan.id === "trimester" && period >= 1 && period <= 3) return period;
  return 1;
}

export function setObjectivePeriod(objective, plan, period) {
  if (plan.id === "quarterly") return { ...objective, quarter: period, period };
  return { ...objective, period };
}

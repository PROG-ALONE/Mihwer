export function getKeyResultProgress(keyResult) {
  const start = Number(keyResult.start ?? 0);
  const current = Number(keyResult.current ?? start);
  const target = Number(keyResult.target ?? 0);
  if (![start, current, target].every(Number.isFinite) || target === start) return 0;
  return Math.round(Math.max(0, Math.min(100, ((current - start) / (target - start)) * 100)));
}

export function getObjectiveProgress(objective, keyResults) {
  const results = keyResults.filter((result) => result.objectiveId === objective.id);
  if (!results.length) return 0;
  return Math.round(results.reduce((total, result) => total + getKeyResultProgress(result), 0) / results.length);
}

export function getObjectiveStatus(objective, keyResults) {
  if (objective.status === "blocked" || objective.status === "at-risk" || objective.status === "done") {
    return objective.status;
  }
  if (!keyResults.some((result) => result.objectiveId === objective.id)) return "on-track";
  const progress = getObjectiveProgress(objective, keyResults);
  return progress < 25 ? "at-risk" : "on-track";
}

/**
 * Selects the candidate spans worth optimizing during placement.
 * Pure function — does not mutate the input array.
 */
export function selectActivePlacementSpans(
  spans,
  { useCandidatePlacement, priorityRatio },
) {
  if (!useCandidatePlacement || spans.length <= 1 || priorityRatio <= 0) {
    return spans;
  }

  const topPriority = spans[0].priority;
  if (topPriority <= 0) {
    return spans;
  }

  const minPriority = priorityRatio * topPriority;
  const activeSpans = spans.filter(span => span.priority >= minPriority);

  return activeSpans.length > 0 ? activeSpans : [spans[0]];
}

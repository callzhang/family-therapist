export function snapshotSequence(snapshot) {
  const value = snapshot?.snapshot_seq;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

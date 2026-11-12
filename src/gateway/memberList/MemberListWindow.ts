import type { MemberListOp, MemberListRow } from "./MemberListState.ts";

export interface RowRange {
  start: number;
  end: number;
}

export type WindowOp =
  | { op: "INSERT"; index: number; row?: MemberListRow }
  | { op: "DELETE"; index: number }
  | { op: "UPDATE"; index: number; row: MemberListRow };

export interface WindowPlan {
  ops: WindowOp[];
  fillIndexes: number[];
}

export interface WindowPlanOptions {
  windowRanges: RowRange[];
  keepRanges: RowRange[];
  rowCountBefore: number;
  rowCountAfter: number;
}

export function chunksToRanges(
  chunks: Iterable<number>,
  chunkSize: number,
): RowRange[] {
  return [...chunks]
    .sort((left, right) => left - right)
    .map((chunk) => ({
      start: chunk * chunkSize,
      end: (chunk + 1) * chunkSize,
    }));
}

function inRanges(index: number, ranges: RowRange[]) {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function indexesIn(ranges: RowRange[], rowCount: number) {
  const indexes: number[] = [];
  for (const range of ranges)
    for (
      let index = range.start;
      index < Math.min(range.end, rowCount);
      index++
    )
      indexes.push(index);
  return indexes;
}

export function planWindowOps(
  ops: MemberListOp[],
  options: WindowPlanOptions,
): WindowPlan {
  const { windowRanges, keepRanges, rowCountBefore, rowCountAfter } = options;
  let loaded = indexesIn(windowRanges, rowCountBefore);
  const planned: WindowOp[] = [];

  for (const operation of ops) {
    const { index } = operation;
    const lastLoaded = loaded.length ? loaded[loaded.length - 1] : -1;
    const touchesLoaded = lastLoaded >= index;

    if (operation.op === "INSERT") {
      const inWindow = inRanges(index, windowRanges);
      if (!touchesLoaded && !inWindow) continue;

      loaded = loaded.map((loadedIndex) =>
        loadedIndex >= index ? loadedIndex + 1 : loadedIndex,
      );

      if (inWindow) {
        loaded.push(index);
        loaded.sort((left, right) => left - right);
        planned.push({ op: "INSERT", index, row: operation.item });
      } else {
        planned.push({ op: "INSERT", index });
      }
    } else if (operation.op === "DELETE") {
      if (!touchesLoaded) continue;

      loaded = loaded
        .filter((loadedIndex) => loadedIndex !== index)
        .map((loadedIndex) =>
          loadedIndex > index ? loadedIndex - 1 : loadedIndex,
        );
      planned.push({ op: "DELETE", index });
    } else if (loaded.includes(index)) {
      planned.push({ op: "UPDATE", index, row: operation.item });
    }
  }

  const loadedIndexes = new Set(loaded);
  const fillIndexes = indexesIn(keepRanges, rowCountAfter).filter(
    (index) => !loadedIndexes.has(index),
  );

  return { ops: planned, fillIndexes };
}

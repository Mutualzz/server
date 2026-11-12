import type { Snowflake } from "@mutualzz/types";

export const ONLINE_GROUP_ID = "online";
export const OFFLINE_GROUP_ID = "offline";

export interface MemberListEntry {
  userId: Snowflake;
  name: string;
  roleIds: Snowflake[];
  online: boolean;
}

export interface MemberListRole {
  id: Snowflake;
  position: number;
  hoist: boolean;
}

export type MemberListRow =
  | { type: "group"; id: string }
  | { type: "member"; userId: Snowflake };

export type MemberListOp =
  | { op: "INSERT"; index: number; item: MemberListRow }
  | { op: "DELETE"; index: number }
  | { op: "UPDATE"; index: number; item: MemberListRow };

export interface MemberListGroup {
  id: string;
  count: number;
}

export interface MemberListStateOptions {
  hideOffline: boolean;
}

const nameCollator = new Intl.Collator("en", { sensitivity: "base" });

export function compareSnowflakes(left: Snowflake, right: Snowflake) {
  if (left.length !== right.length) return left.length - right.length;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function compareEntries(left: MemberListEntry, right: MemberListEntry) {
  return (
    nameCollator.compare(left.name, right.name) ||
    compareSnowflakes(left.userId, right.userId)
  );
}

export class MemberListState {
  private readonly entries = new Map<Snowflake, MemberListEntry>();
  private readonly groupCounts = new Map<string, number>();
  private roles = new Map<Snowflake, MemberListRole>();
  private groupOrder: string[] = [];
  private rows: MemberListRow[] = [];
  private options: MemberListStateOptions;

  constructor(
    roles: MemberListRole[],
    entries: MemberListEntry[],
    options: MemberListStateOptions,
  ) {
    this.options = options;
    this.rebuild(roles, entries, options);
  }

  get rowCount() {
    return this.rows.length;
  }

  get groups(): MemberListGroup[] {
    return this.groupOrder
      .map((groupId) => ({
        id: groupId,
        count: this.groupCounts.get(groupId) ?? 0,
      }))
      .filter((group) => group.count > 0);
  }

  slice(start: number, end: number) {
    return this.rows.slice(start, end);
  }

  has(userId: Snowflake) {
    return this.entries.has(userId);
  }

  indexOf(userId: Snowflake) {
    const entry = this.entries.get(userId);
    if (!entry) return -1;
    return this.findIndex(entry);
  }

  rebuild(
    roles: MemberListRole[],
    entries: MemberListEntry[],
    options: MemberListStateOptions = this.options,
  ) {
    this.options = options;
    this.roles = new Map(roles.map((role) => [role.id, role]));
    this.groupOrder = [
      ...roles
        .filter((role) => role.hoist)
        .sort(
          (left, right) =>
            right.position - left.position ||
            compareSnowflakes(left.id, right.id),
        )
        .map((role) => role.id),
      ONLINE_GROUP_ID,
      OFFLINE_GROUP_ID,
    ];

    this.entries.clear();
    this.groupCounts.clear();

    const membersByGroup = new Map<string, MemberListEntry[]>();
    for (const entry of entries) {
      if (this.isHidden(entry)) continue;
      this.entries.set(entry.userId, entry);
      const groupId = this.groupFor(entry);
      const groupMembers = membersByGroup.get(groupId) ?? [];
      groupMembers.push(entry);
      membersByGroup.set(groupId, groupMembers);
    }

    this.rows = [];
    for (const groupId of this.groupOrder) {
      const groupMembers = membersByGroup.get(groupId);
      if (!groupMembers?.length) continue;
      groupMembers.sort(compareEntries);
      this.groupCounts.set(groupId, groupMembers.length);
      this.rows.push({ type: "group", id: groupId });
      for (const groupMember of groupMembers)
        this.rows.push({ type: "member", userId: groupMember.userId });
    }
  }

  upsertMember(entry: MemberListEntry): MemberListOp[] {
    const previous = this.entries.get(entry.userId);

    if (
      previous &&
      !this.isHidden(entry) &&
      this.groupFor(previous) === this.groupFor(entry) &&
      compareEntries(previous, entry) === 0
    ) {
      this.entries.set(entry.userId, entry);
      return [
        {
          op: "UPDATE",
          index: this.findIndex(entry),
          item: { type: "member", userId: entry.userId },
        },
      ];
    }

    return [...this.removeMember(entry.userId), ...this.insertMember(entry)];
  }

  removeMember(userId: Snowflake): MemberListOp[] {
    const entry = this.entries.get(userId);
    if (!entry) return [];

    const groupId = this.groupFor(entry);
    const groupStart = this.groupStart(groupId);
    const count = this.groupCounts.get(groupId) ?? 0;
    const index =
      groupStart + 1 + this.lowerBound(entry, groupStart + 1, count);

    this.rows.splice(index, 1);
    this.entries.delete(userId);
    const ops: MemberListOp[] = [{ op: "DELETE", index }];

    if (count === 1) {
      this.rows.splice(groupStart, 1);
      this.groupCounts.delete(groupId);
      ops.push({ op: "DELETE", index: groupStart });
    } else {
      this.groupCounts.set(groupId, count - 1);
    }

    return ops;
  }

  private insertMember(entry: MemberListEntry): MemberListOp[] {
    if (this.isHidden(entry)) return [];

    const groupId = this.groupFor(entry);
    const groupStart = this.groupStart(groupId);
    const count = this.groupCounts.get(groupId) ?? 0;
    const ops: MemberListOp[] = [];

    if (count === 0) {
      const header: MemberListRow = { type: "group", id: groupId };
      this.rows.splice(groupStart, 0, header);
      ops.push({ op: "INSERT", index: groupStart, item: header });
    }

    const index =
      groupStart + 1 + this.lowerBound(entry, groupStart + 1, count);
    const row: MemberListRow = { type: "member", userId: entry.userId };
    this.rows.splice(index, 0, row);
    this.entries.set(entry.userId, entry);
    this.groupCounts.set(groupId, count + 1);
    ops.push({ op: "INSERT", index, item: row });

    return ops;
  }

  private findIndex(entry: MemberListEntry) {
    const groupId = this.groupFor(entry);
    const groupStart = this.groupStart(groupId);
    const count = this.groupCounts.get(groupId) ?? 0;
    return groupStart + 1 + this.lowerBound(entry, groupStart + 1, count);
  }

  private lowerBound(
    entry: MemberListEntry,
    firstMemberIndex: number,
    count: number,
  ) {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareEntries(this.entryAt(firstMemberIndex + middle), entry) < 0)
        low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private entryAt(index: number) {
    const row = this.rows[index];
    const entry =
      row?.type === "member" ? this.entries.get(row.userId) : undefined;
    if (!entry) throw new Error(`MemberListState: no member at row ${index}`);
    return entry;
  }

  private groupStart(groupId: string) {
    let index = 0;
    for (const orderedGroupId of this.groupOrder) {
      if (orderedGroupId === groupId) return index;
      const count = this.groupCounts.get(orderedGroupId) ?? 0;
      if (count > 0) index += count + 1;
    }
    return index;
  }

  private groupFor(entry: MemberListEntry) {
    if (!entry.online) return OFFLINE_GROUP_ID;

    let highestRole: MemberListRole | undefined;
    for (const roleId of entry.roleIds) {
      const role = this.roles.get(roleId);
      if (!role?.hoist) continue;
      if (
        !highestRole ||
        role.position > highestRole.position ||
        (role.position === highestRole.position &&
          compareSnowflakes(role.id, highestRole.id) < 0)
      )
        highestRole = role;
    }

    return highestRole?.id ?? ONLINE_GROUP_ID;
  }

  private isHidden(entry: MemberListEntry) {
    return this.options.hideOffline && !entry.online;
  }
}

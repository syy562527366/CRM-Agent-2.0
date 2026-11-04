import type { Communication } from "@/types/communication";
import { nextId, readJson, writeJson } from "./store";

const FILE = "communications.json";

export interface CommunicationFilter {
  leadId?: string;
  leadIds?: string[];
  senderRole?: "销售" | "客户" | "";
  channel?: string;
  startDate?: string;
  endDate?: string;
}

export function readCommunications(): Communication[] {
  return readJson<Communication>(FILE);
}

export function writeCommunications(rows: Communication[]): void {
  writeJson(FILE, rows);
}

export function findCommunication(id: string): Communication | undefined {
  return readCommunications().find((row) => row.id === id);
}

export function searchCommunications(filter: CommunicationFilter = {}): Communication[] {
  const dayOf = (value?: string) => (value ? value.split(" ")[0] : "");
  const rows = readCommunications().filter((row) => {
    if (filter.leadId && row.leadId !== filter.leadId) return false;
    if (filter.leadIds && !filter.leadIds.includes(row.leadId)) return false;
    if (filter.senderRole && row.senderRole !== filter.senderRole) return false;
    if (filter.channel && row.channel !== filter.channel.trim()) return false;
    if (filter.startDate && dayOf(row.sentAt) < filter.startDate) return false;
    if (filter.endDate && dayOf(row.sentAt) > filter.endDate) return false;
    return true;
  });

  // 倒序：列表页文案是「按时间倒序展示」，Agent 的时间线工具取前 N 条也应当是「最近 N 条」
  return rows.sort((a, b) => String(b.sentAt ?? "").localeCompare(String(a.sentAt ?? "")));
}

/** 按线索分组统计沟通次数，线索列表页的「沟通次数」由此派生 */
export function countByLead(rows: Communication[] = readCommunications()): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.leadId] = (acc[row.leadId] ?? 0) + 1;
    return acc;
  }, {});
}

export function createCommunication(input: Omit<Communication, "id">): Communication {
  const rows = readCommunications();
  const row: Communication = { id: nextId(rows, "COMM-2026-"), ...input };
  rows.unshift(row);
  writeCommunications(rows);
  return row;
}

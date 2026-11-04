import type { Lead, Priority } from "@/types/lead";
import { nextId, nowStamp, readJson, writeJson } from "./store";

const FILE = "leads.json";

export interface LeadFilter {
  /** 创建日期区间（YYYY-MM-DD，闭区间） */
  dateFrom?: string;
  dateTo?: string;
  /** 姓名模糊 */
  name?: string;
  /** 手机号模糊 */
  phone?: string;
  /** 来源精确 */
  source?: string;
  /** 优先级 */
  priority?: Priority | "";
  /** 状态精确匹配（支持多选） */
  status?: string[];
  /** 负责人精确（数据范围「仅自己」时由上层强制注入） */
  assignee?: string;
  /** 编号 / 姓名 / 手机号模糊 */
  keyword?: string;
  sort?: "createdAt" | "lastFollowUpAt" | "communicationCount";
  order?: "asc" | "desc";
}

export function readLeads(): Lead[] {
  return readJson<Lead>(FILE);
}

export function writeLeads(leads: Lead[]): void {
  writeJson(FILE, leads);
}

export function findLead(id: string): Lead | undefined {
  return readLeads().find((lead) => lead.id === id);
}

/**
 * 线索检索。所有筛选在此统一实现，API 路由与 Agent 工具共用同一套语义。
 *
 * 注意 status 用**精确匹配**：状态里同时存在「长期未跟进」和「待跟进」，
 * 用 includes 会互相误命中。
 */
export function searchLeads(filter: LeadFilter = {}): Lead[] {
  const dayOf = (value?: string) => (value ? value.split(" ")[0] : "");
  const keyword = filter.keyword?.trim();

  const rows = readLeads().filter((lead) => {
    if (filter.dateFrom && dayOf(lead.createdAt) < filter.dateFrom) return false;
    if (filter.dateTo && dayOf(lead.createdAt) > filter.dateTo) return false;
    if (filter.name && !lead.name.includes(filter.name.trim())) return false;
    if (filter.phone && !lead.phone.includes(filter.phone.trim())) return false;
    if (filter.source && lead.source !== filter.source) return false;
    if (filter.priority && lead.priority !== filter.priority) return false;
    if (filter.status?.length && !filter.status.includes(String(lead.status ?? ""))) return false;
    if (filter.assignee && lead.assignee !== filter.assignee) return false;
    if (keyword) {
      const hit =
        lead.name.includes(keyword) ||
        lead.id.includes(keyword) ||
        lead.phone.includes(keyword);
      if (!hit) return false;
    }
    return true;
  });

  // 默认按创建时间倒序（最新的在前）；调用方显式传 sort 时以其为准
  const field = filter.sort ?? "createdAt";
  const direction = filter.order === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * direction;
    // createdAt / lastFollowUpAt 都是 "YYYY-MM-DD HH:mm" 格式，字典序即时间序
    return String(av ?? "").localeCompare(String(bv ?? "")) * direction;
  });
}

export function createLead(input: {
  name: string;
  phone: string;
  priority: Priority;
  source: string;
  assignee: string;
}): Lead {
  const leads = readLeads();
  const lead: Lead = {
    id: nextId(leads, "LD-2026-"),
    createdAt: nowStamp(),
    name: input.name.trim(),
    phone: input.phone.trim(),
    priority: input.priority,
    source: input.source,
    assignee: input.assignee,
  };
  leads.unshift(lead);
  writeLeads(leads);
  return lead;
}

export function updateLead(id: string, updates: Partial<Lead>): Lead | null {
  const leads = readLeads();
  const index = leads.findIndex((lead) => lead.id === id);
  if (index === -1) return null;
  leads[index] = { ...leads[index], ...updates, id };
  writeLeads(leads);
  return leads[index];
}

export function deleteLead(id: string): boolean {
  const leads = readLeads();
  const index = leads.findIndex((lead) => lead.id === id);
  if (index === -1) return false;
  leads.splice(index, 1);
  writeLeads(leads);
  return true;
}

/** 某个负责人名下所有线索 ID（数据范围「仅自己」时用于过滤沟通记录） */
export function leadIdsOfAssignee(assignee: string): string[] {
  return readLeads()
    .filter((lead) => lead.assignee === assignee)
    .map((lead) => lead.id);
}

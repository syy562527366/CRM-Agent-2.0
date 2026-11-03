import fs from "node:fs";
import path from "node:path";

/**
 * CRM JSON 数据文件读写。
 *
 * 只允许访问 data/ 下的 .json 文件（防路径穿越），
 * 写入采用「临时文件 + rename」保证原子性，避免并发写产生半截 JSON。
 */

const DATA_DIR = path.join(process.cwd(), "data");

export function dataPath(file: string): string {
  const safe = path.basename(file);
  if (!safe.endsWith(".json")) {
    throw new Error(`只允许访问 json 数据文件：${file}`);
  }
  return path.join(DATA_DIR, safe);
}

export function readJson<T>(file: string): T[] {
  try {
    const raw = fs.readFileSync(dataPath(file), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function writeJson<T>(file: string, rows: T[]): void {
  const target = dataPath(file);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), "utf-8");
  fs.renameSync(tmp, target);
}

/** 统一时间格式：YYYY-MM-DD HH:mm */
export function nowStamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}`
  );
}

/** 按现有最大序号生成下一个 ID，例如 OD-2026-0013 → OD-2026-0014 */
export function nextId(rows: { id: string }[], prefix: string, width = 4): string {
  const max = rows.reduce((acc, row) => {
    const matched = /(\d+)$/.exec(row.id);
    return matched ? Math.max(acc, Number(matched[1])) : acc;
  }, 0);
  return `${prefix}${String(max + 1).padStart(width, "0")}`;
}

/** 通用分页 */
export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function paginate<T>(rows: T[], page: number, pageSize: number): Paged<T> {
  const safePage = Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1);
  const safeSize = Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 10);
  const start = (safePage - 1) * safeSize;
  return {
    rows: rows.slice(start, start + safeSize),
    total: rows.length,
    page: safePage,
    pageSize: safeSize,
  };
}

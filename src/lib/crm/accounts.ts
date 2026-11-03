import type { Account } from "@/types/account";
import { nextId, nowStamp, readJson, writeJson } from "./store";

const FILE = "accounts.json";

export interface AccountFilter {
  startDate?: string;
  endDate?: string;
  phone?: string;
  name?: string;
  roleName?: string;
}

/** 对外返回的账号（去掉密码） */
export type SafeAccount = Omit<Account, "password">;

export function readAccounts(): Account[] {
  return readJson<Account>(FILE);
}

export function writeAccounts(accounts: Account[]): void {
  writeJson(FILE, accounts);
}

export function findAccount(id: string): Account | undefined {
  return readAccounts().find((account) => account.id === id);
}

export function findAccountByPhone(phone: string): Account | undefined {
  return readAccounts().find((account) => account.phone === phone);
}

export function toSafeAccount(account: Account): SafeAccount {
  const safe: SafeAccount = { ...account };
  delete (safe as Partial<Account>).password;
  return safe;
}

export function searchAccounts(filter: AccountFilter = {}): Account[] {
  const dayOf = (value?: string) => (value ? value.split(" ")[0] : "");
  return readAccounts().filter((account) => {
    if (filter.startDate && dayOf(account.createdAt) < filter.startDate) return false;
    if (filter.endDate && dayOf(account.createdAt) > filter.endDate) return false;
    if (filter.phone && !account.phone.includes(filter.phone.trim())) return false;
    if (filter.name && !account.name.includes(filter.name.trim())) return false;
    if (filter.roleName && !account.roleName.includes(filter.roleName.trim())) return false;
    return true;
  });
}

export function createAccount(input: { phone: string; name: string; roleId: string; roleName: string }): Account {
  const accounts = readAccounts();
  const account: Account = {
    id: nextId(accounts, "ACCT-2026-"),
    createdAt: nowStamp(),
    phone: input.phone.trim(),
    name: input.name.trim(),
    roleId: input.roleId,
    roleName: input.roleName,
    password: "123456",
  };
  accounts.unshift(account);
  writeAccounts(accounts);
  return account;
}

export function updateAccount(id: string, updates: Partial<Account>): Account | null {
  const accounts = readAccounts();
  const index = accounts.findIndex((account) => account.id === id);
  if (index === -1) return null;
  accounts[index] = { ...accounts[index], ...updates, id };
  writeAccounts(accounts);
  return accounts[index];
}

export function deleteAccount(id: string): boolean {
  const accounts = readAccounts();
  const index = accounts.findIndex((account) => account.id === id);
  if (index === -1) return false;
  accounts.splice(index, 1);
  writeAccounts(accounts);
  return true;
}

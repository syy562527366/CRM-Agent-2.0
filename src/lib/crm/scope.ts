import type { Account } from "@/types/account";
import type { Role } from "@/types/role";
import { permissionOf } from "./roles";

/** 功能权限的四个动作，与 roles.json 中的 functions 一致 */
export type CrmAction = "查看" | "修改" | "增加" | "删除";

/** 数据范围 */
export type DataScope = "全部" | "仅自己";

/**
 * 调用者上下文。**只能由服务端根据签名会话生成**，
 * 绝不接受客户端传入的 user_id / role_id。
 */
export interface CrmScope {
  accountId: string;
  name: string;
  roleId: string;
  roleName: string;
  role: Role | null;
}

export function buildScope(account: Account, role: Role | null): CrmScope {
  return {
    accountId: account.id,
    name: account.name,
    roleId: account.roleId,
    roleName: account.roleName,
    role,
  };
}

/** 是否拥有某个页面的某个功能权限 */
export function can(scope: CrmScope, pageKey: string, action: CrmAction): boolean {
  const permission = permissionOf(scope.role, pageKey);
  if (!permission) return false;
  return permission.functions.includes(action);
}

/** 某个页面的数据范围；无权限时返回 null */
export function dataScopeOf(scope: CrmScope, pageKey: string): DataScope | null {
  return permissionOf(scope.role, pageKey)?.dataScope ?? null;
}

/** 是否只能看自己的数据 */
export function isOwnOnly(scope: CrmScope, pageKey: string): boolean {
  return dataScopeOf(scope, pageKey) === "仅自己";
}

/**
 * 线索的数据范围过滤条件。
 * 线索的 assignee 与账号 name 同名（万靖/高兵/…），因此「仅自己」= assignee 等于本人姓名。
 */
export function leadScopeFilter(scope: CrmScope): { assignee?: string } {
  return isOwnOnly(scope, "leads") ? { assignee: scope.name } : {};
}

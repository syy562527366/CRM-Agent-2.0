import type { PermissionItem, Role } from "@/types/role";
import { nextId, nowStamp, readJson, writeJson } from "./store";

const FILE = "roles.json";

export function readRoles(): Role[] {
  return readJson<Role>(FILE);
}

export function writeRoles(roles: Role[]): void {
  writeJson(FILE, roles);
}

export function findRole(id: string): Role | undefined {
  return readRoles().find((role) => role.id === id);
}

export function createRole(name: string): Role {
  const roles = readRoles();
  const role: Role = {
    id: nextId(roles, "ROLE-2026-"),
    createdAt: nowStamp(),
    name: name.trim(),
    permissions: [],
  };
  roles.unshift(role);
  writeRoles(roles);
  return role;
}

export function updateRole(id: string, updates: Partial<Role>): Role | null {
  const roles = readRoles();
  const index = roles.findIndex((role) => role.id === id);
  if (index === -1) return null;
  roles[index] = { ...roles[index], ...updates, id };
  writeRoles(roles);
  return roles[index];
}

export function deleteRole(id: string): boolean {
  const roles = readRoles();
  const index = roles.findIndex((role) => role.id === id);
  if (index === -1) return false;
  roles.splice(index, 1);
  writeRoles(roles);
  return true;
}

/** 某个角色对指定页面的权限项 */
export function permissionOf(role: Role | null | undefined, pageKey: string): PermissionItem | undefined {
  return role?.permissions.find((item) => item.pageKey === pageKey);
}

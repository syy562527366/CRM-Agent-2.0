#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把演示用的销售姓名换成 2025-2026 项目汇总表里的真实负责人。

一次性迁移工具，幂等（只匹配旧名，重跑无副作用）。涉及五处引用：
    data/accounts.json        登录账号的显示名（「仅自己」数据范围靠它和线索 assignee 同名匹配）
    data/sales-targets.json   销售目标 + 企业邮箱
    data/leads.json           线索跟进人
    data/communications.json  沟通记录里的销售署名（客户发言不动）
    public/sales-report-*.html 静态销售分析报表里的人名

用法：python scripts/rename-assignees.py [--dry-run]
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# 旧名 → 新名。按区域一一对应：华北→万靖、华东→高兵、华南→董浩宇、西南→李娜、华中→何南
NAME_MAP = {
    "张明": "万靖",
    "李华": "高兵",
    "王芳": "董浩宇",
    "刘强": "李娜",
    "陈静": "何南",
}
EMAIL_MAP = {
    "zhangming@company.com": "wanjing@company.com",
    "lihua@company.com": "gaobing@company.com",
    "wangfang@company.com": "donghaoyu@company.com",
    "liuqiang@company.com": "lina@company.com",
    "chenjing@company.com": "henan@company.com",
}


def load(name: str):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def save(name: str, rows):
    (DATA / name).write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    counts = {}

    accounts = load("accounts.json")
    hit = 0
    for row in accounts:
        if row.get("name") in NAME_MAP:
            row["name"] = NAME_MAP[row["name"]]
            hit += 1
    counts["accounts.json"] = hit

    targets = load("sales-targets.json")
    hit = 0
    for row in targets:
        if row.get("name") in NAME_MAP:
            row["name"] = NAME_MAP[row["name"]]
            hit += 1
        if row.get("email") in EMAIL_MAP:
            row["email"] = EMAIL_MAP[row["email"]]
    counts["sales-targets.json"] = hit

    leads = load("leads.json")
    hit = 0
    for row in leads:
        if row.get("assignee") in NAME_MAP:
            row["assignee"] = NAME_MAP[row["assignee"]]
            hit += 1
    counts["leads.json"] = hit

    comms = load("communications.json")
    hit = 0
    for row in comms:
        # 只改销售署名，客户发言的 sender 是客户姓名，不能动
        if row.get("senderRole") == "销售" and row.get("sender") in NAME_MAP:
            row["sender"] = NAME_MAP[row["sender"]]
            hit += 1
    counts["communications.json"] = hit

    for label, n in counts.items():
        print(f"{label:<28} 替换 {n} 条")

    html_files = sorted((ROOT / "public").glob("sales-report-*.html"))
    html_hits = 0
    for path in html_files:
        text = path.read_text(encoding="utf-8")
        original = text
        for old, new in NAME_MAP.items():
            text = text.replace(old, new)
        if text != original:
            html_hits += 1
            print(f"{path.name:<28} 已更新人名")
            if not args.dry_run:
                path.write_text(text, encoding="utf-8", newline="\n")
    if not html_files:
        print("public/ 下没有 sales-report-*.html，跳过")

    if args.dry_run:
        print("\n--dry-run：未写入任何文件")
        return 0

    save("accounts.json", accounts)
    save("sales-targets.json", targets)
    save("leads.json", leads)
    save("communications.json", comms)
    print(f"\n已写入 data/（报表更新 {html_hits} 个）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

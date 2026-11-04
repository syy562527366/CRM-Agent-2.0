"""Agent 控制面板后端自测（不调模型、不写生产配置）。

覆盖：
1. 配置默认值：注册表 13 项、删除类锁死、写工具默认人工审批；
2. 配置校验：未知工具 / 非法权限 / 提示词过短 / 删除类不许开启；
3. 配置生效：开关与权限 → effective_tool_names / approval_tool_names / interrupt_on；
4. 原子写与恢复出厂；
5. 管理员门禁：管理员可管、销售不可管、匿名不可管；
6. 指标：写入后今日聚合、7 日趋势、工具榜、p95 正确。

所有读写都指向临时目录，不碰 agent/data 下的真实配置。

    agent/.venv/Scripts/python.exe agent/test_config.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "agent"))

# 必须在 import agent_config / metrics 之前改环境变量（它们在导入时读路径）
_TMP = tempfile.mkdtemp(prefix="agent-cfg-test-")
os.environ["AGENT_CONFIG_PATH"] = os.path.join(_TMP, "agent_config.json")
os.environ["AGENT_DB_PATH"] = os.path.join(_TMP, "metrics.db")

import agent_config as cfg  # noqa: E402
import metrics  # noqa: E402
import tools_guard as guard  # noqa: E402
from crm_client import CrmCtx  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    results.append((name, passed, detail))
    print(f"{'PASS' if passed else 'FAIL'} | {name} | {detail}")


def admin_ctx() -> CrmCtx:
    return CrmCtx(
        uid="ACCT-2026-0001",
        name="系统管理员",
        role_id="ROLE-2026-0001",
        role_name="管理员",
        permissions=(
            {"pageKey": "agent", "functions": ["查看"], "dataScope": "全部"},
            {"pageKey": "accounts", "functions": ["查看", "修改", "增加", "删除"], "dataScope": "全部"},
        ),
    )


def sales_ctx() -> CrmCtx:
    return CrmCtx(
        uid="ACCT-2026-0002",
        name="万靖",
        role_id="ROLE-2026-0002",
        role_name="销售",
        permissions=(
            {"pageKey": "agent", "functions": ["查看"], "dataScope": "全部"},
            {"pageKey": "leads", "functions": ["查看", "修改", "增加"], "dataScope": "全部"},
        ),
    )


# --------------------------------------------------------------------------- #
# 1. 默认配置
# --------------------------------------------------------------------------- #
def test_defaults() -> None:
    view = cfg.view()
    stats = view["stats"]
    check("默认 · 注册表 13 个工具", stats["total"] == 13, f"total={stats['total']}")
    check("默认 · 启用 11 个（删除类不在内）", stats["enabled"] == 11, f"enabled={stats['enabled']}")
    check("默认 · 2 个需要人工审批", stats["approval"] == 2, f"approval={stats['approval']}")
    check("默认 · 提示词为出厂版本", view["is_default_prompt"], f"{view['prompt_length']} 字符")

    delete_rows = [row for row in view["tools"] if row["category"] == "delete"]
    check(
        "默认 · 删除类锁死且禁止",
        len(delete_rows) == 2 and all(row["locked"] and row["permission"] == "forbidden" for row in delete_rows),
        ",".join(row["name"] for row in delete_rows),
    )
    check(
        "默认 · 锁死项有原因说明",
        all(bool(row["lock_reason"]) for row in delete_rows),
        delete_rows[0]["lock_reason"][:20],
    )
    check(
        "默认 · 写工具默认人工审批",
        all(
            row["permission"] == "approval"
            for row in view["tools"]
            if row["name"] in {"crm_update_lead", "crm_update_order"}
        ),
        "crm_update_*",
    )


# --------------------------------------------------------------------------- #
# 2. 校验
# --------------------------------------------------------------------------- #
def test_validation() -> None:
    for label, payload in [
        ("未知工具被拒", {"tools": {"crm_hack": {"enabled": True}}}),
        ("非法权限被拒", {"tools": {"crm_search_leads": {"permission": "always"}}}),
        ("提示词过短被拒", {"system_prompt": "太短"}),
        ("删除类不许开启", {"tools": {"crm_delete_lead": {"enabled": True}}}),
        ("删除类不许改权限", {"tools": {"crm_delete_order": {"permission": "direct"}}}),
    ]:
        try:
            cfg.save(updated_by="test", **payload)
            check(f"校验 · {label}", False, "没有抛 ConfigError")
        except cfg.ConfigError as exc:
            check(f"校验 · {label}", True, str(exc)[:36])


# --------------------------------------------------------------------------- #
# 3. 改配置 → 生效
# --------------------------------------------------------------------------- #
def test_apply() -> None:
    base_revision = cfg.revision()

    # 关掉一个查询工具：应从 effective 里消失
    cfg.save(updated_by="test", tools={"crm_sales_stats": {"enabled": False}})
    check("生效 · 关闭后不再注册", "crm_sales_stats" not in cfg.effective_tool_names(), "crm_sales_stats")
    check("生效 · 关闭后版本号变化", cfg.revision() != base_revision, cfg.revision())
    check(
        "生效 · 关闭项仍出现在面板里",
        any(row["name"] == "crm_sales_stats" for row in cfg.view()["tools"]),
        "面板可见、模型不可见",
    )

    # 改权限：查询工具改成人工审批
    cfg.save(updated_by="test", tools={"crm_search_leads": {"permission": "approval"}})
    check("生效 · 权限改审批后进入 interrupt_on", "crm_search_leads" in cfg.approval_tool_names(), "crm_search_leads")
    interrupt = guard.build_interrupt_on(cfg.approval_tool_names())
    check(
        "生效 · interrupt_on 只含审批工具",
        set(interrupt) == {"crm_search_leads", "crm_update_lead", "crm_update_order"},
        ",".join(sorted(interrupt)),
    )
    check(
        "生效 · interrupt_on 只允许批准/拒绝",
        all(item["allowed_decisions"] == ["approve", "reject"] for item in interrupt.values()),
        "approve/reject",
    )

    # 权限改禁止：工具既不该注册，也不该在审批表
    cfg.save(updated_by="test", tools={"crm_get_lead": {"permission": "forbidden"}})
    row = next(item for item in cfg.view()["tools"] if item["name"] == "crm_get_lead")
    check("生效 · 禁止后 enabled 自动 false", row["enabled"] is False and row["permission"] == "forbidden", "crm_get_lead")
    check("生效 · 禁止后不注册", "crm_get_lead" not in cfg.effective_tool_names(), "crm_get_lead")

    # 重新打开：权限应回到默认（直接使用），而不是停在禁止
    cfg.save(updated_by="test", tools={"crm_get_lead": {"enabled": True}})
    row = next(item for item in cfg.view()["tools"] if item["name"] == "crm_get_lead")
    check("生效 · 重新启用回到默认权限", row["enabled"] and row["permission"] == "direct", row["permission"])

    # 写工具重新启用应回到「人工审批」而不是「直接使用」
    cfg.save(updated_by="test", tools={"crm_update_lead": {"permission": "forbidden"}})
    cfg.save(updated_by="test", tools={"crm_update_lead": {"enabled": True}})
    row = next(item for item in cfg.view()["tools"] if item["name"] == "crm_update_lead")
    check("生效 · 写工具重启后仍需审批", row["permission"] == "approval", row["permission"])

    # 提示词
    new_prompt = "你是测试用的助手，只回答「收到」。这条提示词足够长以通过校验。"
    cfg.save(system_prompt=new_prompt, updated_by="测试员")
    view = cfg.view()
    check("生效 · 提示词已替换", view["system_prompt"] == new_prompt, f"{view['prompt_length']} 字符")
    check("生效 · 标记为已自定义", not view["is_default_prompt"], "is_default_prompt=False")
    check("生效 · 记录修改人", view["updated_by"] == "测试员", view["updated_by"])


# --------------------------------------------------------------------------- #
# 4. 落盘与恢复出厂
# --------------------------------------------------------------------------- #
def test_storage() -> None:
    path = Path(os.environ["AGENT_CONFIG_PATH"])
    raw = json.loads(path.read_text(encoding="utf-8"))
    check("落盘 · 是合法 JSON 且含三段", {"system_prompt", "tools", "updated_at"} <= set(raw), str(path.name))
    check("落盘 · 没有残留临时文件", not list(path.parent.glob("*.tmp")), str(path.parent.name))

    view = cfg.reset(updated_by="测试")
    check("恢复出厂 · 提示词回到默认", view["is_default_prompt"], f"{view['prompt_length']} 字符")
    check("恢复出厂 · 工具回到默认", view["stats"]["enabled"] == 11, f"enabled={view['stats']['enabled']}")
    check("恢复出厂 · 删除类仍然禁止", view["stats"]["forbidden"] == 2, "forbidden=2")


# --------------------------------------------------------------------------- #
# 5. 管理员门禁
# --------------------------------------------------------------------------- #
def test_guard() -> None:
    check("门禁 · 管理员可管理", cfg.can_manage(admin_ctx()), "accounts.修改")
    check("门禁 · 销售不可管理", not cfg.can_manage(sales_ctx()), "无 accounts 页面")
    check("门禁 · 匿名不可管理", not cfg.can_manage(CrmCtx()), "uid 为空")
    check("门禁 · None 不可管理", not cfg.can_manage(None), "传 None 不炸")


# --------------------------------------------------------------------------- #
# 6. 指标
# --------------------------------------------------------------------------- #
def test_metrics() -> None:
    metrics.record(duration_ms=1200, uid="ACCT-2026-0001", thread_id="t1", entry="chat", prompt_tokens=300, completion_tokens=80, total_tokens=380, tools=["crm_search_leads", "crm_get_lead"], model="deepseek-flash")
    metrics.record(duration_ms=800, uid="ACCT-2026-0001", thread_id="t1", entry="resume", prompt_tokens=200, completion_tokens=50, total_tokens=250, tools=["crm_update_lead"], model="deepseek-flash")
    metrics.record(duration_ms=2000, uid="ACCT-2026-0002", thread_id="t2", entry="chat", model="deepseek-flash", ok=False, error="boom")

    data = metrics.overview()
    today = data["today"]
    check("指标 · 今日调用 3 次", today["calls"] == 3, f"calls={today['calls']}")
    check("指标 · 平均耗时正确", today["avg_ms"] == 1333, f"avg={today['avg_ms']}ms")
    check("指标 · 工具调用次数累加", today["tool_calls"] == 3, f"tool_calls={today['tool_calls']}")
    check("指标 · token 累加", today["total_tokens"] == 630, f"tokens={today['total_tokens']}")
    check("指标 · 输入输出分开记", today["prompt_tokens"] == 500 and today["completion_tokens"] == 130, f"{today['prompt_tokens']}/{today['completion_tokens']}")
    check("指标 · 失败单独计数", today["errors"] == 1, f"errors={today['errors']}")
    check("指标 · 会话数去重", today["threads"] == 2, f"threads={today['threads']}")
    check("指标 · p95 有值", today["p95_ms"] > 0, f"p95={today['p95_ms']}ms")

    check("指标 · 7 日趋势 7 个点", len(data["trend"]) == 7, f"{data['trend'][0]['day']} → {data['trend'][-1]['day']}")
    check("指标 · 趋势末日是今天", data["trend"][-1]["day"] == date.today().isoformat(), data["trend"][-1]["day"])
    check("指标 · 趋势今日 3 次", data["trend"][-1]["calls"] == 3, f"calls={data['trend'][-1]['calls']}")
    check("指标 · 昨日为空", data["yesterday"]["calls"] == 0, "yesterday=0")
    check(
        "指标 · 工具榜按次数排序",
        data["top_tools"][0]["name"] == "crm_get_lead" or data["top_tools"][0]["count"] == 1,
        str(data["top_tools"]),
    )
    check("指标 · 记录最近调用时间", bool(data["last_call_at"]), data["last_call_at"])

    # 跨天数据：手工塞一条昨天的，验证「今日」不会把历史算进来
    conn = metrics._db()
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    conn.execute(
        "INSERT INTO chat_metrics (ts, day, uid, thread_id, entry, duration_ms, total_tokens, tool_calls, tools, model, ok)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,1)",
        (f"{yesterday}T10:00:00+08:00", yesterday, "ACCT-2026-0001", "t0", "chat", 500, 100, 1, '["calculator"]', "deepseek-flash"),
    )
    conn.commit()
    data = metrics.overview()
    check("指标 · 历史不混进今日", data["today"]["calls"] == 3, f"today={data['today']['calls']}")
    check("指标 · 昨日正确聚合", data["yesterday"]["calls"] == 1, f"yesterday={data['yesterday']['calls']}")


# --------------------------------------------------------------------------- #
def main() -> int:
    test_defaults()
    test_validation()
    test_apply()
    test_storage()
    test_guard()
    test_metrics()

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n{passed}/{total} 通过")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())

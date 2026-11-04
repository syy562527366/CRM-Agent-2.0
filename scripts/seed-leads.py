#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建线索与沟通记录演示数据（碳核算 / CBAM / 双碳咨询业务场景）。

设计约束（与前端保持一致，改这里也要同步改 LeadsDashboard / CommunicationsDashboard 的常量）：
- 来源 SOURCES、跟进人 ASSIGNEES 必须落在前端下拉选项里，否则筛选不到、编辑时下拉空白；
- 状态 STATUSES 用现有 5 个值，仪表盘漏斗依赖它们；
- 线索编号占用 LD-2026-0101 起、沟通记录 COMM-2026-0101 起，与既有演示数据（0001~0057）不重叠；
- 脚本可重复执行：每次先清掉自己写过的号段再重建，不产生重复。

用法：
    python scripts/seed-leads.py           # 写入
    python scripts/seed-leads.py --dry-run # 只打印统计
"""

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

TODAY = datetime(2026, 11, 4, 16, 0)
LEAD_SEQ_BASE = 101
COMM_SEQ_BASE = 101

SOURCES = ["官网咨询", "百度推广", "展会活动", "转介绍", "行业峰会", "朋友圈广告"]

# 与 accounts.json 里的销售账号一一对应（姓名取自 2025-2026 项目汇总表的「负责人」列）
ASSIGNEES = ["万靖", "高兵", "董浩宇", "李娜", "何南"]

STATUSES = ["未接触", "推荐产品", "成交", "客户流失", "长期未跟进"]

# 每个销售对应的手机号段（按区域习惯）
PHONE_PREFIX = {
    "万靖": ["186", "135", "133"],
    "高兵": ["139", "138", "158"],
    "董浩宇": ["136", "189", "159"],
    "李娜": ["183", "187", "199"],
    "何南": ["177", "180", "155"],
}

# (姓名, 邮箱前缀, 优先级, 来源, 跟进人, 创建日期, 状态, 意向产品, 预算, 客户岗位, 客户情况)
CASES = [
    # ---------- 高兵 · 华东 ----------
    ("沈雅琴", "shenyaqin", "high", "官网咨询", "高兵", "2026-07-08", "成交", "产品碳足迹核查", "30-50万元", "可持续发展总监",
     "常州光伏组件厂，欧洲客户要求提供 ISO 14067 碳足迹报告，7 月内要出中英文版"),
    ("陈志远", "chenzhiyuan", "high", "展会活动", "高兵", "2026-09-16", "成交", "CBAM 填报服务", "5-10万元", "外贸合规经理",
     "苏州精密机械出口企业，德国客户 10 月起要求提交 CBAM 季报，需配套英文数据表"),
    ("徐建国", "xujianguo", "medium", "转介绍", "高兵", "2026-10-21", "推荐产品", "碳足迹核算核查", "10-30万元", "EHS 经理",
     "宁波化工园区企业，集团总部要求核算 3 个主力产品碳足迹并做第三方核查"),
    ("吴敏华", "wuminhua", "low", "行业峰会", "高兵", "2026-08-12", "长期未跟进", "双碳培训", "3-5万元", "人力资源经理",
     "绍兴纺织企业，计划给管理层做双碳认知培训，预算待批"),
    ("周立诚", "zhoulicheng", "high", "官网咨询", "高兵", "2026-10-30", "推荐产品", "能碳管理数字化系统", "100万元以上", "信息化总监",
     "无锡汽车零部件集团，需要把 6 个厂区的能耗与碳排数据接到统一平台"),
    ("顾晓芸", "guxiaoyun", "medium", "朋友圈广告", "高兵", "2026-09-05", "客户流失", "温室气体报告", "3-5万元", "质量总监",
     "杭州食品企业，客户验厂需要温室气体报告，最终选了本地服务商"),
    ("潘伟东", "panweidong", "high", "百度推广", "高兵", "2026-10-14", "成交", "ESG 咨询与技术服务", "10-30万元", "董事会秘书",
     "上海科创板上市公司，年报 ESG 章节需要第三方支持与披露辅导"),
    ("蒋丽萍", "jiangliping", "medium", "展会活动", "高兵", "2026-07-22", "客户流失", "绿色工厂评价", "10-30万元", "生产管理部经理",
     "苏州建材企业，国家级绿色工厂申报项目延后到明年预算"),
    ("韩雪梅", "hanxuemei", "medium", "转介绍", "高兵", "2026-11-02", "未接触", "ISCC 认证咨询服务", "5-10万元", "供应链经理",
     "南通生物基材料企业，出口欧盟需要 ISCC EU 认证，先了解流程"),
    ("曹俊峰", "caojunfeng", "high", "官网咨询", "高兵", "2026-10-08", "成交", "零碳工厂咨询", "30-50万元", "副总经理",
     "昆山电子制造工厂，品牌客户要求 2027 年前建成零碳工厂"),
    ("唐国华", "tangguohua", "low", "行业峰会", "高兵", "2026-08-27", "长期未跟进", "产品碳数字化系统", "30-50万元", "数字化项目经理",
     "合肥家电企业，碳数据系统内部立项未通过"),
    ("严志刚", "yanzhigang", "medium", "百度推广", "高兵", "2026-10-26", "推荐产品", "产品碳足迹核查", "10-30万元", "研发经理",
     "常州锂电材料企业，海外客户要求提供正极材料 PCF 数据"),

    # ---------- 万靖 · 华北 ----------
    ("赵国强", "zhaoguoqiang", "high", "展会活动", "万靖", "2026-07-15", "成交", "CBAM 填报服务", "5-10万元", "出口部经理",
     "唐山钢铁出口企业，欧盟 CBAM 过渡期申报，需按 CN 编码逐项出报告"),
    ("李振宇", "lizhenyu", "high", "官网咨询", "万靖", "2026-10-19", "成交", "碳足迹核算核查", "10-30万元", "EHS 主管",
     "滨州铝型材厂，下游客户要求提供铝型材从摇篮到大门的碳足迹"),
    ("王海涛", "wanghaitao", "medium", "转介绍", "万靖", "2026-09-09", "推荐产品", "绿色低碳咨询服务", "10-30万元", "战略发展部经理",
     "天津临港园区，拟编制零碳园区建设方案申报市级试点"),
    ("刘思远", "liusiyuan", "low", "朋友圈广告", "万靖", "2026-08-03", "长期未跟进", "双碳培训", "3万元以下", "行政经理",
     "北京物流公司，只问了培训报价，没有明确需求"),
    ("孙丽君", "sunlijun", "medium", "行业峰会", "万靖", "2026-10-11", "未接触", "碳中和数字办公产品", "5-10万元", "行政总监",
     "北京金融科技公司，关注办公场景碳中和与差旅碳管理"),
    ("郑凯文", "zhengkaiwen", "high", "百度推广", "万靖", "2026-09-24", "客户流失", "CBAM 填报服务", "5-10万元", "国际业务经理",
     "青岛五金出口企业，最终委托外贸代理一并处理 CBAM 申报"),
    ("冯建军", "fengjianjun", "medium", "官网咨询", "万靖", "2026-07-29", "成交", "温室气体报告", "5-10万元", "安全环保部经理",
     "石家庄水泥企业，需按 ISO 14064 出具年度温室气体排放报告"),
    ("董雅静", "dongyajing", "high", "转介绍", "万靖", "2026-10-23", "推荐产品", "能碳管理数字化系统", "50-100万元", "能源管理部长",
     "东营化工集团，碳资产管理平台需要对接现有 ERP 和 DCS 系统"),
    ("马长胜", "machangsheng", "low", "展会活动", "万靖", "2026-08-19", "长期未跟进", "绿色工厂评价", "10-30万元", "生产副总",
     "保定机械厂，暂无国家级绿色工厂申报计划"),
    ("高文博", "gaowenbo", "medium", "百度推广", "万靖", "2026-11-03", "未接触", "产品碳足迹核查", "5-10万元", "采购经理",
     "廊坊汽车零部件企业，主机厂要求提交 PCF 声明"),

    # ---------- 董浩宇 · 华南 ----------
    ("林俊杰", "linjunjie", "high", "官网咨询", "董浩宇", "2026-07-11", "成交", "CBAM 填报服务", "5-10万元", "外贸总监",
     "佛山铝制品出口企业，欧盟客户 8 月催 CBAM 数据，需赶在清关前完成"),
    ("黄美玲", "huangmeiling", "medium", "展会活动", "董浩宇", "2026-09-12", "推荐产品", "产品碳数字化系统", "30-50万元", "品牌可持续发展负责人",
     "广州服装品牌，需要给 30 家代工厂做碳数据采集与核算"),
    ("陈嘉豪", "chenjiahao", "high", "转介绍", "董浩宇", "2026-10-16", "成交", "碳管理系统", "50-100万元", "信息技术经理",
     "东莞电子代工厂，品牌客户要求碳数据接入其供应链平台"),
    ("吴淑芬", "wushufen", "low", "朋友圈广告", "董浩宇", "2026-08-06", "客户流失", "双碳培训", "3万元以下", "培训主管",
     "深圳房地产企业，改为内部讲师授课，未采购"),
    ("曾志伟", "zengzhiwei", "medium", "百度推广", "董浩宇", "2026-10-29", "未接触", "ISCC 认证咨询服务", "10-30万元", "采购总监",
     "湛江生物柴油企业，出口欧盟需要 ISCC 认证咨询"),
    ("罗雪莹", "luoxueying", "high", "行业峰会", "董浩宇", "2026-10-06", "推荐产品", "ESG 咨询与技术服务", "10-30万元", "证券事务代表",
     "深圳新材料上市公司，年报 ESG 章节需要第三方数据支撑"),
    ("谢建华", "xiejianhua", "medium", "官网咨询", "董浩宇", "2026-09-02", "成交", "温室气体报告", "5-10万元", "环保专员",
     "佛山陶瓷企业，海外客户验厂需要温室气体排放报告"),
    ("傅文静", "fuwenjing", "low", "转介绍", "董浩宇", "2026-07-25", "长期未跟进", "绿色低碳咨询服务", "10-30万元", "项目发展部经理",
     "南宁产业园，处于规划阶段，年内不投入"),
    ("蔡明辉", "caiminghui", "high", "展会活动", "董浩宇", "2026-10-31", "推荐产品", "零碳工厂咨询", "30-50万元", "制造总监",
     "中山家电制造企业，欧洲订单要求 2027 年拿到零碳工厂认证"),
    ("杜小雨", "duxiaoyu", "medium", "百度推广", "董浩宇", "2026-08-30", "客户流失", "产品碳足迹核查", "5-10万元", "品质经理",
     "汕头玩具企业，客户自行委托了检测机构出报告"),

    # ---------- 李娜 · 西南 ----------
    ("杨光远", "yangguangyuan", "high", "官网咨询", "李娜", "2026-09-19", "成交", "碳足迹核算核查", "10-30万元", "技术中心主任",
     "宜宾白酒企业，出口产品需要碳足迹核算与核查声明"),
    ("何春梅", "hechunmei", "medium", "转介绍", "李娜", "2026-10-09", "推荐产品", "绿色工厂评价", "10-30万元", "生产管理部长",
     "德阳装备制造企业，申报省级绿色工厂需要第三方评价"),
    ("蒋大伟", "jiangdawei", "low", "展会活动", "李娜", "2026-07-18", "长期未跟进", "双碳培训", "3-5万元", "人事经理",
     "成都物业公司，培训需求暂缓，等集团统一安排"),
    ("廖建平", "liaojianping", "high", "百度推广", "李娜", "2026-10-24", "成交", "CBAM 填报服务", "5-10万元", "出口业务经理",
     "重庆化工出口企业，欧盟客户要求提供 CBAM 排放数据"),
    ("谭丽", "tanli", "medium", "朋友圈广告", "李娜", "2026-08-15", "未接触", "碳中和数字办公产品", "5-10万元", "行政主管",
     "成都互联网公司，关注园区办公碳中和方案"),
    ("邓志强", "dengzhiqiang", "high", "行业峰会", "李娜", "2026-10-02", "推荐产品", "能碳管理数字化系统", "50-100万元", "能源管理经理",
     "昆明有色金属集团，需要集团级能碳管理平台，覆盖 4 个冶炼基地"),
    ("汪晓东", "wangxiaodong", "medium", "官网咨询", "李娜", "2026-09-26", "客户流失", "温室气体报告", "5-10万元", "安环部长",
     "乐山造纸企业，集团内部统一采购，本次未单独签约"),
    ("龙秀英", "longxiuying", "low", "转介绍", "李娜", "2026-11-01", "未接触", "双碳培训", "3-5万元", "培训经理",
     "贵阳酒店集团，询问管理层双碳培训报价"),

    # ---------- 何南 · 华中 ----------
    ("胡建明", "hujianming", "high", "官网咨询", "何南", "2026-09-08", "成交", "CBAM 填报服务", "5-10万元", "外贸经理",
     "武汉钢结构出口企业，欧盟项目要求提供 CBAM 预申报数据"),
    ("万丽娟", "wanlijuan", "medium", "展会活动", "何南", "2026-10-17", "推荐产品", "产品碳足迹核查", "10-30万元", "品质总监",
     "长沙汽车线束企业，主机厂要求提交碳足迹声明"),
    ("熊志刚", "xiongzhigang", "high", "转介绍", "何南", "2026-10-27", "推荐产品", "零碳工厂咨询", "30-50万元", "总经理助理",
     "漯河食品加工企业，客户要求 2028 年前建成零碳工厂"),
    ("江晓红", "jiangxiaohong", "low", "朋友圈广告", "何南", "2026-08-09", "长期未跟进", "双碳培训", "3万元以下", "行政专员",
     "郑州医药公司，仅在广告页留言咨询培训"),
    ("程立国", "chengliguo", "medium", "百度推广", "何南", "2026-09-30", "成交", "碳管理系统", "30-50万元", "信息中心主任",
     "武汉烟草工业企业，碳管理系统需要对接生产与能源数据"),
    ("章雅芳", "zhangyafang", "high", "行业峰会", "何南", "2026-11-04", "未接触", "ESG 咨询与技术服务", "10-30万元", "董办秘书",
     "株洲新能源上市公司，准备首次披露 ESG 报告"),
    ("姚文斌", "yaowenbin", "medium", "官网咨询", "何南", "2026-07-14", "客户流失", "绿色低碳咨询服务", "10-30万元", "发展规划部经理",
     "鄂州物流园区，方案报价超出年度预算，暂缓"),
    ("白丽华", "bailihua", "medium", "转介绍", "何南", "2026-10-13", "成交", "ISCC 认证咨询服务", "10-30万元", "进出口部经理",
     "岳阳油脂加工企业，出口欧盟需要 ISCC EU 认证"),
]

# 老演示数据（AI 课 / B 端课）的意向产品与来源归一到同一套口径，
# 否则筛选下拉里选不到、编辑时下拉空白。
LEGACY_SOURCE_MAP = {
    "抖音": "朋友圈广告",
    "搜索引擎": "百度推广",
    "朋友圈": "朋友圈广告",
    "线下海报": "展会活动",
    "其他": "官网咨询",
}
LEGACY_INTENT_MAP = {
    "AI课": "AI 与数字化转型企业培训",
    "B端课": "双碳培训",
    # 商品目录里没有「入门课 / C端课」这两个服务，归到实际的定制培训商品，
    # 否则线索成交后开单时选不到对应商品
    "入门课": "培训（定制课）",
    "C端课": "培训（定制课）",
}

# 状态 → 跟进跨度（天）。实际沟通条数由话术模板决定，两者共同决定时间轴疏密。
FOLLOWUP_SPAN = {
    "成交": 26,
    "客户流失": 18,
    "长期未跟进": 4,
    "推荐产品": 5,
    "未接触": 0,
}


def stamp(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M")


def phone_of(index: int, assignee: str) -> str:
    """确定性生成手机号：前 3 位按区域取，后 8 位按序号递增，保证不重复。"""
    prefixes = PHONE_PREFIX[assignee]
    tail = 70000000 + index * 137
    return f"{prefixes[index % len(prefixes)]}{tail:08d}"


def created_at(day: str, index: int) -> datetime:
    base = datetime.strptime(day, "%Y-%m-%d")
    # 09:00~18:59 之间确定性取一个时刻
    minutes = (index * 37) % 600
    created = base + timedelta(hours=9, minutes=minutes)
    # 当天创建的数据不能晚于「现在」
    if created > TODAY:
        created = TODAY - timedelta(hours=3)
    return created


def work_hour(dt: datetime) -> datetime:
    """把跟进时刻压回工作时段（09:00~20:00），否则均摊出来的凌晨 1 点沟通不像真人干的。"""
    if dt.hour < 9:
        return dt.replace(hour=9, minute=[10, 25, 40][dt.day % 3], second=0)
    if dt.hour >= 20:
        return dt.replace(hour=19, minute=[10, 25, 40][dt.day % 3], second=0)
    return dt


def followup_window(created: datetime, status: str, count: int, spread: int = 0):
    span = FOLLOWUP_SPAN[status]
    if count == 0:
        return created, []
    end = created + timedelta(days=span)
    if end > TODAY:
        # 跟进跨度超出今天时压回近期。按序号错开 0~4 天，否则多条在谈线索的
        # 「最后跟进」会全部落在同一刻，跟进记录和据此开出的订单都会挤在同一天
        end = TODAY - timedelta(hours=1) - timedelta(days=spread % 5, hours=(spread * 3) % 7)
    if end <= created:
        end = created + timedelta(hours=2)
    step = (end - created) / (count - 1) if count > 1 else timedelta(0)
    slots = [work_hour(created + step * i) for i in range(count)]
    # 压回工作时段后可能出现逆序或同刻，逐条往后推
    for i in range(1, len(slots)):
        if slots[i] <= slots[i - 1]:
            slots[i] = slots[i - 1] + timedelta(minutes=40)
    return slots[-1], slots


def dialogue(name: str, assignee: str, intent: str, remark: str, status: str, source: str, budget: str, variant: int):
    """按状态生成一段有来有回的沟通记录，返回 [(角色, 类型, 渠道, 内容)]。

    variant 用来在同类状态下轮换措辞，否则不同客户会收到一字不差的回复，一眼假。
    """
    honorific = f"{name[0]}{'总' if len(name) == 3 else '女士'}"
    opening = {
        "官网咨询": f"您好{honorific}，我是碳启城{assignee}。看到您在官网提交了{intent}的咨询，方便占用两分钟了解一下具体情况吗？",
        "百度推广": f"您好{honorific}，我是碳启城{assignee}，您刚才在搜索页留了{intent}的需求，我这边给您去个电话方便吗？",
        "展会活动": f"您好{honorific}，我是碳启城{assignee}，昨天展会上您在我们展台聊过{intent}，把资料整理了一份发您。",
        "转介绍": f"您好{honorific}，我是碳启城{assignee}，是{source}那边介绍我联系您的，说您这边有{intent}的需求。",
        "行业峰会": f"您好{honorific}，我是碳启城{assignee}，上周峰会上您提到{intent}，想跟您确认下具体场景。",
        "朋友圈广告": f"您好{honorific}，我是碳启城{assignee}，看到您在朋友圈广告页留了{intent}的咨询，想先了解下需求。",
    }[source]

    ask = [
        f"{intent}这块我们做过同行业的案子。想确认两点：核算边界是只做厂内，还是要含上游原材料？另外能耗台账、物料清单这些数据现在有现成的吗？",
        f"先跟您对齐一下范围：{intent}是覆盖全部产品线，还是先拿一个代表产品做试点？另外第三方核查是客户指定机构，还是我们一并安排？",
        f"想了解下进度要求：{intent}这边有没有明确的交付时间点？如果是要赶客户验厂或清关，我们会倒排工期出方案。",
    ][variant % 3]

    reply = [
        "边界要含上游主要原材料，台账有，但有一部分是纸质记录，需要整理。",
        "先做一个主力产品试点，跑通了再推开。核查机构客户没指定，你们安排就行。",
        "时间比较紧，下个月中客户要来审厂，报告最好能在那之前出来。",
    ][variant % 3]

    quote = [
        f"方案和报价已发您邮箱。{intent}按 4 周排期，分资料收集、核算建模、内部评审、出具报告四步，预算区间 {budget}。",
        f"按您说的情况出了方案：{intent}分两阶段，先做数据盘点和边界确认，再出核算报告，整体 {budget}，周期 5 周。",
        f"{intent}的实施方案和报价单已发您，含现场调研一次和两轮报告修订，报价在 {budget} 区间内。",
    ][variant % 3]

    thread = [
        ("销售", "主动联系", "电话" if status in ("成交", "客户流失") else "微信", opening),
        ("客户", "需求说明", "微信", f"我们的情况是这样：{remark}。"),
        ("销售", "需求了解", "微信", ask),
        ("客户", "需求回复", "微信", reply),
    ]

    if status == "成交":
        thread += [
            ("销售", "方案定制", "邮件", quote),
            ("客户", "价格谈判", "微信", [
                "价格我们再压一点，另外能不能把英文版报告一起包含进去？",
                "报价我看了，比预算高一些，能不能按年度框架价给我们算？",
                "费用能不能拆成两笔走，今年先付一部分，剩下的走明年预算？",
            ][variant % 3]),
            ("销售", "合同签署", "邮件", [
                "英文版报告一并包含，价格按您说的调整，合同和保密协议已经发出，收到后我们安排启动会。",
                "按讨论的口径定了，合同已发您邮箱，我们预留了下周的排期，签完即可启动资料收集。",
                "价格按优惠后的版本执行，另外附赠一次内部培训，合同今天寄出，麻烦您走一下用印。",
            ][variant % 3]),
        ]
    elif status == "客户流失":
        thread += [
            ("销售", "方案定制", "邮件", quote),
            ("客户", "价格谈判", "微信", "我们同时问了两家，你们报价偏高，能不能再降 30%？"),
            ("销售", "价格协商", "微信", "这个价格已经是含核查机构费用的口径，我再申请一下，最多能到九折。"),
            ("客户", "合作终止", "微信", [
                "内部定了本地一家服务商，这次先不考虑了，后面有项目再联系。",
                "今年预算卡得紧，这个项目先搁置，等明年一季度再看。",
                "总部那边统一指定了供应商，我们这边就不单独采购了。",
            ][variant % 3]),
        ]
    elif status == "长期未跟进":
        thread += [
            ("销售", "跟进提醒", "微信", "上次沟通后没收到回复，先把方案留着，季度末再联系一次。"),
        ]
    else:  # 推荐产品
        recommend = {
            "CBAM 填报服务": "CDP 填报与提级技术服务",
            "碳足迹核算核查": "产品碳数字化系统",
            "产品碳足迹核查": "产品碳数字化系统",
            "ESG 咨询与技术服务": "CDP 填报与提级技术服务",
            "绿色低碳咨询服务": "零碳工厂咨询",
            "能碳管理数字化系统": "碳管理系统",
            "碳管理系统": "能碳管理数字化系统",
            "零碳工厂咨询": "绿色工厂评价",
            "绿色工厂评价": "零碳工厂咨询",
            "温室气体报告": "碳足迹核算核查",
            "ISCC 认证咨询服务": "碳足迹核算核查",
        }.get(intent, "碳足迹核算核查")
        thread += [
            ("销售", "方案推荐", "微信", [
                f"结合您现在的情况，建议先做{intent}把数据底子打出来，后续再上{recommend}，比一次性采购更稳妥。",
                f"按您的需求，{intent}可以先落一版，后面想扩展到{recommend}的话接口是现成的，不用重复投入。",
                f"我们建议 {intent} 和 {recommend} 分两步走，先解决眼前的交付压力，再考虑长期系统化。",
            ][variant % 3]),
            ("客户", "方案反馈", "微信", [
                "方案我看过了，方向没问题，等内部排一下预算，年底前给答复。",
                "思路是对的，我先跟领导汇报一下，有结论让助理联系你。",
                "内容我认可，就是时间上还在纠结，先按这个方案准备着。",
            ][variant % 3]),
        ]

    # 排序：销售先行、客户回复交替，最后一条收尾
    return thread


def trim_thread(thread, status: str):
    """按状态裁掉不合理的话术：未接触不该有记录，长期未跟进只聊过两次就断联。"""
    if status == "未接触":
        return []
    if status == "长期未跟进":
        return thread[:2] + [thread[-1]]
    return thread


def build():
    leads_path = DATA / "leads.json"
    comms_path = DATA / "communications.json"
    leads = json.loads(leads_path.read_text(encoding="utf-8"))
    comms = json.loads(comms_path.read_text(encoding="utf-8"))

    # 1) 清掉本脚本写过的号段，保证可重跑
    def below_base(row_id: str, base: int) -> bool:
        return int(row_id.rsplit("-", 1)[-1]) < base

    leads = [l for l in leads if below_base(l["id"], LEAD_SEQ_BASE)]
    comms = [c for c in comms if below_base(c["id"], COMM_SEQ_BASE)]

    # 2) 老演示数据口径归一
    legacy_fixed = 0
    for lead in leads:
        source = LEGACY_SOURCE_MAP.get(lead.get("source", ""))
        if source:
            lead["source"] = source
            legacy_fixed += 1
        intent = LEGACY_INTENT_MAP.get(lead.get("intentProduct", ""))
        if intent:
            lead["intentProduct"] = intent

    # 老演示数据的沟通署名是「李小华」等另一个人，和线索跟进人对不上，统一到跟进人
    owner_of = {l["id"]: l["assignee"] for l in leads}
    for row in comms:
        if row.get("senderRole") == "销售":
            owner = owner_of.get(row["leadId"])
            if owner and row.get("sender") != owner:
                row["sender"] = owner

    used_phones = {l["phone"] for l in leads}
    new_leads = []
    new_comms = []

    comm_seq = COMM_SEQ_BASE
    for index, case in enumerate(CASES):
        (name, email_prefix, priority, source, assignee, day, status,
         intent, budget, position, remark) = case

        lead_id = f"LD-2026-{LEAD_SEQ_BASE + index:04d}"
        phone = phone_of(index, assignee)
        assert phone not in used_phones, f"手机号重复：{phone}"
        used_phones.add(phone)

        created = created_at(day, index)
        thread = trim_thread(
            dialogue(name, assignee, intent, remark, status, source, budget, index), status
        )
        end, slots = followup_window(created, status, len(thread), index)

        lead = {
            "id": lead_id,
            "createdAt": stamp(created),
            "name": name,
            "phone": phone,
            "priority": priority,
            "source": source,
            "assignee": assignee,
            "email": f"{email_prefix}@{['163.com', '126.com', 'qq.com'][index % 3]}",
            "status": status,
            "lastFollowUpAt": stamp(slots[-1]) if slots else stamp(created),
            "intentProduct": intent,
            "budgetRange": budget,
            "remark": remark,
            "customerPosition": position,
            "communicationCount": len(thread),
        }
        if "培训" in intent:
            lead["trialDuration"] = [60, 90, 120][index % 3]
        new_leads.append(lead)

        for slot, (role, kind, channel, content) in zip(slots, thread):
            new_comms.append({
                "id": f"COMM-2026-{comm_seq:04d}",
                "leadId": lead_id,
                "sentAt": stamp(slot),
                "sender": assignee if role == "销售" else name,
                "senderRole": role,
                "content": content,
                "type": kind,
                "channel": channel,
            })
            comm_seq += 1

    all_leads = new_leads + leads
    all_comms = sorted(new_comms + comms, key=lambda c: c["sentAt"])

    return all_leads, all_comms, legacy_fixed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    leads, comms, legacy_fixed = build()

    from collections import Counter
    new = [l for l in leads if int(l["id"].split("-")[-1]) >= LEAD_SEQ_BASE]
    print(f"线索总数 {len(leads)}（新增 {len(new)}，老数据来源归一 {legacy_fixed} 条）")
    print("状态：", dict(Counter(l["status"] for l in new)))
    print("来源：", dict(Counter(l["source"] for l in new)))
    print("跟进人：", dict(Counter(l["assignee"] for l in new)))
    print("优先级：", dict(Counter(l["priority"] for l in new)))
    print(f"沟通记录总数 {len(comms)}（新增 {sum(1 for c in comms if int(c['id'].split('-')[-1]) >= COMM_SEQ_BASE)}）")
    print("时间跨度：", min(l["createdAt"] for l in new), "~", max(l["createdAt"] for l in new))

    if args.dry_run:
        return

    # newline="\n" 是关键：Windows 下文本模式会把 \n 转成 \r\n，让整份 JSON 的 diff 全部漂移
    (DATA / "leads.json").write_text(
        json.dumps(leads, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    (DATA / "communications.json").write_text(
        json.dumps(comms, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    print("已写入 data/leads.json 与 data/communications.json")


if __name__ == "__main__":
    sys.exit(main())

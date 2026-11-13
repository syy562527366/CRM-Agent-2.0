"""知识库命令行。

    python -m kb.cli init                   建表
    python -m kb.cli ingest                 导入默认语料（技能 + 项目文档 + 产品 FAQ）
    python -m kb.cli ingest --only faq      只导某一类
    python -m kb.cli ingest --force         忽略内容指纹，强制重算
    python -m kb.cli search "CBAM 怎么收费"   检索自测
    python -m kb.cli stats                  库统计
    python -m kb.cli docs                   已入库文档清单
    python -m kb.cli reset --yes            清空重建

在 agent/ 目录下执行。
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from kb.chunker import embed_text, split_markdown
from kb.config import load_config
from kb.embedding import Embedder
from kb.loader import (
    RawDoc,
    default_corpus,
    load_faq_csv,
    load_faq_xlsx,
    load_markdown_dir,
    load_skills,
)
from kb.store import KBStore


def _pick_docs(only: str, faq_path: Path | None, csv_path: Path | None = None) -> list[RawDoc]:
    # Windows 控制台按 ANSI 解码 argv 时，中文路径会变成乱码并「找不到文件」。
    # 这种情况下回退到约定的默认位置，别让用户对着 FileNotFoundError 猜。
    if csv_path is not None and not csv_path.exists():
        from kb.loader import FAQ_CSV_NAME, PROJECT_ROOT

        fallback = PROJECT_ROOT.parent / FAQ_CSV_NAME
        if fallback.exists():
            csv_path = fallback
    if not only:
        return default_corpus(faq_path, csv_path)
    if only == "skill":
        return load_skills()
    if only == "faq":
        if csv_path:
            return load_faq_csv(csv_path)
        if faq_path:
            return load_faq_xlsx(faq_path)
        return [d for d in default_corpus() if d.doc_type in {"faq", "product"}]
    if only == "doc":
        return load_markdown_dir(Path(__file__).resolve().parents[1] / "docs", "doc")
    raise SystemExit(f"未知类型：{only}（可选 skill / faq / doc）")


def cmd_init(args: argparse.Namespace) -> int:
    cfg = load_config()
    with KBStore(cfg, create=True) as store:
        store.init_schema(reset=args.reset)
        info = store.stats()
    print(f"知识库已就绪：{info['db_path']}")
    print(f"  维度 {info['dim']} / 模型 {info['model']} / 文档 {info['docs']} 篇 / 切块 {info['chunks']} 个")
    return 0


def cmd_ingest(args: argparse.Namespace) -> int:
    cfg = load_config()
    docs = _pick_docs(
        args.only,
        Path(args.faq) if args.faq else None,
        Path(args.csv) if args.csv else None,
    )
    if not docs:
        print("没有可导入的文档")
        return 1

    started = time.time()
    embedder = Embedder(cfg)
    total_chunks = total_new = skipped = 0
    failed: list[tuple[str, str]] = []

    with KBStore(cfg, create=True) as store:
        store.init_schema()

        for i, doc in enumerate(docs, 1):
            chunks = split_markdown(doc.text, max_chars=args.max_chars, min_chars=args.min_chars)
            if not chunks:
                continue
            total_chunks += len(chunks)
            label = f"[{i}/{len(docs)}] {doc.title}"
            try:
                texts = [embed_text(doc.title, c.heading, c.content) for c in chunks]
                vectors = embedder.embed_texts(texts)
                res = store.upsert_document(
                    doc_key=doc.doc_key,
                    title=doc.title,
                    source=doc.source,
                    doc_type=doc.doc_type,
                    chunks=chunks,
                    vectors=vectors,
                    meta=doc.meta,
                    force=args.force,
                )
            except Exception as exc:  # noqa: BLE001 - 单篇失败不中断整批
                failed.append((doc.doc_key, str(exc)[:160]))
                print(f"{label}  ✗ {type(exc).__name__}: {str(exc)[:120]}")
                continue

            if res.skipped:
                skipped += 1
                print(f"{label}  - 跳过（{res.reason}）")
            else:
                total_new += len(chunks)
                print(f"{label}  ✓ {len(chunks)} 块")

        info = store.stats()

    cost = time.time() - started
    print()
    print(f"完成：{len(docs)} 篇 / 切块 {total_chunks} 个 / 新写入 {total_new} 个 / 跳过 {skipped} 篇")
    print(f"耗时 {cost:.1f}s，embedding 请求 {embedder.calls} 次，tokens {embedder.tokens}")
    print(f"库内现有：文档 {info['docs']} 篇 / 切块 {info['chunks']} 个 / 向量 {info['vectors']} 条")
    if failed:
        print(f"\n失败 {len(failed)} 篇：")
        for key, err in failed:
            print(f"  - {key}: {err}")
        return 2
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    cfg = load_config()
    embedder = Embedder(cfg)
    vector = embedder.embed_query(args.query)

    with KBStore(cfg) as store:
        hits = store.search(
            vector,
            top_k=args.top_k,
            doc_type=args.type or None,
            min_score=args.min_score,
            query_text=args.query,
            keyword_weight=args.keyword_weight,
            max_per_doc=args.max_per_doc,
        )

    if not hits:
        print("没有命中。可能是阈值过高，或该主题尚未入库。")
        return 1

    print(f"查询：{args.query}\n命中 {len(hits)} 条\n")
    for i, hit in enumerate(hits, 1):
        head = f"{hit.title}"
        if hit.heading:
            head += f" › {hit.heading}"
        print(f"{i}. [{hit.score:.4f}] {head}")
        print(f"   来源 {hit.source}｜类型 {hit.doc_type}｜chunk #{hit.chunk_id}")
        body = hit.content.replace("\n", " ")
        print(f"   {body[:220]}{'…' if len(body) > 220 else ''}")
        print()
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    with KBStore(load_config()) as store:
        info = store.stats()
    print(f"库路径：{info['db_path']}")
    print(f"模型：{info['model']}（{info['dim']} 维）")
    print(f"文档 {info['docs']} 篇 ｜ 切块 {info['chunks']} 个 ｜ 向量 {info['vectors']} 条 ｜ 正文 {info['chars']:,} 字")
    if info["by_type"]:
        print("\n按类型：")
        for dtype, agg in info["by_type"].items():
            print(f"  {dtype:<10} {agg['docs']:>3} 篇  {agg['chunks'] or 0:>4} 块")
    return 0


def cmd_docs(args: argparse.Namespace) -> int:
    with KBStore(load_config()) as store:
        rows = store.list_documents(limit=args.limit)
    if not rows:
        print("库是空的，先执行：python -m kb.cli ingest")
        return 1
    print(f"{'doc_key':<42} {'类型':<8} {'块':>4} {'字':>6}  标题")
    print("-" * 100)
    for r in rows:
        print(f"{r['doc_key'][:42]:<42} {r['doc_type']:<8} {r['chunks']:>4} {r['chars']:>6}  {r['title'][:36]}")
    return 0


def cmd_reset(args: argparse.Namespace) -> int:
    if not args.yes:
        print("这会把知识库全部清空。确认请加 --yes")
        return 1
    cfg = load_config()
    with KBStore(cfg, create=True) as store:
        store.init_schema(reset=True)
        info = store.stats()
    print(f"已清空重建：{info['db_path']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="kb.cli", description="本地知识库（sqlite-vec）管理工具")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init", help="建表")
    s.add_argument("--reset", action="store_true", help="先删表再建")
    s.set_defaults(func=cmd_init)

    s = sub.add_parser("ingest", help="导入语料")
    s.add_argument("--only", choices=["skill", "faq", "doc"], help="只导某一类")
    s.add_argument("--faq", help="产品服务FAQ.xlsx 路径")
    s.add_argument("--csv", help="产品FAQ CSV 路径（优先于 --faq）")
    s.add_argument("--force", action="store_true", help="忽略内容指纹强制重算")
    s.add_argument("--max-chars", type=int, default=700, help="单块最大字符数")
    s.add_argument("--min-chars", type=int, default=120, help="单块最小字符数")
    s.set_defaults(func=cmd_ingest)

    s = sub.add_parser("search", help="检索自测")
    s.add_argument("query")
    s.add_argument("-k", "--top-k", type=int, default=5)
    s.add_argument("-t", "--type", help="按 doc_type 过滤")
    s.add_argument("--min-score", type=float, default=None, help="最低相似度，如 0.5")
    s.add_argument("--keyword-weight", type=float, default=0.2, help="关键词重排权重，0 为纯向量")
    s.add_argument("--max-per-doc", type=int, default=2, help="同一文档最多返回几条，0 不限")
    s.set_defaults(func=cmd_search)

    s = sub.add_parser("stats", help="库统计")
    s.set_defaults(func=cmd_stats)

    s = sub.add_parser("docs", help="文档清单")
    s.add_argument("--limit", type=int, default=200)
    s.set_defaults(func=cmd_docs)

    s = sub.add_parser("reset", help="清空重建")
    s.add_argument("--yes", action="store_true")
    s.set_defaults(func=cmd_reset)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except RuntimeError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())

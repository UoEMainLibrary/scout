#!/usr/bin/env python
"""
SCOUT
The University of Edinburgh, Heritage Collections
"""

import argparse
import ast
import importlib.util
import math
import re
import sys

sys.dont_write_bytecode = True

from pathlib import Path

import pandas as pd

# ------------------- Configuration -------------------

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"


def _load_config(suffix, module_key):
  candidates = sorted(CONFIG_DIR.glob(f"*.{suffix}.py"))
  if len(candidates) > 1:
    print(f"[✕] Found more than one config/*.{suffix}.py file: {', '.join(p.name for p in candidates)}")
    print(f"    └─ Keep at most one config/*.{suffix}.py file")
    sys.exit(1)

  if candidates:
    path = candidates[0]
  else:
    print(f"[✕] No {suffix} config found in config/")
    print(f"    └─ Create config/<yourname>.{suffix}.py - see config/{suffix}.py for the required fields")
    sys.exit(1)

  spec = importlib.util.spec_from_file_location(path.stem, path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  if not hasattr(module, module_key):
    print(f"[✕] config/{path.name} doesn't define a {module_key} dict")
    sys.exit(1)
  return getattr(module, module_key), path.name


institution_config, INSTITUTION_CONFIG_NAME = _load_config("priority", "CONFIG")
DIFFICULTY, DIFFICULTY_CONFIG_NAME = _load_config("difficulty", "DIFFICULTY")

REQUIRED_INSTITUTION_KEYS = [
  "priority_categories", "alpha", "volume_percentile",
  "priority_f_min", "priority_d_min", "priority_c_min", "priority_b_min", "priority_a_min",
  "pre_flagged_tag_prefix", "pre_flagged_tags",
  "dev_test_tags", "institutional_tags", "core_tags",
]
missing_keys = [k for k in REQUIRED_INSTITUTION_KEYS if k not in institution_config]
if missing_keys:
  print(f"[✕] config/{INSTITUTION_CONFIG_NAME} is missing: {', '.join(missing_keys)}")
  print("    └─ Compare against config/priority.py")
  sys.exit(1)

REQUIRED_DIFFICULTY_KEYS = [
  "difficulty_categories", "exec_time_percentile", "unstable_status_codes",
  "complex_platform_keywords", "robots_boilerplate_prefixes",
  "difficulty_f_min", "difficulty_d_min", "difficulty_c_min", "difficulty_b_min", "difficulty_a_min",
]
missing_keys = [k for k in REQUIRED_DIFFICULTY_KEYS if k not in DIFFICULTY]
if missing_keys:
  print(f"[✕] config/{DIFFICULTY_CONFIG_NAME} is missing: {', '.join(missing_keys)}")
  print("    └─ Compare against config/difficulty.py")
  sys.exit(1)

CONFIG = {**DIFFICULTY, **institution_config}

TAG_LIST_KEYS = ("institutional_tags", "core_tags", "dev_test_tags", "pre_flagged_tags")


def _index_tags(entries, list_name):
  try:
    return {entry["tag"]: entry for entry in entries}
  except (TypeError, KeyError):
    print(f"[✕] config/{INSTITUTION_CONFIG_NAME}: '{list_name}' entries must be "
          '{"tag": ..., "priority": n} dicts')
    sys.exit(1)


for _key in TAG_LIST_KEYS:
  CONFIG[_key] = _index_tags(CONFIG[_key], _key)


def _max_abs_points(tag_dict):
  vals = [abs(entry.get("priority", 0)) for entry in tag_dict.values()]
  return max(vals) if vals and max(vals) > 0 else 1

def _slugify(text):
  slug = re.sub(r"[^a-z0-9]+", "_", str(text).strip().lower())
  return slug.strip("_") or "source"

DEFAULT_REGISTRY_ID_COLUMNS = ("url", "host", "hostname", "domain", "site")
DEFAULT_FINGERPRINT_KEY_CANDIDATES = ("site url", "page url", "url", "host", "hostname", "domain", "site", "address")
DEFAULT_REPORT_KIND_STOPWORDS = {"report", "reports", "site", "sites", "totals", "total", "export", "data", "csv"}
DEFAULT_FAILED_STATUS_VALUES = {"failed"}

REGISTRY_ID_COLUMNS = tuple(institution_config.get("registry_id_columns") or DEFAULT_REGISTRY_ID_COLUMNS)
FINGERPRINT_KEY_CANDIDATES = tuple(institution_config.get("fingerprint_key_candidates") or DEFAULT_FINGERPRINT_KEY_CANDIDATES)
REPORT_KIND_STOPWORDS = set(institution_config.get("report_kind_stopwords") or DEFAULT_REPORT_KIND_STOPWORDS)
FAILED_STATUS_VALUES = set(institution_config.get("failed_status_values") or DEFAULT_FAILED_STATUS_VALUES)

FIELD_ALIASES = {
  field: [_slugify(a) for a in aliases]
  for field, aliases in (institution_config.get("field_aliases") or {}).items()
}

# ------------------- Terminal UI -------------------

class UI:
  SYMBOLS = {
    "info":  "[▪]",
    "ok":    "[✓]",
    "error": "[✕]",
    "issue": "[-]"
  }

  COLORS = {
    "cyan":   "\033[36m",
    "green":  "\033[32m",
    "red":    "\033[31m",
    "yellow": "\033[33m",
    "reset":  "\033[0m",
  }

  @classmethod
  def paint(cls, text, colour):
    return f"{cls.COLORS[colour]}{text}{cls.COLORS['reset']}"

  @classmethod
  def log(cls, kind, message):
    mapping = {
      "info":  ("info", "cyan"),
      "ok":    ("ok", "green"),
      "error": ("error", "red"),
      "issue": ("issue", "yellow"),
    }

    sym, col = mapping[kind]
    print(f"{cls.paint(cls.SYMBOLS[sym], col)} {message}")

  @staticmethod
  def line():
    print()

# ------------------- Ingest Multiple CSVs -------------------


def _find_key_column(normmap):
  for cand in FINGERPRINT_KEY_CANDIDATES:
    if cand in normmap:
      return normmap[cand]
  return None


def _normcols(df):
  return {re.sub(r"\s+", " ", str(c)).strip().lower(): c for c in df.columns}


def derive_report_kind(stem):
  tokens = [t for t in re.split(r"[^a-z0-9]+", stem.lower()) if t and not t.isdigit() and t not in REPORT_KIND_STOPWORDS]
  return "_".join(tokens) if tokens else "report"


def classify_csv(df, filename_stem=None):
  normmap = _normcols(df)
  normset = set(normmap.keys())

  if any(c in normset for c in REGISTRY_ID_COLUMNS) or df.shape[1] == 1:
    return "registry", normmap

  if _find_key_column(normmap) is not None:
    return (derive_report_kind(filename_stem) if filename_stem else "report"), normmap

  return None, normmap


def normalise_host_key(raw):
  if not isinstance(raw, str) or not raw.strip():
    return None
  h = raw.strip().lower()
  h = re.sub(r"^[a-z][a-z0-9+.-]*://", "", h)
  h = h.split("/", 1)[0]
  h = h.split("?", 1)[0].split("#", 1)[0]
  h = h.rstrip(".")
  return h or None


def uniqueness_signal(df):
  url_keys = set(df["url"].map(normalise_host_key).dropna())
  redirect_keys = df["redirect_to"].map(normalise_host_key)
  is_internal_duplicate = redirect_keys.notna() & redirect_keys.isin(url_keys)
  return (~is_internal_duplicate).astype(float)


def discover_csvs(folder):
  folder = Path(folder)
  return sorted(p for p in folder.glob("*.csv") if p.is_file())


def load_inputs(paths):
  report = []
  registry_candidates = []
  fingerprint_frames = {}

  for path in paths:
    try:
      df = pd.read_csv(path, low_memory=False)
    except Exception as exc:
      report.append(f"Skipped {path.name}: couldn't read as CSV ({exc})")
      continue

    kind, normmap = classify_csv(df, path.stem)

    if kind == "registry":
      registry_candidates.append((path, df, normmap))
    elif kind is not None:
      if kind in fingerprint_frames:
        report.append(
          f"Skipped {path.name}: another CSV already matched as '{kind}' fingerprint data "
          f"({fingerprint_frames[kind][0].name}), only one file per kind is used"
        )
        continue
      if _find_key_column(normmap) is None:
        report.append(
          f"Skipped {path.name}: matched {kind}'s data columns, but couldn't find a "
          f"per-site URL/host column to join it on"
        )
        continue
      fingerprint_frames[kind] = (path, df, normmap)
    else:
      cols_preview = ", ".join(list(df.columns)[:6]) + ("..." if len(df.columns) > 6 else "")
      report.append(f"Skipped {path.name}: didn't recognise its columns ({cols_preview})")

  if not registry_candidates:
    return None, {}, report, None

  registry_candidates.sort(key=lambda t: len(t[1]), reverse=True)
  registry_path, registry_df, registry_normmap = registry_candidates[0]

  for other_path, other_df, _ in registry_candidates[1:]:
    report.append(
      f"Skipped {other_path.name}: also looked like a registry export, but "
      f"{registry_path.name} has more rows, only one registry file is used per run"
    )

  fingerprints = {kind: (path, df) for kind, (path, df, _) in fingerprint_frames.items()}

  return registry_df, fingerprints, report, registry_path


def attach_fingerprints(registry_df, fingerprints):
  df = registry_df.copy()
  df["_match_key"] = df["url"].astype(str).map(normalise_host_key)

  coverage = {}

  for kind, (_path, fp_df) in fingerprints.items():
    normmap = _normcols(fp_df)
    key_col = _find_key_column(normmap)
    if key_col is None:
      coverage[kind] = 0
      continue

    fp = fp_df.copy()
    fp["_match_key"] = fp[key_col].astype(str).map(normalise_host_key)

    rename = {
      orig: f"fp_{kind}_{_slugify(norm)}"
      for norm, orig in normmap.items()
      if orig != key_col
    }
    fp = fp.rename(columns=rename)
    keep_cols = ["_match_key"] + [c for c in rename.values() if c in fp.columns]
    fp = fp[keep_cols].drop_duplicates(subset="_match_key", keep="first")

    before_cols = set(df.columns)
    df = df.merge(fp, on="_match_key", how="left")
    new_cols = [c for c in df.columns if c not in before_cols]
    coverage[kind] = int(df[new_cols[0]].notna().sum()) if new_cols else 0

  df = df.drop(columns=["_match_key"])
  return df, coverage

# ------------------- Loading and Cleaning -------------------

def dedupe_columns(df):
  seen = {}
  drop_cols = []
  for col in df.columns:
    base = re.sub(r"\.\d+$", "", col)
    if base in seen and base != col:
      first_col = seen[base]
      if df[first_col].astype(str).equals(df[col].astype(str)):
        drop_cols.append(col)
    else:
      seen[base] = col
  if drop_cols:
    df = df.drop(columns=drop_cols)
  return df


def guess_domain(hostname, core_domain):
  if not isinstance(hostname, str) or not hostname.strip():
    return ""
  h = hostname.strip().lower()
  if h.endswith(core_domain):
    return core_domain
  parts = h.split(".")
  return ".".join(parts[-2:]) if len(parts) >= 2 else h


def detect_core_domain(urls):
  hosts = urls.astype(str).str.strip().str.lower()
  labels = hosts.apply(lambda h: h.split("."))
  for n in (3, 2):
    candidates = labels.apply(lambda ls: ".".join(ls[-n:]) if len(ls) >= n else None).dropna()
    if candidates.empty:
      continue
    counts = candidates.value_counts()
    top_domain, top_count = counts.index[0], counts.iloc[0]
    if top_count / len(candidates) > 0.5:
      return top_domain
  return None


def normalise_column_names(df):
  seen = set()
  rename = {}
  for col in df.columns:
    norm = _slugify(col)
    if norm in seen or norm == col:
      continue
    seen.add(norm)
    rename[col] = norm
  return df.rename(columns=rename)


def normalise_input(df, cfg):
  df = df.copy()
  df = normalise_column_names(df)

  if "url" not in df.columns:
    match = next((c for c in REGISTRY_ID_COLUMNS if c in df.columns), None)
    if match:
      df = df.rename(columns={match: "url"})
    elif df.shape[1] == 1:
      df = df.rename(columns={df.columns[0]: "url"})
    else:
      UI.log("error", "Couldn't find a URL column - name one 'url' (or host/domain/site), "
                       "or supply a single-column CSV")
      sys.exit(1)

  df["url"] = df["url"].astype(str).str.strip()

  if not cfg.get("core_domain"):
    detected = detect_core_domain(df["url"])
    if not detected:
      UI.log("error", f"Couldn't auto-detect a core domain from this CSV - set 'core_domain' in config/{INSTITUTION_CONFIG_NAME}")
      sys.exit(1)
    cfg["core_domain"] = detected
    UI.log("info", f"No core_domain set in config/{INSTITUTION_CONFIG_NAME} - auto-detected '{detected}' from this CSV")

  if "domain_name" not in df.columns:
    df["domain_name"] = pd.NA
  if df["domain_name"].isna().all():
    df["domain_name"] = df["url"].apply(lambda u: guess_domain(u, cfg["core_domain"]))

  for name in ("total_pages", "total_pdfs", "total_sitemaps", "total_sitemap_pages"):
    col = find_registry_column(df, name)
    df[name] = pd.to_numeric(df[col], errors="coerce").fillna(0) if col else 0.0

  for name in ("execution_time_ms", "status_code"):
    col = find_registry_column(df, name)
    df[name] = pd.to_numeric(df[col], errors="coerce") if col else math.nan

  evergreen_col = find_registry_column(df, "evergreen")
  df["evergreen"] = df[evergreen_col].fillna(False).astype(bool) if evergreen_col else False

  for name in ("department_unit", "organisation_division", "owner", "reviewer",
               "robots", "redirect_to", "status", "tags"):
    col = find_registry_column(df, name)
    if col and col != name:
      df[name] = df[col]
    elif not col:
      df[name] = pd.NA

  return df


def parse_tag_list(raw):
  if not isinstance(raw, str) or not raw.strip():
    return []
  try:
    val = ast.literal_eval(raw)
    if isinstance(val, list):
      return [str(x) for x in val]
  except (ValueError, SyntaxError):
    pass
  return []

# ------------------- Shared Detection Helpers -------------------

def robots_blocks_all(robots_text):
  if not isinstance(robots_text, str) or not robots_text.strip():
    return False
  normalised = re.sub(r"\s+", " ", robots_text.strip().lower())
  return bool(re.search(r"user-agent:\s*\*\s*disallow:\s*/\s*(?:$|user-agent)", normalised))


def robots_disallow_paths(robots_text):
  if not isinstance(robots_text, str) or not robots_text.strip():
    return []
  normalised = re.sub(r"\s+", " ", robots_text.strip().lower())
  return re.findall(r"disallow:\s*(\S+)", normalised)


def robots_partial_block(robots_text, boilerplate_prefixes):
  if robots_blocks_all(robots_text):
    return False
  paths = robots_disallow_paths(robots_text)
  if not paths:
    return False
  return not all(any(p.startswith(bp) for bp in boilerplate_prefixes) for p in paths)


def hostname_looks_complex(url, keywords):
  if not isinstance(url, str):
    return None
  low = url.lower()
  tokens = set(re.split(r"[^a-z0-9]+", low))
  tokens.discard("")
  for kw in keywords:
    token = kw.strip(".").lower()
    if token and token in tokens:
      return kw
  return None


def tag_points(entry):
  return entry.get("priority", 0) if entry else 0


def tag_label(raw_tag, prefix=None):
  stripped = raw_tag.strip()
  if prefix and stripped.lower().startswith(prefix.strip().lower()):
    return stripped[len(prefix.strip()):].lstrip(" -")
  return raw_tag


def best_tag_score(tag_config, matched_tags):
  if not tag_config or not matched_tags:
    return 0
  fallback = max((tag_points(v) for v in tag_config.values()), key=abs, default=0)
  scores = [tag_points(tag_config[t]) if t in tag_config else fallback for t in matched_tags]
  return max(scores, key=abs, default=0)


def fmt_pts(n):
  n = round(n, 1)
  n = int(n) if float(n).is_integer() else n
  return f"+{n}" if n >= 0 else f"−{abs(n)}"

# ------------------- Normalisation -------------------

def clip01(series):
  return series.clip(lower=0.0, upper=1.0)


def normalise_percentile(series, percentile):
  logged = series.apply(lambda v: math.log1p(v) if pd.notna(v) and v >= 0 else math.nan)
  threshold = logged.quantile(percentile)
  if not pd.notna(threshold) or threshold <= 0:
    return pd.Series(math.nan, index=series.index, dtype="float64")
  return clip01(logged.astype("float64") / threshold)


def normalise_ratio(numerator, denominator):
  denom = denominator.where(denominator > 0)
  return clip01((numerator / denom).astype("float64"))


def weighted_aggregate(items, weights):
  index = next(iter(items.values())).index
  num = pd.Series(0.0, index=index)
  den = pd.Series(0.0, index=index)
  for name, series in items.items():
    w = weights.get(name, 0)
    present = series.notna()
    num = num + series.fillna(0.0) * w * present
    den = den + (w * present)
  return (num / den.where(den > 0)).astype("float64")


def weighted_subscore(signals, weights):
  return weighted_aggregate(signals, weights)


def weighted_total(category_subscores, category_weights):
  return (weighted_aggregate(category_subscores, category_weights).fillna(0) * 100).round(2)

# ------------------- Building Signals -------------------

def find_fingerprint_column(df, signal_name):
  wanted = set(signal_name.split("_"))
  candidates = []
  for col in df.columns:
    if not col.startswith("fp_"):
      continue
    identity = set(col[3:].split("_"))
    if wanted <= identity:
      candidates.append((len(identity), col))
  if not candidates:
    return None
  candidates.sort()
  if len(candidates) > 1 and candidates[0][0] == candidates[1][0]:
    return None
  return candidates[0][1]


def fp_series(df, signal_name):
  col = find_fingerprint_column(df, signal_name)
  return df[col] if col is not None else pd.Series(math.nan, index=df.index, dtype="float64")


def find_registry_column(df, field_name):
  for alias in FIELD_ALIASES.get(field_name, []):
    if alias in df.columns:
      return alias
  wanted = set(field_name.split("_"))
  candidates = []
  for col in df.columns:
    if col.startswith("fp_"):
      continue
    identity = set(col.split("_"))
    if wanted <= identity:
      candidates.append((len(identity), col))
  if not candidates:
    return None
  candidates.sort()
  if len(candidates) > 1 and candidates[0][0] == candidates[1][0]:
    return None
  return candidates[0][1]


def build_tag_signals(df, cfg):
  out = {}
  tag_lists = df["tags"].apply(parse_tag_list)
  out["tag_lists"] = tag_lists

  matched_inst = tag_lists.apply(lambda ts: [t for t in ts if t in cfg["institutional_tags"]])
  matched_core = tag_lists.apply(lambda ts: [t for t in ts if t in cfg["core_tags"]])
  out["matched_institutional_tags"] = matched_inst
  pts_inst = matched_inst.apply(lambda ts: best_tag_score(cfg["institutional_tags"], ts))
  pts_core = matched_core.apply(lambda ts: best_tag_score(cfg["core_tags"], ts))
  max_abs = max(_max_abs_points(cfg["institutional_tags"]), _max_abs_points(cfg["core_tags"]))
  raw = pd.concat([pts_inst, pts_core], axis=1)
  raw_best = raw.apply(lambda r: max(r, key=abs), axis=1)
  out["institutional_tag_signal"] = clip01(raw_best / max_abs)

  matched_dev = tag_lists.apply(lambda ts: [t for t in ts if t in cfg["dev_test_tags"]])
  out["flag_dev_test"] = matched_dev.apply(len).gt(0)
  out["pts_dev_test_priority"] = matched_dev.apply(lambda ts: best_tag_score(cfg["dev_test_tags"], ts))

  pre_prefix = cfg["pre_flagged_tag_prefix"].strip().lower()
  matched_pre = tag_lists.apply(lambda ts: [t for t in ts if t.strip().lower().startswith(pre_prefix)])
  out["matched_pre_flagged_tags"] = matched_pre
  out["flag_pre_flagged"] = matched_pre.apply(len).gt(0)
  out["pts_pre_flagged_priority"] = matched_pre.apply(lambda ts: best_tag_score(cfg["pre_flagged_tags"], ts))

  return out


def build_priority_signals(df, tags, cfg):
  s = {}
  s["institutional_tag"] = tags["institutional_tag_signal"]
  s["dept_or_division"] = (df["department_unit"].notna() | df["organisation_division"].notna()).astype(float)
  s["owner"] = df["owner"].notna().astype(float)
  s["core_domain"] = (df["domain_name"].fillna("") == cfg["core_domain"]).astype(float)
  s["uniqueness"] = uniqueness_signal(df)
  s["evergreen"] = df["evergreen"].astype(float)
  s["reviewer_assigned"] = df["reviewer"].notna().astype(float)

  volume = (df["total_pages"].fillna(0) + df["total_pdfs"].fillna(0)).clip(lower=0)
  s["content_volume"] = normalise_percentile(volume, cfg["volume_percentile"])
  s["sitemap_pages"] = normalise_percentile(df["total_sitemap_pages"].fillna(0), cfg["volume_percentile"])

  s["total_images"] = normalise_percentile(fp_series(df, "total_images"), cfg["volume_percentile"])
  s["total_technologies"] = normalise_percentile(fp_series(df, "total_technologies"), cfg["volume_percentile"])
  s["accessibility_score"] = clip01(fp_series(df, "accessibility_score").astype("float64") / 100)
  s["images_missing_alt"] = 1 - normalise_percentile(fp_series(df, "images_missing_alt"), cfg["volume_percentile"])

  return s


def build_difficulty_signals(df, cfg):
  s = {}
  flag_auth_required = df["status_code"].isin([401, 403])
  s["auth_required"] = flag_auth_required.astype(float)

  robots_blocked = df["robots"].apply(robots_blocks_all)
  s["robots_blocked"] = robots_blocked.astype(float)

  robots_partial = df["robots"].apply(lambda t: robots_partial_block(t, cfg["robots_boilerplate_prefixes"]))
  s["robots_partial_block"] = robots_partial.astype(float)

  complex_hit = df["url"].apply(lambda u: hostname_looks_complex(u, cfg["complex_platform_keywords"]))
  flag_complex = complex_hit.apply(lambda kw: isinstance(kw, str) and bool(kw))
  s["complex_platform"] = flag_complex.astype(float)

  exec_thr = df["execution_time_ms"].quantile(cfg["exec_time_percentile"])
  page_median = df["total_pages"].median()
  js_heavy_registry = ((df["execution_time_ms"] > exec_thr) & (df["total_pages"] <= page_median)).astype(float)
  js_heavy_fp = normalise_percentile(fp_series(df, "avg_lcp_ms"), cfg["exec_time_percentile"])
  s["avg_lcp_ms"] = js_heavy_fp.where(js_heavy_fp.notna(), js_heavy_registry)

  s["dom_nodes"] = normalise_percentile(fp_series(df, "dom_nodes"), cfg["exec_time_percentile"])
  s["broken_links"] = normalise_percentile(fp_series(df, "broken_links"), cfg["exec_time_percentile"])

  unstable = df["status_code"].isin(cfg["unstable_status_codes"]) | df["status"].isin(FAILED_STATUS_VALUES)
  s["unstable_status"] = unstable.astype(float)

  s["broken_images"] = normalise_percentile(fp_series(df, "broken_images"), cfg["exec_time_percentile"])
  s["console_errors_score"] = clip01(1 - fp_series(df, "console_errors_score").astype("float64") / 100)
  s["privacy_score"] = clip01(1 - fp_series(df, "privacy_score").astype("float64") / 100)
  s["security_score"] = clip01(1 - fp_series(df, "security_score").astype("float64") / 100)

  s["sitemap_absent"] = (df["total_sitemaps"].fillna(0) <= 0).astype(float)
  s["avg_page_weight_kb"] = normalise_percentile(fp_series(df, "avg_page_weight_kb"), cfg["exec_time_percentile"])
  s["avg_load_time_s"] = normalise_percentile(fp_series(df, "avg_load_time_s"), cfg["exec_time_percentile"])

  return s, flag_auth_required, robots_blocked, flag_complex, complex_hit, unstable

# ------------------- Category Rollup -------------------

def build_category_scores(signals, category_config, index):
  subscores, weights, labels = {}, {}, {}
  for cat, spec in category_config.items():
    sig_map = {name: signals[name] for name in spec["signals"] if name in signals}
    if not sig_map:
      subscores[cat] = pd.Series(math.nan, index=index, dtype="float64")
    else:
      sig_weights = {name: v["weight"] for name, v in spec["signals"].items()}
      subscores[cat] = weighted_subscore(sig_map, sig_weights)
    weights[cat] = spec["weight"]
    labels[cat] = spec.get("label") or cat.replace("_", " ").title()
  return subscores, weights, labels


def category_why(subscores, weights, labels, index):
  def row_text(i):
    parts = []
    for cat, sub in subscores.items():
      v = sub[i]
      pts = f"{v * weights[cat]:.1f}" if pd.notna(v) else "–"
      parts.append(f"{labels[cat]}: {pts}/{weights[cat]}")
    return " | ".join(parts) if parts else "No signal available in any category"
  return pd.Series([row_text(i) for i in index], index=index)

# ------------------- Grading -------------------

def _grade(score, cfg, prefix):
  if score >= cfg[f"{prefix}_f_min"]:
    return "F"
  if score >= cfg[f"{prefix}_d_min"]:
    return "D"
  if score >= cfg[f"{prefix}_c_min"]:
    return "C"
  if score >= cfg[f"{prefix}_b_min"]:
    return "B"
  if score >= cfg[f"{prefix}_a_min"]:
    return "A"
  return "A+"


def priority_grade(score, cfg):
  return _grade(score, cfg, "priority")


def difficulty_grade(score, cfg):
  return _grade(score, cfg, "difficulty")

# ------------------- Scoring Pipeline -------------------

def fingerprint_stage_label(df, kinds_present):
  if not kinds_present:
    return pd.Series("Stage 1 only", index=df.index)

  cols = {kind: [c for c in df.columns if c.startswith(f"fp_{kind}_")] for kind in kinds_present}

  def row_label(i):
    matched = [kind for kind, cs in cols.items() if cs and pd.notna(df.loc[i, cs[0]])]
    return f"Stage 2: {', '.join(matched)}" if matched else "Stage 1 only"

  return pd.Series([row_label(i) for i in df.index], index=df.index)


def when(flag, message):
  return flag.map({True: message, False: ""})


def build_review_flags(df, tags, difficulty_signals_extra, cfg):
  robots_blocked, flag_complex, complex_hit, unstable, flag_auth_required = (
    difficulty_signals_extra["robots_blocked"], difficulty_signals_extra["flag_complex"],
    difficulty_signals_extra["complex_hit"], difficulty_signals_extra["unstable"],
    difficulty_signals_extra["flag_auth_required"],
  )
  out = pd.DataFrame(index=df.index)
  out["flag_pre_flagged"] = tags["flag_pre_flagged"]
  out["reason_pre_flagged"] = out.apply(
    lambda r: (f"Pre-flagged in registry: "
               f"{', '.join(tag_label(t, cfg['pre_flagged_tag_prefix']) for t in tags['matched_pre_flagged_tags'][r.name])} "
               f"({fmt_pts(tags['pts_pre_flagged_priority'][r.name])})")
    if tags["matched_pre_flagged_tags"][r.name] else "",
    axis=1,
  )
  out["flag_auth_required"] = flag_auth_required
  out["reason_auth_required"] = when(out["flag_auth_required"], "Auth / SSO-restricted")
  out["flag_robots_blocked"] = robots_blocked
  out["reason_robots_blocked"] = when(out["flag_robots_blocked"], "robots.txt blocks all crawling")
  out["flag_complex_platform"] = flag_complex
  out["reason_complex_platform"] = complex_hit.apply(
    lambda kw: f"Complex / interactive platform: matched '{kw}'" if isinstance(kw, str) and kw else ""
  )
  out["flag_unstable"] = unstable
  out["reason_unstable"] = df["status_code"].apply(
    lambda sc: f"Unresolved / unstable: status {int(sc)}" if pd.notna(sc) and sc in cfg["unstable_status_codes"] else ""
  )
  page_thr = df["total_pages"].quantile(cfg["volume_percentile"])
  pdf_thr = df["total_pdfs"].quantile(cfg["volume_percentile"])
  out["flag_large_volume"] = (df["total_pages"] > max(page_thr, 100)) | (df["total_pdfs"] > max(pdf_thr, 20))
  out["reason_large_volume"] = out.apply(
    lambda r: (f"Large volume: {int(df.loc[r.name, 'total_pages'])} pages, {int(df.loc[r.name, 'total_pdfs'])} PDFs")
    if r["flag_large_volume"] else "",
    axis=1,
  )
  out["flag_dev_test"] = tags["flag_dev_test"]
  out["reason_dev_test"] = when(out["flag_dev_test"], "Dev/Test tagged")

  out["flag_off_estate"] = df["domain_name"].fillna("") != cfg["core_domain"]
  out["reason_off_estate"] = df["domain_name"].apply(
    lambda d: f"Off-estate domain: {d}" if isinstance(d, str) and d and d != cfg["core_domain"] else ""
  )
  out["flag_reviewer_assigned"] = df["reviewer"].notna()

  review_cols = ["flag_pre_flagged", "flag_auth_required", "flag_robots_blocked",
                 "flag_complex_platform", "flag_unstable", "flag_large_volume", "flag_dev_test"]
  out["needs_review"] = out[review_cols].any(axis=1)

  def categorise(row):
    if row["flag_pre_flagged"]:
      return "Pre-flagged in registry"
    if row["flag_auth_required"] or row["flag_robots_blocked"]:
      return "Access restricted"
    if row["flag_complex_platform"]:
      return "Complex / interactive platform"
    if row["flag_large_volume"]:
      return "Large volume"
    if row["flag_dev_test"]:
      return "Dev / Test"
    if row["flag_unstable"]:
      return "Unreachable / not yet resolved"
    return ""

  out["review_category"] = out.apply(categorise, axis=1)

  reason_cols = [c for c in out.columns if c.startswith("reason_") and c != "reason_off_estate"]
  out["issues_list"] = out[reason_cols].apply(lambda row: " | ".join(v for v in row if v), axis=1)

  return out


def score(df, cfg, fp_kinds_present=()):
  fp_kinds_present = sorted(fp_kinds_present)
  tags = build_tag_signals(df, cfg)
  priority_signals = build_priority_signals(df, tags, cfg)
  difficulty_signals, flag_auth_required, robots_blocked, flag_complex, complex_hit, unstable = build_difficulty_signals(df, cfg)

  priority_sub, priority_w, priority_labels = build_category_scores(priority_signals, cfg["priority_categories"], df.index)
  difficulty_sub, difficulty_w, difficulty_labels = build_category_scores(difficulty_signals, cfg["difficulty_categories"], df.index)

  priority_raw = weighted_total(priority_sub, priority_w)
  difficulty_raw = weighted_total(difficulty_sub, difficulty_w)

  priority_override = tags["pts_dev_test_priority"] + tags["pts_pre_flagged_priority"]

  priority_score_raw = (priority_raw + priority_override).clip(lower=0, upper=100).round(2)
  difficulty_score = difficulty_raw.clip(lower=0, upper=100).round(2)

  alpha = cfg.get("alpha", 0.15)
  priority_final = (priority_score_raw * (1 - alpha * (difficulty_score / 100))).round(2)

  priority_why = category_why(priority_sub, priority_w, priority_labels, df.index)
  difficulty_why = category_why(difficulty_sub, difficulty_w, difficulty_labels, df.index)

  stage_label = fingerprint_stage_label(df, fp_kinds_present)

  out = pd.DataFrame(index=df.index)
  out["priority_score"] = priority_final
  out["priority_score_raw"] = priority_score_raw
  out["priority_grade"] = out["priority_score"].apply(lambda v: priority_grade(v, cfg))
  out["priority_why"] = priority_why
  out["difficulty_score"] = difficulty_score
  out["difficulty_grade"] = out["difficulty_score"].apply(lambda v: difficulty_grade(v, cfg))
  out["difficulty_why"] = difficulty_why
  out["fingerprint_stage"] = stage_label
  out["matched_institutional_tags"] = tags["matched_institutional_tags"].apply(lambda ts: ", ".join(ts))

  flags = build_review_flags(df, tags, {
    "robots_blocked": robots_blocked, "flag_complex": flag_complex,
    "complex_hit": complex_hit, "unstable": unstable,
    "flag_auth_required": flag_auth_required,
  }, cfg)

  return out, flags

# ------------------- Crawl Parameters -------------------

def infer_site_type(df, tags, flags, cfg):
  has_inst_tag = tags["tag_lists"].apply(lambda ts: any(t in cfg["institutional_tags"] for t in ts))
  has_dept = df["department_unit"].notna() | df["organisation_division"].notna()

  def pick(i):
    if flags.loc[i, "flag_dev_test"]:
      return "Dev / Test"
    if has_inst_tag[i] or has_dept[i]:
      return "Institutional unit"
    if bool(df.loc[i, "evergreen"]):
      return "Evergreen content"
    return "Individual / Project (default)"

  return pd.Series([pick(i) for i in df.index], index=df.index)



# ------------------- Output -------------------

FRIENDLY_COLUMNS = {
  "url": "URL",
  "priority_rank": "Priority Rank",
  "priority_score": "Priority Score",
  "priority_score_raw": "Priority Score (Before Difficulty Discount)",
  "priority_grade": "Priority Grade",
  "priority_why": "Priority Why",
  "difficulty_grade": "Difficulty Grade",
  "difficulty_score": "Difficulty Score",
  "difficulty_why": "Difficulty Why",
  "fingerprint_stage": "Fingerprint Stage",
  "needs_review_label": "Needs Review?",
  "review_category": "Review Type",
  "issues_list": "Why Flagged",
  "inferred_site_type": "Inferred Site Type",
  "evergreen_label": "Evergreen?",
  "matched_institutional_tags": "Institutional Area",
  "department_unit": "Department / Division",
  "total_pages": "Total Pages",
  "total_pdfs": "Total PDFs",
  "status_code": "Last Status Code",
  "domain_name": "Domain",
  "off_estate_label": "Off Estate?",
  "reviewer_assigned_label": "Reviewer Assigned?",
}


def build_tidy_table(df, scored, flags, site_types, output_columns):
  work = pd.DataFrame(index=df.index)
  work["url"] = df["url"]
  for col in ("priority_score", "priority_score_raw", "priority_grade", "priority_why",
              "difficulty_grade", "difficulty_score", "difficulty_why", "fingerprint_stage",
              "matched_institutional_tags"):
    work[col] = scored[col]
  work["needs_review_label"] = flags["needs_review"].map({True: "Yes", False: "No"})
  work["review_category"] = flags["review_category"]
  work["issues_list"] = flags["issues_list"]
  work["inferred_site_type"] = site_types
  work["evergreen_label"] = df["evergreen"].map({True: "Yes", False: "No"})
  work["department_unit"] = df["department_unit"]
  work["total_pages"] = df["total_pages"]
  work["total_pdfs"] = df["total_pdfs"]
  work["status_code"] = df["status_code"]
  work["domain_name"] = df["domain_name"]
  work["off_estate_label"] = flags["flag_off_estate"].map({True: "Yes", False: "No"})
  work["reviewer_assigned_label"] = flags["flag_reviewer_assigned"].map({True: "Yes", False: "No"})

  work = work.sort_values("priority_score", ascending=False).reset_index(drop=True)
  work.insert(1, "priority_rank", work.index + 1)

  columns = [(col, label) for col, label in output_columns if col in work.columns]
  missing = [col for col, _ in output_columns if col not in work.columns]
  if missing:
    UI.log("issue", f"config output_columns names unknown field(s), skipped: {', '.join(missing)}")
  if not columns:
    columns = list(FRIENDLY_COLUMNS.items())

  work = work[[col for col, _ in columns]]
  work.columns = [label for _, label in columns]
  return work

# ------------------- Summary -------------------

def print_summary(registry_path, fingerprints, coverage, total, csv_path):
  UI.log("info", f"Registry: {registry_path.name} ({total:,} URIs)")

  kinds = sorted(fingerprints)
  if kinds:
    UI.log("info", "Signals matched:")
    width = max(len(k) for k in kinds)
    for i, kind in enumerate(kinds):
      branch = "└─" if i == len(kinds) - 1 else "├─"
      matched = coverage.get(kind, 0)
      pct = matched / total * 100 if total else 0
      fp_path, fp_df = fingerprints[kind]
      source = f"{fp_path.name} ({len(fp_df):,} rows)"
      print(f"    {branch} {kind:<{width}}  {source}, {matched:,} matched ({pct:.1f}%)")

  UI.line()
  UI.log("ok", f"{total:,} URIs graded, results saved to: {csv_path}")

# ------------------- Main -------------------

OUTPUT_PATH = Path("output") / "results.csv"
DEFAULT_INPUT_DIR = Path("input")


def write_outputs(df, scored, flags, site_types, cfg):
  OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
  output_columns = cfg.get("output_columns") or list(FRIENDLY_COLUMNS.items())
  tidy = build_tidy_table(df, scored, flags, site_types, output_columns)
  tidy.to_csv(OUTPUT_PATH, index=False)
  return OUTPUT_PATH


def run(csv_paths):
  cfg = dict(CONFIG)

  if len(csv_paths) == 1 and csv_paths[0].is_dir():
    discovered = discover_csvs(csv_paths[0])
    if not discovered:
      UI.log("error", f"No CSV files found in {csv_paths[0]}")
      sys.exit(1)
    csv_paths = discovered

  registry_df, fingerprints, report, registry_path = load_inputs(csv_paths)
  if registry_df is None:
    UI.log("error", "None of the given CSVs look like a registry export")
    sys.exit(1)

  for line in report:
    UI.log("issue", line)
  if report:
    UI.line()

  df = dedupe_columns(registry_df)
  df = normalise_input(df, cfg)
  df, coverage = attach_fingerprints(df, fingerprints)

  try:
    scored, flags = score(df, cfg, coverage.keys())
    site_types = infer_site_type(df, build_tag_signals(df, cfg), flags, cfg)
  except KeyError as exc:
    UI.log("error", f"Your registry export doesn't have a column recognisable as {exc} - "
                     "add one under that name (spaces/underscores/case don't matter) and rerun")
    sys.exit(1)

  path = write_outputs(df, scored, flags, site_types, cfg)
  print_summary(registry_path, fingerprints, coverage, len(df), path)
  return path


def main():
  parser = argparse.ArgumentParser(description="Grade every site in a registry export by Priority and Difficulty")
  parser.add_argument(
    "inputs", type=Path, nargs="*",
    help=f"CSV files or a folder of them - identified by columns, not filename. Defaults to '{DEFAULT_INPUT_DIR}/'.",
  )
  args = parser.parse_args()

  if not sys.stdout.isatty():
    UI.ENABLED = False

  inputs = args.inputs or [DEFAULT_INPUT_DIR]
  if not args.inputs and not DEFAULT_INPUT_DIR.exists():
    UI.log("error", f"No input given and the default '{DEFAULT_INPUT_DIR}/' folder doesn't exist")
    UI.log("issue", "Pass a folder or CSV files directly, e.g. python tools/scout.py path/to/csvs/")
    sys.exit(1)

  missing = [p for p in inputs if not p.exists()]
  if missing:
    for p in missing:
      UI.log("error", f"{p} not found")
    sys.exit(1)

  UI.line()
  print("SCOUT :: The University of Edinburgh, Heritage Collections")
  print("────────────────────────────────────────────────────────────")
  UI.line()

  run(list(inputs))

# ------------------- Entry Point -------------------

if __name__ == "__main__":
  main()
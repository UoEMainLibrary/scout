"""
SCOUT :: DIFFICULTY CONFIG
The University of Edinburgh, Heritage Collections

The four categories below map to Difficulty (technical appraisal) and can be renamed, reweighted, added to or removed freely
Signals are fixed identifiers that SCOUT computes internally, not free text, so keep them as they appear in your datasets
"""

DIFFICULTY = {

  "exec_time_percentile": 0.95,                        # percentile ceiling for page-weight/load-time signals
  "unstable_status_codes": {999, 500, 502, 503, 504},  # status codes treated as a failed/unreachable fetch

  # Hostname keyword, flagged as a complex/interactive platform

  "complex_platform_keywords": [
    "search", "booking", "portal", "dashboard", "moodle", "learn",
    "vle", "sso", "login", "cpanel", "webmail", "mail.", "admin",
    "shop", "store", "api.", "app.", "survey", "form.", "map.",
    "gis.", "database", "catalogue", "repository",
  ],

  # CMS admin-panel paths, ignored so routine boilerplate doesn't count against crawlability

  "robots_boilerplate_prefixes": (
    "/wp-admin", "/wp-includes", "/wp-login", "/xmlrpc.php",
    "/cgi-bin", "/umbraco", "/typo3", "/administrator",
  ),

  # ------------------- Difficulty Categories -------------------

  # Category weights sum to 100; signal weights sum to 1.0 within a category

  "difficulty_categories": {
    "access_barriers": {
      "label": "Access Barriers",
      "weight": 30,
      "signals": {
        "auth_required":        {"weight": 0.35},
        "robots_blocked":       {"weight": 0.35},
        "robots_partial_block": {"weight": 0.15},
        "privacy_score":        {"weight": 0.075},
        "security_score":       {"weight": 0.075},
      },
    },
    "structural_complexity": {
      "label": "Structural Complexity",
      "weight": 30,
      "signals": {
        "complex_platform": {"weight": 0.35},
        "avg_lcp_ms":       {"weight": 0.25},
        "dom_nodes":        {"weight": 0.15},
        "broken_links":     {"weight": 0.25},
      },
    },
    "instability": {
      "label": "Instability",
      "weight": 25,
      "signals": {
        "unstable_status":      {"weight": 0.55},
        "broken_images":        {"weight": 0.20},
        "console_errors_score": {"weight": 0.25},
      },
    },
    "crawl_cost": {
      "label": "Crawl Cost",
      "weight": 15,
      "signals": {
        "sitemap_absent":     {"weight": 0.34},
        "avg_page_weight_kb": {"weight": 0.33},
        "avg_load_time_s":    {"weight": 0.33},
      },
    },
  },

  # ------------------- Grading Bands -------------------

  # A+-F bands, 0-100

  "difficulty_a_min": 3,
  "difficulty_b_min": 18,
  "difficulty_c_min": 35,
  "difficulty_d_min": 50,
  "difficulty_f_min": 60,
  
}
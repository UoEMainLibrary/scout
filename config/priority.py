"""
SCOUT :: PRIORITY CONFIG
The University of Edinburgh, Heritage Collections

The four categories below map to Priority (archival values) and can be renamed, reweighted, added to or removed freely
Signals are fixed identifiers that SCOUT computes internally, not free text, so keep them as they appear in your datasets
"""

CONFIG = {

  "core_domain":       "example.ac.uk",  # leave unset to auto-detect
  "alpha":             0.15,             # Difficulty's max discount on Priority
  "volume_percentile": 0.95,             # percentile ceiling for volume-based signals

  # ------------------- Priority Categories -------------------

  # Category weights sum to 100; signal weights sum to 1 within a category

  "priority_categories": {
    "institutional_value": {
      "label": "Institutional Value",
      "weight": 35,
      "signals": {
        "institutional_tag": {"weight": 0.32},
        "core_domain":       {"weight": 0.20},
        "dept_or_division":  {"weight": 0.16},
        "owner":             {"weight": 0.12},
        "uniqueness":        {"weight": 0.20},
      },
    },
    "evidential_value": {
      "label": "Evidential Value",
      "weight": 15,
      "signals": {
        "evergreen":         {"weight": 0.60},
        "reviewer_assigned": {"weight": 0.40},
      },
    },
    "informational_richness": {
      "label": "Informational Richness",
      "weight": 35,
      "signals": {
        "content_volume":      {"weight": 0.26},
        "sitemap_pages":       {"weight": 0.14},
        "total_images":        {"weight": 0.17},
        "accessibility_score": {"weight": 0.26},
        "images_missing_alt":  {"weight": 0.17},
      },
    },
    "format_intrinsic_value": {
      "label": "Format / Intrinsic Value",
      "weight": 15,
      "signals": {
        "total_technologies": {"weight": 1.0},
      },
    },
  },

  # ------------------- Tag Vocabulary -------------------

  # Add your own tags below, each weighted by priority

  "institutional_tags": [
    {"tag": "Example Tag", "priority": 3},
  ],
  "core_tags": [
    {"tag": "Core", "priority": 3},
  ],
  "dev_test_tags": [
    {"tag": "Dev/Test Sites", "priority": -20},
  ],

  "pre_flagged_tag_prefix": "For Review",
  "pre_flagged_tags": [
    {"tag": "For Review - Example", "priority": -15},
  ],

  # ------------------- Grading Bands -------------------

  # A+-F bands, 0-100

  "priority_f_min": 67,
  "priority_d_min": 47,
  "priority_c_min": 32,
  "priority_b_min": 17,
  "priority_a_min": 9,
  
}
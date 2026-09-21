# SCOUT (Scoring for Capture Ordering and Urgency in Triage)

*SCOUT* is a configurable framework for scalable web archiving triage. It transforms registry metadata and website-derived signals into Priority ([archival value](https://dictionary.archivists.org/entry/archival-value.html)) and Difficulty ([technical appraisal](https://dictionary.archivists.org/entry/technical-appraisal.html)) scores using an adaptable appraisal algorithm inspired by the [Library of Congress Web Archiving Program's appraisal rubric](https://digital.library.unt.edu/ark:/67531/metadc1996915/m1/7). The rubric, weights, scoring and grading can be configured for different practices of archival consignation.

The reference implementation uses [Little Forest (LEAF)](https://leaf.littleforest.co.uk), with an optional [userscript](#scout-userscript) for displaying results and checking web archivability via [⁠CLEAR+](https://archiveready.com).

*SCOUT* was developed to support web archiving at [Heritage Collections, The University of Edinburgh](https://library.ed.ac.uk/heritage-collections).

## Installation

   1. Clone the repository:

      ```bash
      git clone https://github.com/UoEMainLibrary/scout.git
      cd scout
      ```

   2. Install Python ([download Python](https://python.org/downloads))

   3. Install dependencies:

      ```bash
      pip install -r requirements.txt
      ```

## Usage

1. Add your data: Put your website registry export in [`input/⁠`](input/). You can also add supplementary data for *SCOUT* to use in scoring, such as technical, accessibility or performance assessments.

2. Configure *SCOUT*: Copy the [example config files](config/) and customise them for your needs. Instructions are included in each file:

   ```bash
   cp config/priority.py config/<yourname>.priority.py
   cp config/difficulty.py config/<yourname>.difficulty.py
   ```

3. Run *SCOUT*:

   ```bash
   python tools/scout.py
   ```

    By default, *SCOUT* scores everything in [`input/⁠`](input/). You can also pass a specific file or folder:

   ```bash
   python tools/scout.py path/to/your/export.csv
   ```

4. View the results: Results are written to [`output/⁠`](output/), ranked by Priority. Each row includes:

   - `priority_grade` / `difficulty_grade`: A+ to F
   - `priority_why` / `difficulty_why`: which categories drove the grade
   - `needs_review_label` / `review_category`: whether and why, a site needs an archivist's attention
   - `inferred_site_type`: the site type *SCOUT* inferred (institutional unit, evergreen content, dev/test, or individual/project)

## *SCOUT* Userscript (Little Forest (LEAF) Integration)

Optional for [Little Forest (LEAF)](https://leaf.littleforest.co.uk) this displays results and provides a web archivability check via [⁠CLEAR+](https://archiveready.com).

   1. Install a userscript manager such as Tampermonkey ([install Tampermonkey](https://tampermonkey.net))

   2. Open the userscript in your browser ([open userscript](https://github.com/UoEMainLibrary/scout/raw/refs/heads/main/tools/scout.user.js))

   3. Wait for Tampermonkey to detect the userscript, then click **Install**

   4. In Little Forest (LEAF), click **SCOUT** from the top navigation and upload [output/results.csv](/output/results.csv).

   5. Hover over a grade to see its breakdown. Click 🔍 next to a Difficulty grade to run a CLEAR+ web archivability check.

## Credits

Developed by David Mahoney at [Heritage Collections, The University of Edinburgh](https://library.ed.ac.uk/heritage-collections).

## Citing

If you use, implement, or reference this project, please cite it as '*SCOUT*' and include clear attribution in publications, software, or documentation where appropriate.

## Licenses

*SCOUT* is licensed under [Apache 2.0](https://www.tldrlegal.com/license/apache-license-2-0-apache-2-0). For full licensing details, see the [LICENSE](/LICENSE) file.
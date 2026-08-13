# Employee Performance & Scorecard Module — Design Proposal

Draft v1 — 2026-08-13. For discussion, not yet implemented.

## What exists today (foundation to build on)

- `employees` table with a single `performance_rating` (%) field, edited in Settings.
- `employee_performance_history` — date-effective ratings; Contributions already
  picks the rating effective on-or-before each task date. **This mechanism is good
  and should stay the single "official" pay-linked number.**
- Recruitment module: `job_positions`, `job_applications`, interviews, offers,
  applicant profile page, activity timeline.
- Insights: Contribution Analysis / Earnings by Role already compute per-task,
  per-employee earnings and output data — a ready-made source of *objective*
  performance signals.
- Public-token form pattern (`/careers/apply`, `/intake`, `/start`) — reusable for
  letting applicants/employees submit their own data for HR to verify.

## 1. Navigation: a proper HR section

Today "HR & Payroll" sits under Finance and Employees live inside Settings.
Proposal: new sidebar section **HR** containing:

| Item | Route | Notes |
|---|---|---|
| Employees | `/dashboard/employees` | New list page (moved out of Settings; Settings keeps admin-only employee account controls). `employees/[id]` profile page — the folder already exists, empty. |
| Performance | `/dashboard/employees/performance` | Scorecards, reviews, drafts |
| HR & Payroll | `/dashboard/payroll` | Moves here from Finance (or stays in both) |
| Recruitment items | existing routes | Promote from "Advanced" when hiring starts |

Employee profile page tabs: Overview · Scorecard · Performance History ·
Payroll · Tasks/Contributions · Documents · Timeline (reuse `<TimelineTab>`).

## 2. One scorecard engine, two subjects

A single **Assessment** system that can point at either:

- an **applicant** (`job_application_id`) — scored from CV + interview + test task
- an **employee** (`employee_id`) — scored at hire, then re-assessed periodically

Same criteria tree, same math, so an applicant's hiring scorecard becomes their
day-1 employee baseline when they join. No duplicate data entry.

### Assessment lifecycle (covers "draft or just measure")

`draft → submitted → approved → applied` (+ `measure_only`)

- **Draft** — HR fills sliders over multiple sessions, nothing counts.
- **Submitted/Approved** — locked snapshot, visible in history.
- **Applied** — writes one row into the existing `employee_performance_history`
  (with reason = "Assessment 2026-H1" and a link back to the assessment).
  Payroll/Contributions keep working exactly as they do now.
- **Measure only** — approved but never applied; useful for benchmarking an
  applicant, or checking an employee mid-year without touching pay.

### Criteria tree (template-driven, per designation)

Templates are configured in Settings (like Designations), so a Designer template
lists Photoshop/Illustrator/Figma while an Accounts template lists Tally/Excel.
Each group has a **weight** (must total 100%), each sub-item has its own weight
inside the group.

1. **Experience** — repeating entries: company, company tier
   (multiplier: local shop 0.6 / agency 0.8 / known brand 1.0 / MNC 1.2),
   years at each, relevance to the role (0–100). Score auto-computes from
   Σ(years × tier × relevance) with **diminishing returns** (e.g. capped curve —
   year 8 adds much less than year 2), so one long irrelevant job can't dominate.
2. **Skills & Knowledge** — skill library per designation + Cirqle-general
   skills; slider each, with a "verified how?" tag (claimed / interview /
   test task / observed on the job).
3. **Tools & Software** — tool library; each tool has sub-sliders:
   *Tool knowledge · Hands-on experience · Output speed · Output quality*.
   (Your Photoshop example, generalized to every tool.)
4. **Responsibilities / Versatility** — checklist of Cirqle task types beyond the
   designation (e.g. a designer who can also shoot video, handle client calls,
   write captions). Score = coverage × proficiency. This is the "what else can
   they do for Cirqle" number.
5. **Communication & Personality** — languages (slider per language: Malayalam,
   Hindi, English, Arabic…), plus HR-internal sliders: clarity, client-facing
   confidence, teamwork, attitude/passion, reliability.

Suggested additional criteria (pick what fits):

- **Ownership & initiative** — do they need follow-up or do they drive work?
- **Learning agility** — how fast they picked up new tools since last review
  (auto-suggestable: new tools that appeared in their completed tasks).
- **Discipline & dependability** — attendance, deadline adherence (auto).
- **Growth since last review** — delta vs previous assessment, shown automatically.
- Applicant-only: notice period, salary expectation vs budget, portfolio quality,
  test-task score, reference check result.

### Self-submission + HR verification (your "receive data from their side")

Reuse the public-token form pattern: send an applicant/employee a link where they
fill Experience, Skills, Tools, Languages themselves. Their answers land as
**unverified claims**; HR reviews each entry and marks it verified/adjusted/
rejected before it counts. The scorecard shows the verification status per line —
that *is* the transparency story.

## 3. Auto-calculated vs HR-judged (what to automate)

Split every criterion into one of two types:

**Auto (system-computed, refreshed by cron):**
- **Tenure at Cirqle** — auto-increments yearly on work anniversary (this is your
  "each year need to increase" — a cron adds the tenure bump, optionally
  auto-creating a draft history entry HR just approves).
- **Task throughput & on-time %** — from tasks data.
- **Rework/revision rate** — approval iterations per task.
- **Output value** — from Contribution Analysis (earnings attributed per person —
  already computed in Insights; the scorecard just reads it).
- **Versatility (observed)** — distinct task types actually completed.

**HR-judged (sliders):** skills depth, tool quality, communication, attitude.

Final % = weighted blend, e.g. 40% auto-metrics + 60% assessed (configurable per
template). Auto side keeps it honest and effortless; assessed side keeps human
judgment. In Insights, add a **Performance** report: score trends per employee,
team distribution, score vs. salary scatter, score vs. contribution earnings —
the last one shows whether ratings actually track output.

## 4. The pay problem — the important design decision

The tension you described: high measured % → person expects/costs more pay, so
you're tempted to *record a lower %* to keep pay down — but you also want
transparency.

**Recommendation: don't solve it by lowering the score. Split the two numbers.**

- **Competency Score** — the honest scorecard output. Never fudged. This is what
  you show the employee: here's where you are, here's exactly which sliders to
  move to grow. If you fudge it, employees will eventually notice the math
  doesn't add up and the transparency backfires — and your historical data
  becomes useless for real decisions.
- **Pay-linked Performance %** (the existing `performance_rating`) — a separate
  business decision *informed by* the score, set via a **pay band / multiplier**:
  e.g. `performance_rating = competency × band_factor`, where band_factor
  reflects budget, market, and growth-headroom policy.

How this answers "get quality people at lower pay, keep them passionate":

- **Hire on value ratio, not raw score.** Rank applicants by
  `competency ÷ expected salary`. A passionate 70% person at 60% of the budget
  often beats a 90% person at 130% — and the scorecard makes that trade-off
  explicit instead of gut-feel.
- **Add a Potential/Trajectory criterion** (learning agility, passion,
  self-taught evidence). High-potential mid-score hires are exactly the
  "make them productive" group — the tool library shows precisely which skills
  to train to raise their score cheapest.
- **Transparent growth ladder instead of hidden markdowns:** "You're at 68%.
  Bands: 60–70 → ₹X, 70–80 → ₹Y. At your annual review, moving these three
  sliders gets you to the next band." The employee sees a fair path up; you get
  a motivated person working toward measurable targets; nobody's number was
  ever faked downward.
- Optionally start new joiners with a **probation band factor** (e.g. 0.85 for
  6 months) — openly stated — rather than a secretly lowered score.

## 5. Data model sketch

```
assessment_templates      (id, name, designation_id, auto_weight, assessed_weight)
assessment_criteria       (template_id, group, label, weight, kind: slider|auto|experience|language|tool, config jsonb)
tool_library / skill_library (per designation, reusable across templates)
assessments               (id, employee_id | application_id, template_id, status,
                           final_score, auto_score, assessed_score, band_factor,
                           applied_history_id → employee_performance_history)
assessment_scores         (assessment_id, criteria_id, value, verified_by, source: self|hr|auto, note)
assessment_experience     (assessment_id, company, tier, years, relevance, verified)
```

Existing `employee_performance_history` untouched — assessments feed it on
"Apply". Permissions: `hr.assess`, `hr.assess_approve`, `hr.view_scores`
(+ employee self-view of own scorecard only).

## 6. Suggested build order

1. Employees section + profile page (move out of Settings) — standalone win.
2. Scorecard engine + templates + manual assessment for current employees,
   with draft/measure-only/apply flow into performance history.
3. Applicant scoring inside the existing recruitment profile page.
4. Auto-metrics blend (tenure cron, task stats, contribution feed) + Insights
   Performance report.
5. Self-submission portal link + verification queue.

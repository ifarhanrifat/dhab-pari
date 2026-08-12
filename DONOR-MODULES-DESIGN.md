# Esal-e-Sawab · Zakat · Kafalat — design and flow

Research and proposed flow for three new donor-account modules. Nothing here is
built yet. Read the three constraints first — they change the shape of all three
features, and two of them contradict assumptions in the original brief.

---

## Three constraints that shape everything

### 1. Zakat money is not the committee's money

Zakat is a **restricted fund**. Every serious zakat-handling organisation
segregates it completely — separate account, separate reporting, never mixed
with general donations ([Penny Appeal zakat policy](https://www.pennyappealusa.org/zakat-policy/)).
Three rules follow, and the software should enforce all three rather than
relying on the accountant remembering them:

- **Tamleek** — ownership must pass to the recipient. Zakat cannot buy an asset
  the committee owns, cannot pay a contractor, cannot fund overheads.
- **Zakat can never fund Esal-e-Sawab.** A water cooler is not tamleek to a poor
  person. If a donor marks a donation as zakat, the memorial catalogue must be
  closed to it.
- **Zakat-funded Kafalat has to route through the guardian**, not the school.
  Paying a school directly is the committee spending zakat on the child's
  behalf, which fails tamleek in the stricter view. Sadqa-funded kafalat can pay
  the school directly. So the funding source of each sponsorship changes how the
  money physically moves — the system has to track it per child per source.

### 2. A sadqa-e-jariya object stops belonging to the donor

The brief says the water cooler *"will belong to only that donor."* In fiqh it
does not. Once dedicated for public benefit it is **waqf** — the donor cannot
reclaim it, sell it, or have it removed
([International Waqf Fund](https://waqf.org/sadaqah-jariyah/)). What the donor
keeps is the **attribution** (the plaque) and the ongoing reward, which is the
whole point of esal-e-sawab.

This is not a technicality. If the register records the cooler as the donor's
property, then when the donor emigrates, dies, or falls out with the committee,
the village has a dispute over a public water cooler. Record it as a
**committee-held waqf asset permanently attributed to the named person**, with
the committee as *mutawalli* (trustee) carrying a duty to maintain. The donor
proposes the site and the dedication; the committee approves and thereafter
owns the responsibility.

### 3. The register is the asset, not the feature

Zakat and Kafalat both need the same thing underneath: **a physically verified,
identity-protected register of who in the village genuinely needs help.**

Build that once and it also serves Fitrana, Qurbani meat distribution, Ramadan
ration bags, emergency medical help, and the winter blanket run. Build it three
times and you will have three registers that disagree with each other, and the
first time they disagree in public the committee loses the village's trust.

**Recommendation: build the Verified Needs Register first, as its own module.
Zakat and Kafalat are then two consumers of it.**

---

## A — Esal-e-Sawab (Sadqa-e-Jariya)

A donor funds a lasting object for public benefit, dedicated to a deceased
relative, carrying a plaque.

### The catalogue

The committee defines item types up front, each with an indicative capital cost
**and an indicative annual running cost**. The running cost is the part every
programme underestimates, and it is what turns a gift into a burden.

| Item | Capital (indicative) | Annual running | Notes |
|---|---|---|---|
| Water cooler (mosque / school / chowk) | Rs 45,000 | Rs 8,000 | Electricity, filter changes, seasonal repair |
| Hand pump | Rs 25,000 | Rs 2,000 | Washers, handle |
| Submersible pump + tank | Rs 120,000 | Rs 15,000 | Electricity is the real cost |
| **Solar street light** | Rs 35,000 | Rs 1,500 | No electricity bill; battery every 3–4 yrs |
| Bus-stop shelter / bench | Rs 60,000 | Rs 1,000 | Paint, minor repair |
| Mosque fans / cooling | Rs 30,000 | Rs 4,000 | |
| Janaza (funeral) equipment | Rs 40,000 | Rs 2,000 | Chairs, bier, shamiana |
| Wheelchair / walking aids | Rs 15,000 | Rs 500 | Lent out, returned |
| School desks (set) | Rs 25,000 | Rs 1,000 | |
| Graveyard boundary / gate | Rs 150,000 | Rs 3,000 | |
| Filtration plant | Rs 400,000 | Rs 40,000 | Committee should think hard before accepting |

Costs are placeholders — the committee sets real ones in Settings, in the same
place bill rates live.

### Who pays to keep it running — three modes, chosen at offer time

1. **Donor-maintained** — the donor commits to a recurring maintenance
   contribution (reuse `recurring_schedules`). The system tracks it and flags
   when it lapses.
2. **Committee-maintained** — the donor gives the object only. The committee
   accepts an open-ended liability.
3. **Endowed** — the donor gives the object *plus* a lump sum whose income (or
   drawdown) funds maintenance. Classic waqf, and the only one that is actually
   sustainable at scale.

**Governance feature that matters:** before the committee accepts a
committee-maintained object, the approval screen shows *the total annual
maintenance liability already accepted across all live objects*. Twenty donated
water coolers is Rs 160,000/year of running cost that nobody voted for. The
committee should see that number before adding the twenty-first.

### Flow

**Portal (donor)**
1. Browse catalogue → pick item type (or propose something not listed).
2. Dedication: *in memory of* — name, relationship (father/mother/brother/sister/
   other), and a short note. **Plaque text is limited to ~30 characters** —
   this is standard practice ([Children of Adam](https://childrenofadam.org/news/water-hand-pump-sadaqah-jariyah/))
   and prevents a plaque nobody can read. Show a live plaque preview.
3. Proposed location — pick from committee-suggested sites, or describe/pin one.
4. Maintenance mode (the three above).
5. Submit → becomes a **proposal**, not a donation. No money is taken yet.

**Admin (committee)**
6. Proposal lands in a queue. A member surveys the site.
7. Committee decision via the existing multi-approver flow (`approval_requests`)
   — approve, approve-with-different-site, or decline with reason.
8. On approval the donor is notified and pays. Money lands in a
   **per-object restricted fund account** (same pattern as project accounts).
9. Procurement, installation. Photos required: the installed object, and a
   close-up of the plaque. The plaque photo is what the family will want to
   share and what makes the donor's next donation likely.
10. Status becomes **In Service**. Auto-posts to the news belt: *"A water cooler
    has been installed at the Jamia Masjid, dedicated to the late Muhammad Aslam
    — donated by his son."*

**Lifecycle after that**
- `proposed → approved → funded → procured → installed → in_service → needs_repair → retired`
- On retirement/replacement, **the plaque and dedication carry to the
  replacement.** This matters enormously to the family and costs nothing.
- Annual condition check, logged, visible to the donor.

### Public page

A **Sadqa-e-Jariya board** — every installed object, its plaque, where it is,
and whether it is currently working. Plus the catalogue with prices, as a
prompt. Seeing thirty working objects with thirty family names on them is the
most persuasive fundraising page the site will have. The "currently working"
column is also what keeps the committee honest about maintenance.

---

## B — Zakat

### The problem being solved

The brief states it exactly: zakat tends to reach *one* visible needy person
repeatedly while others get nothing. The fix is to remove the donor from the
choice entirely — donors fund a pool, and a verified register decides the split
by a rule fixed in advance.

### Precedent this rests on

This is not an invention. The **Punjab Zakat & Ushr Department** runs exactly
this model: *istehqaq* (eligibility) is determined by the **Local Zakat & Ushr
Committee of the applicant's own area of residence**, using criteria of adult
Muslim, below poverty line, unemployed, preference to widows and the disabled,
not a habitual beggar — with a Guzara Allowance of Rs 2,000/month
([Zakat & Ushr Department, Punjab](https://zakat.punjab.gov.pk/guzara-allowance)).

The village committee is doing locally what the Local Zakat Committee does
officially. Say so on the page — it answers "who gave you the authority?" before
anyone asks.

### The eight asnaf — record which door each household came through

Zakat has eight eligible categories (Qur'an 9:60), not one
([MUIS](https://www.zakat.sg/8-asnaf-of-zakat/)). The register should record the
category, because "poor" is not the only door:

`faqir` (destitute) · `miskin` (needy) · `amil` (zakat workers) · `muallaf` ·
`riqab` · **`gharim` (crushed by debt)** · `fi_sabilillah` · `ibn_us_sabil`
(stranded traveller)

`gharim` is the one villages forget. A man with a house and a job but Rs 400,000
of hospital debt is eligible. So is a stranded traveller passing through.

### Identity protection — the architecture, not just a promise

The brief promises registrants their name will never be revealed. That promise
has to be structural, or it will leak the first time someone exports a report.

- Every beneficiary gets a code: **`MST-0042`**. The code is what appears in the
  ledger, the voucher, the audit log, every report and every export.
- Names, CNIC, address and survey photos live in a separate table readable
  **only by a `zakat_verifier` role** (2–3 named committee members). Not the
  accountant. Not other admins. Not super-admin-by-default.
- Everyone else reads a **view** exposing only: code, asnaf category, household
  size, dependants, eligibility status, verified-until date.
- The donor and public side sees **aggregates only**: *"37 verified households ·
  14 widow-headed · 22 with school-age children · 5 with a disabled member."*
- The accountant can disburse to `MST-0042` without ever learning who that is.

This mirrors sponsorship-sector practice, where child records are deliberately
stripped of last names and identifying details before any donor sees them
([World Vision child protection policy](https://www.worldvision.org/sponsor-a-child/support-center/child-security-protection-privacy-policy)).

### Getting onto the register — three routes

Self-registration alone will under-collect badly. The people most in need are
often the least likely to fill in a form, and in a village of a few hundred
families, applying publicly is humiliating.

1. **Self-registration** via the portal, with the anonymity promise stated
   plainly in Urdu on the form itself.
2. **Committee survey** — a member registers a household during a door-to-door
   survey. This will be the main route.
3. **Neighbour nomination** — any portal user flags a household. The committee
   then approaches the family privately. **The family's consent is required
   before verification proceeds** — nobody gets put on a poverty list by a
   neighbour without knowing.

### Verification

- **Two members minimum, never one.** This protects the household from a single
  gatekeeper and protects the verifier from accusation. Reuse the existing
  `approval_requests` / `approval_confirmations` machinery — it already does
  "N people must confirm".
- Structured survey: household size, dependants, earning members, income,
  housing (own/rent/kacha), land, livestock, disability, widow/orphan status,
  debts, existing government support (BISP / Rahmat Card — avoid double-dipping
  or at least record it).
- **Photograph the house, not the people.** Dignity, and it is sufficient
  evidence.
- Decision recorded with reasons. **Eligibility expires** — set
  `verified_until` (recommend 12 months). Circumstances change; a register that
  never expires slowly becomes fiction.

### Conflict of interest — non-negotiable

Zakat cannot go to the giver's own parents, grandparents, children,
grandchildren or spouse. Beyond fiqh, the fastest way for a village committee to
destroy its reputation is for the zakat to visibly land on committee members'
relatives.

**Every verifier declares a relationship to each household before voting, and is
blocked from approving where a relationship exists.** The declaration is stored
and appears in the distribution report. Build it in from day one — retrofitting
it later looks like a response to an accusation.

### Distribution round

1. **Open a round** (e.g. Ramadan 1447). Set the formula **before collection
   begins** — this is the transparency mechanism. A rule written after the total
   is known can be tuned to favour someone; a rule written before it cannot.
2. **Formula.** The brief asks for an equal split. Pure equality is the most
   defensible against favouritism, but gives a widow with six children the same
   as a single elderly man. Recommended default:

   > **equal base per household + a fixed increment per dependant**

   Both numbers configurable, and the increment can be set to zero for pure
   equality. Whatever is chosen is printed at the top of the distribution list.
3. **Freeze the eligible list** at round open. No additions mid-round.
4. Collect. Zakat donations land in the segregated zakat account only.
5. **Compute** — the system divides by the formula and produces the disbursement
   list, by code.
6. **Hand over.** Receipt per household, with thumbprint or signature.
   Cash or in-kind (ration, fees paid, medicine) — record which.
7. **Close and publish** the aggregate report: collected, households, per-household
   amount, formula used, distribution date, verifier names. No beneficiary names,
   ever.

**Warn if zakat sits undistributed.** Zakat should reach people promptly. A
dashboard warning after (say) 60 days of an idle balance is a real safeguard.

### Donor experience

- Mark a donation as **Zakat** at the point of giving (the flag must exist on
  every donation route: portal, manual entry, collector).
- Zakat page shows: current round, collected so far, verified household count,
  projected per-household amount, distribution date.
- After distribution: the aggregate report, signed.
- **The donor never picks a recipient.** That is the feature, not a limitation —
  say so on the page.

### Worth adding: a nisab calculator

Standard on every serious zakat site, and it drives collection — most people
don't give because they don't know what they owe. Gold/silver rates maintained
in Settings.

### Worth adding: Ushr

Chakwal is farming country — wheat and groundnut. **Ushr** (5%/10% on
agricultural produce) is zakat's rural twin and is almost entirely uncollected
by village committees. Same register, same distribution machinery, seasonal
timing at harvest. Low extra build cost, potentially significant collection.

---

## C — Kafalat (sponsorship)

### What established programmes actually cost and provide

| Organisation | Monthly | Covers |
|---|---|---|
| [Islamic Relief](https://islamic-relief.org/orphan-sponsorship-programme/) | ~$70 | Education, food, shelter, medical |
| [Muslim Hands USA](https://muslimhandsusa.org/appeals/sponsor-an-orphan) | ~$45 | |
| [Muslim Hands Canada](https://muslimhands.ca/our-work/orphans) | ~$60 | School fees, annual uniform, books & stationery, medical checks, food, transport where possible |

Muslim Hands Canada's breakdown is almost exactly the brief's list. For a
Chakwal village a realistic annual package per child:

| Line | Annual (Rs) |
|---|---|
| School fees | 24,000 |
| Uniform (2 sets + shoes) | 8,000 |
| Books & stationery | 6,000 |
| Transport | 12,000 |
| Pocket money / daily allowance | 12,000 |
| Medical check + basic care | 4,000 |
| Exam & misc fees | 3,000 |
| **Total** | **~69,000** (≈ Rs 5,750/month) |

The committee edits these lines per child — a child walking to school has no
transport line. **The package is built from line items, not typed as a single
number**, so the sponsor can see exactly what their money buys and the committee
can defend every rupee.

### Designated vs pooled — the decision the brief hasn't made yet

Research is blunt about this: the major sponsorship organisations **pool** funds
rather than spending them literally on the one named child, and they vary a lot
in how honestly they say so ([Child sponsorship, Wikipedia](https://en.wikipedia.org/wiki/Child_sponsorship)).

- **Designated** (money follows the named child) — strong emotional bond, matches
  *"his kafalat"*. Fragile: a sponsor who stops paying in October puts that
  child's school year at risk, and creates per-child restricted-fund accounting.
- **Pooled** (one Kafalat fund, children drawn from it) — resilient and simple,
  but the donor bond is weak.
- **Recommended hybrid — which is what the brief is already describing with
  shares:** sponsors take **shares of a named child**, the money lands in the
  Kafalat pool, and the share is recorded as an attribution and a commitment. If
  a sponsor lapses, the pool keeps the child in school while the committee finds
  a replacement share.

Then **say this plainly on the sponsorship page.** The honesty is a competitive
advantage — it is exactly what the research says most organisations fudge.

### Shares — how the brief's "50% share" should work

- Each child has an **annual package cost** (from the line items above).
- Sponsorship is expressed in **percentage shares** with a **minimum share**
  (suggest 10%, i.e. ~Rs 7,000/year). Without a minimum you end up with a child
  supported by forty micro-sponsors and an administrative nightmare.
- A child with a partial sponsor appears in a **"Shares available"** list, showing
  what is already committed and what remains — precisely the flow described in
  the brief.
- **Duration:** 1 year · 2 years · until the child completes a stage (matric) ·
  open-ended. Renewal reminders go out **February–March**, because the Punjab
  school year starts in April — a renewal reminder in December is useless.
- A sponsor can convert a share to a standing recurring donation (reuse
  `recurring_schedules`).

### Getting a child onto the register

1. **Nomination** — any portal user (donor *or* water-account user) nominates a
   neighbourhood child. This is in the brief and it is a good idea: neighbours
   know things the committee doesn't.
2. **Screening** — is the family genuinely unable to pay? Is the child enrolled
   or enrollable?
3. **Home verification** — two members, same rule as zakat.
4. **Guardian consent form** — signed, covering participation, what will be
   shared, and with whom.

### Safeguarding — the section the brief is missing entirely

A village welfare site publishing photographs of poor children, with names, next
to the words "cannot afford school", causes real harm to those children in a
place where everyone knows everyone. Sector practice is strict, and should be
copied ([World Vision](https://www.worldvision.org/sponsor-a-child/support-center/child-security-protection-privacy-policy),
[Children International](https://www.children.org/stories/2026/04_april/sharing-responsibly-protecting-children-on-social-media)):

- **No public listing of children. Ever.** Sponsor-only, behind login.
- **First name only.** No family name, no house number, no school name in
  combination with a photo.
- **Photo only with written guardian consent**, and a no-photo option that does
  not disadvantage the child — use initials/avatar. A guardian can withdraw
  consent at any time via a "do not display" flag that takes effect immediately.
- **No direct sponsor↔family contact.** Everything through the committee.
- Admin and accounting screens show **`KFL-0007`**, not the child's name — same
  coded-identity pattern as the zakat register.
- Public page shows **aggregates and outcomes only**: *"18 children sponsored ·
  14 fully · 4 partially · 3 matriculated this year."*

### What sponsors get back

This is what makes sponsors renew. Established programmes send a welcome pack
with a child profile roughly three months in, then an annual field-officer
progress report.

- **Welcome card** on activation: first name, age, class, package breakdown.
- **Termly progress card**: attendance %, exam result, a one-line teacher note,
  photo if consented.
- **Annual statement**: what was paid, against what.
- Milestone notifications: promoted a class, passed matric, dropped out (with
  reason and what the committee did about it).

### Exceptions to plan for now, not later

- Sponsor lapses mid-year → pool covers, committee re-lists the share.
- Child drops out, moves away, or dies → sponsor's remaining balance is
  **reassignable with the sponsor's consent**, with a stated default policy if
  they don't respond.
- Child's needs change (illness, a year repeated) → package edited, sponsor told.
- Sponsor wants to stay anonymous to the child → already supported by the
  existing `is_anonymous` flag.

---

## The shared spine

### Fund segregation

Five restricted fund types, each with its own ledger account, reusing the
per-project account pattern already built (`ensure_project_account`):

`general` · `zakat` · `sadqa` · `kafalat` · `esal_e_sawab`

Enforced by trigger, in the same style as the `project_transfer` validation
already written:

- A **zakat** account can only be debited by a zakat disbursement to a register
  code. Not by an expense, not by a purchase, not by an esal-e-sawab item.
- A donation marked **zakat** cannot be assigned to an esal-e-sawab object.
- Kafalat funded by zakat is flagged so payment routes through the guardian.

### One register, many uses

The Verified Needs Register serves zakat, kafalat, fitrana, qurbani meat,
ration distribution, emergency medical help, and the winter blanket run. Every
one of those needs the same question answered: *who genuinely needs help, and
who checked?*

### What this reuses rather than rebuilds

| Need | Existing machinery |
|---|---|
| Two-verifier sign-off | `approval_requests` / `approval_confirmations` |
| Restricted fund accounts | project-account pattern, `ensure_project_account` |
| Monthly sponsorship | `recurring_schedules` |
| Reminders to sponsors and donors | notification infrastructure |
| Campaigns for a specific child or object | appeals + ticker |
| Registration and nomination forms | portal |
| Corrections to a closed month | `reverse_voucher` |
| Anonymity | `donors.is_anonymous`, plus the new coded-identity pattern |

### New roles

- `zakat_verifier` — sees register identities. 2–3 people, named.
- `kafalat_coordinator` — manages children, packages, progress cards.
- Neither is implied by `admin` or `super_admin`. Being the system administrator
  should not mean being able to read the poverty register.

---

## Things the brief didn't mention that will matter

1. Zakat cannot fund esal-e-sawab or committee overheads — enforce in software.
2. Committee conflict-of-interest declarations on every zakat and kafalat vote.
3. Eligibility **expires**; annual re-verification.
4. Guardian consent and child safeguarding for kafalat.
5. Accepting a donated object means accepting its running cost — show the
   accumulated liability before approving another.
6. Plaque character limit, and plaques carrying over on replacement.
7. What happens when a sponsor lapses, or a child leaves.
8. Don't sit on zakat — warn when a balance is idle.
9. Nisab calculator, to drive collection.
10. **Ushr** — the rural zakat nobody collects, and Chakwal is farming country.
11. Fitrana, Qurbani meat, and ration distribution all reuse the same register.
12. Double-dipping check against BISP / Rahmat Card.

---

## Suggested build order

1. **Verified Needs Register** + `zakat_verifier` role + coded identity + the
   two-verifier survey flow. Nothing else works without it.
2. **Zakat** — restricted fund, rounds, formula, disbursement, aggregate report.
   Highest value, and Ramadan is the natural deadline.
3. **Esal-e-Sawab** — self-contained, no register dependency, very visible
   results. Good morale between the two heavier builds.
4. **Kafalat** — the largest build (children, packages, shares, progress cards,
   safeguarding). Do it once the register is proven in real use.

---

## Sources

- [Islamic Relief — Orphan Sponsorship Programme](https://islamic-relief.org/orphan-sponsorship-programme/)
- [Muslim Hands USA — Sponsor an Orphan](https://muslimhandsusa.org/appeals/sponsor-an-orphan)
- [Muslim Hands Canada — Orphans](https://muslimhands.ca/our-work/orphans)
- [Human Appeal — Orphan Sponsorship in Islam: What It Means and How It Works](https://humanappealusa.org/news/2026/6/orphan-sponsorship-in-islam-what-it-means-and-how-it-works)
- [Child sponsorship — Wikipedia (fund pooling and transparency)](https://en.wikipedia.org/wiki/Child_sponsorship)
- [World Vision — Child Security, Protection and Privacy Policy](https://www.worldvision.org/sponsor-a-child/support-center/child-security-protection-privacy-policy)
- [Children International — Sharing Responsibly: Protecting Children on Social Media](https://www.children.org/stories/2026/04_april/sharing-responsibly-protecting-children-on-social-media)
- [HelpYouSponsor — 10 Standards for Child Sponsorship Programs](https://helpyousponsor.com/blog/standards-child-sponsorship-programs)
- [Penny Appeal USA — Zakat Policy (fund segregation, tamleek)](https://www.pennyappealusa.org/zakat-policy/)
- [MUIS — The 8 Asnaf of Zakat](https://www.zakat.sg/8-asnaf-of-zakat/)
- [Musaffa Academy — Who Can Receive Zakat: the 8 Categories with Modern Examples](https://academy.musaffa.com/who-can-receive-zakat-the-8-categories-asnaf-with-modern-examples/)
- [Zakat & Ushr Department, Punjab — Guzara Allowance and istehqaq criteria](https://zakat.punjab.gov.pk/guzara-allowance)
- [Zakat & Ushr Department, Punjab — CM Punjab Rahmat Card](https://zakat.punjab.gov.pk/rahmat-card)
- [Alkhidmat Foundation — Zakat, orphans and widows](https://alkhidmat.org/zakat)
- [Children of Adam — Water Hand Pump Sadaqah Jariyah (plaque conventions)](https://childrenofadam.org/news/water-hand-pump-sadaqah-jariyah/)
- [International Waqf Fund — Sadaqah Jariyah](https://waqf.org/sadaqah-jariyah/)
- [Islamic Help — Donating a Water Well in Someone's Name](https://islamichelp.org.uk/newsroom/news-impact-page/donating-a-water-well-in-someones-name/)
- [Jitasa — Do's and Don'ts of Managing Donor-Restricted Funds](https://www.jitasagroup.com/jitasa_nonprofit_blog/managing-donor-restricted-funds/)

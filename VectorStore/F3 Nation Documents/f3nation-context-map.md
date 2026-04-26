# F3 Nation App Context Map (RAG Index)

This file maps the docs in this folder so the Q&A bot can route questions to the best source.
Use it as the “table of contents” for the knowledge base.

---

## Start here (most users)

- `f3nation-help-menu-calendar-preblast.md`
  - Quick help entry point: calendar + Q signup + preblast basics

- `f3nation-faq.md`
  - Fast answers to common questions and edge cases

- `f3nation-glossary.md`
  - Definitions for AO, Q, HC, Preblast, Backblast, Downrange, etc.

---

## Screen-by-screen UI guides (best for “where do I click?”)

### Settings hub
- `f3nation-screen-settings-home.md`
  - Main settings menu: where to find Help Menu, User Settings, Emergency Info Access, etc.

### Calendar
- `f3nation-screen-calendar-home.md`
  - Upcoming schedule filters + event actions via (...) / More

### Preblast chooser
- `f3nation-screen-select-preblast.md`
  - Select From Upcoming Qs
  - Open Calendar
  - New Unscheduled Event (not on the calendar)

### User profile
- `f3nation-screen-user-settings.md`
  - Username, Home Region, Start Date Override
  - Downrange access + emergency contact fields

- `f3nation-howto-upload-profile-picture.md`
  - Upload profile picture and save with Submit

### Emergency info (high sensitivity)
- `f3nation-screen-emergency-info-access.md`
  - Local Slack user vs Downrange search
  - Warning: user is emailed when accessed

---

## SOP workflows (best for “how do I do the whole process?”)

- `f3nation-sop-index.md`
  - Overview/links to the main SOPs

- `f3nation-sop-installing-and-connecting.md`
  - Installing + connecting a workspace/region (admin/setup)

- `f3nation-sop-signing-up-to-q.md`
  - Q signup end-to-end (calendar → open Q slot → take Q → confirm → preblast)

- `f3nation-sop-submitting-a-backblast.md`
  - Backblast end-to-end (select past Q → tag PAX/downrange → moleskin → submit)

---

## Admin / leadership / advanced

- `f3nation-admin-starfish-swarming.md`
  - Starfish / swarming instructions for regions/workspaces/AOs

- `f3nation-analytics-querying-the-database.md`
  - PAX Vault vs BigQuery + access and cost cautions

---

## Routing hints (what file to use)

- “How do I find the calendar / filter events?” → `f3nation-screen-calendar-home.md` + `f3nation-help-menu-calendar-preblast.md`
- “How do I sign up to Q?” → `f3nation-sop-signing-up-to-q.md` (then calendar screen guide if needed)
- “How do I post a preblast?” → `f3nation-screen-select-preblast.md` + `f3nation-help-menu-calendar-preblast.md`
- “How do I submit a backblast?” → `f3nation-sop-submitting-a-backblast.md`
- “How do I change my username/home region?” → `f3nation-screen-user-settings.md` + `f3nation-faq.md`
- “Emergency info lookup?” → `f3nation-screen-emergency-info-access.md` (include warning)
- “BigQuery / dashboards?” → `f3nation-analytics-querying-the-database.md`
- “Starfish / moving AOs / region setup?” → `f3nation-admin-starfish-swarming.md`

---

## Authoring rules (keep retrieval strong)

- One topic per file (screen or workflow)
- Use exact UI labels as headings
- Put the key action steps near the top
- Keep paragraphs short; prefer bullets for steps
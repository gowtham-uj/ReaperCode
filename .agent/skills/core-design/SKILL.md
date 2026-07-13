---
name: core-design
description: Use when designing, building, modifying, or reviewing any UI, frontend, component, page, dashboard, form, layout, or design system. Covers IA, layout, hierarchy, typography, color, spacing, grids, components, states, forms, tables, navigation, mobile, accessibility (WCAG 2.2 AA), motion, UX writing, responsive design, anti-AI-slop review, and frontend engineering quality.
alwaysApply: true
globs:
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/*.vue"
  - "**/*.svelte"
  - "**/*.css"
  - "**/*.scss"
  - "**/*.html"
---

# Master Core Design Skill

## 1. Purpose

This skill is the permanent design brain for AI coding agents working on frontend, UI, UX, product design, interaction design, accessibility review, and frontend design architecture.

It is not a visual style guide. It does not prescribe Apple, Material, Linear, Stripe, Notion, enterprise, mobile, or dashboard aesthetics. Style-specific skills may layer on top of this one; this skill provides the reasoning, structure, usability, accessibility, and implementation standards underneath every style.

### Operating mandate

When asked to design, build, modify, or review any UI, the agent must:

1. Preserve and extend the existing product system before inventing a new one.
2. Optimize for user task success, clarity, accessibility, responsiveness, and maintainability before aesthetics.
3. Use professional design-system reasoning rather than decorative taste.
4. Produce implementation-ready decisions: semantic structure, layout behavior, component states, content rules, accessibility requirements, and responsive behavior.
5. Reject generic AI UI patterns that add visual noise without improving comprehension or action.

### Source synthesis

This skill synthesizes durable consensus from professional design systems, UX research, accessibility standards, component architecture practices, UX writing, frontend engineering, and professional UI review methods. It extracts principles rather than copying wording. Where sources disagree, this skill chooses the approach that is most accessible, predictable, maintainable, and compatible with modern product design.

### Existing AI design skill synthesis

Existing professional AI design skills are treated as priority source material because they encode how coding agents fail in practice. Durable consensus extracted from Open Design, TypeUI, Claude Design prompt libraries, Claude Design Skill adaptations, UI/UX Pro Max, mobile UI skills, and DESIGN.md collections:

- **Act like a designer using code, not a code generator making visuals.** First decide purpose, hierarchy, system, and critique criteria; code is the rendering medium.
- **Root output in real context.** Prefer an existing `DESIGN.md`, product tokens, screenshots, UI kit, brand guide, or component library over invention. If context exists, extract it before styling.
- **Separate brand parameters from design intelligence.** Brand kits provide names, logos, fonts, and colors; the design skill decides hierarchy, composition, states, accessibility, and interaction behavior.
- **Commit to an aesthetic direction before hi-fi work.** Greenfield design requires explicit choices for type, color tone, density, radius, elevation, imagery, iconography, and motion. “Modern and clean” is not a direction.
- **Generate meaningful variations when exploring.** Options should differ by layout, hierarchy, density, type, interaction model, or content strategy; not by button color alone.
- **Make anti-slop review a first-class gate.** Scan for unearned gradients, emoji decoration, generic cards, fake SVG product art, placeholder data, overused default fonts, off-scale spacing, and house-style drift.
- **Treat polish as a structured review pass.** Final quality requires accessibility, hierarchy/rhythm, interaction-state, and generic-AI-pattern checks before delivery.
- **Use portable, file-based knowledge.** Skills, `DESIGN.md`, tokens, and references should be Markdown-readable, vendor-agnostic, and useful to any coding agent without hidden tools.

These lessons are infused throughout the workflow below. They do not override accessibility, usability, or the project’s existing system.

---

## 2. Design Philosophy

### Core principle

A good interface helps a specific user complete a specific task with the least necessary cognitive, physical, and emotional friction.

### Priority order

When decisions conflict, use this order:

1. **User safety and accessibility** — the interface must be usable by keyboard, assistive technology, low vision, color blindness, reduced motion, zoom, and touch users.
2. **Task clarity** — users must understand where they are, what changed, what they can do, and what will happen next.
3. **Existing product conventions** — match the project’s current components, tokens, interaction patterns, and information architecture.
4. **Platform and web conventions** — use familiar patterns unless the product has a proven reason to diverge.
5. **Maintainability** — prefer simple, composable, testable implementation over clever visuals.
6. **Aesthetic expression** — visual polish supports meaning; it never substitutes for structure.

### Design truths

- Users spend most of their time outside this product; familiar patterns reduce learning cost.
- Choice overload slows decisions; reduce visible complexity until the user needs it.
- Recognition is easier than recall; show options, examples, history, labels, and context.
- Proximity, similarity, alignment, enclosure, and continuity determine perceived structure more than decoration does.
- Fast feedback builds confidence; silence after an action creates doubt.
- The strongest memories of a flow come from its hardest moment and its ending; design errors, waits, and completion states carefully.
- Visual hierarchy is not beauty. It is the ordering of attention.
- Accessibility is not a pass at the end. It is part of the component contract.

### Non-goals

Do not:

- Apply a platform aesthetic unless explicitly requested.
- Add gradients, glass, glow, shadows, illustrations, icons, or animation because the page feels plain.
- Replace product clarity with “premium” styling.
- Create new component patterns when the codebase already has equivalents.
- Hide poor information architecture behind cards.
- Treat desktop width as the default truth and mobile as an afterthought.

---

## 3. Design Workflow

Use this workflow for every frontend task, scaled to task size.

### A. Understand the product context

Before designing or editing:

- Inspect existing routes, screens, components, tokens, spacing, typography, color usage, and state patterns.
- Identify the current design system or de facto system.
- Determine user role, task, entry point, success condition, risk level, and device context.
- Note constraints: framework, component library, accessibility requirements, data availability, localization, performance, and brand/style layers.
- Search for local design instructions (`DESIGN.md`, `AGENTS.md`, `SKILL.md`, style guides, token files, Storybook docs, Figma exports, screenshots) before inventing visual decisions.
- If a brand kit exists, treat it as input data; do not let brand colors alone decide layout, hierarchy, accessibility, or interaction.

### B. Define the experience contract

For the target screen or component, answer:

- What is the primary user goal?
- What is the primary action?
- What secondary actions exist, and when should they be visible?
- What information is required before action?
- What can go wrong?
- What states must exist: loading, empty, partial, error, success, disabled, selected, expanded, offline, permission-limited?
- What must be keyboard and screen-reader operable?
- How does the layout adapt from narrow to wide containers?
- Is this a greenfield design, an extension of an existing system, a redesign, a review, or a variation exercise?
- If variations are requested or useful, which axes should vary: layout, hierarchy, density, type, color tone, motion, copy, or flow?

### C. Design from structure outward

Order decisions as:

1. Information architecture.
2. Semantic HTML and landmarks.
3. Layout and responsive behavior.
4. Component composition.
5. State model and interaction rules.
6. Accessibility names, focus, keyboard behavior, and announcements.
7. Typography, spacing, color, iconography, shadows, and motion.
8. Performance and implementation details.

Before hi-fi styling, if no existing system is available, define the aesthetic system explicitly:

1. Three desired adjectives or product qualities.
2. Audience and industry conventions.
3. Typography roles and type scale.
4. Color tone and semantic token roles.
5. Density, spacing scale, radius, shadow/elevation style.
6. Imagery/iconography approach.
7. Motion mode.
8. Anti-patterns that are off-limits for this product.

### D. Implement using existing system first

- Use existing components and tokens wherever possible.
- If a needed component does not exist, create the smallest composable primitive that matches project conventions.
- Avoid one-off values unless the project already supports them or a layout constraint requires them.
- Keep behavior and accessibility close to the component that owns them.

### E. Verify like a reviewer

Before delivery:

- Inspect the result at relevant breakpoints and container sizes.
- Navigate with keyboard only.
- Check visible focus, tab order, names, labels, errors, and announcements.
- Confirm loading, empty, error, success, disabled, and destructive states.
- Check contrast, zoom/reflow, reduced motion, and dark mode if supported.
- Remove decorative noise that does not serve hierarchy or comprehension.

---

## 4. Thinking Process

Use this compact design loop internally. Do not expose long reasoning unless asked; expose decisions and rationale.

### The design loop

1. **Task** — What is the user trying to accomplish?
2. **Context** — What do they already know? What state is the system in?
3. **Priority** — What must be noticed first, second, third?
4. **Structure** — What grouping and navigation make the task obvious?
5. **Action** — What is the primary next step? What is reversible? What is risky?
6. **Feedback** — How does the UI respond immediately, during wait, on success, and on failure?
7. **Access** — Can users operate and understand it with keyboard, screen reader, zoom, reduced motion, touch, and non-color cues?
8. **Adaptation** — Does the same component work in small, medium, large, dense, and empty contexts?
9. **Fit** — Does it match the product’s existing system?
10. **Cut** — What can be removed without hurting task success?

### Deterministic defaults

If no style direction is provided:

- Use the project’s existing visual language.
- Use neutral, restrained styling.
- Prefer clarity, alignment, spacing, and type hierarchy over decoration.
- Use one primary accent role, not a rainbow palette.
- Use subtle elevation only when it communicates layering or interactivity.
- Use motion only for feedback, continuity, or spatial orientation.

### Greenfield aesthetic protocol

When no brand, product system, or reference UI exists:

- Do not drift into a default house style.
- Propose or choose a concrete direction before building: typeface class, palette tone, density, radius, elevation, component style, imagery, and motion.
- Make at least one direction deliberately distinct when offering options; three nearly identical minimalist variants are not exploration.
- Document the chosen direction in the implementation as tokens or a short design-system note.
- Add any new value to the system first, then use it. Do not scatter one-off colors, sizes, radii, or shadows through components.

### Variation protocol

When exploring alternatives:

- Default to 3 options unless the task requires more.
- Order them from safe/system-faithful to refined to novel.
- Vary substantive axes: structure, hierarchy, density, content strategy, interaction model, type, or color tone.
- Present variations together so tradeoffs are visible.
- Recommend one option and explain why; do not pretend all options are equal.

### Review-gate protocol

Before delivery, run four mental passes:

1. **Accessibility** — semantics, keyboard, focus, labels, contrast, reduced motion.
2. **Hierarchy/rhythm** — first read, spacing scale, type scale, alignment, repetition, strategic variation.
3. **Interaction states** — default, hover, active, disabled, focus-visible, loading, selected/current, feedback.
4. **AI-slop** — generic gradients, emoji decoration, fake imagery, default cards, invented data, off-scale values, unearned style trends.

---

## 5. Information Architecture

Information architecture decides what exists, where it lives, and how users form a mental model of the product.

### Required screen answers

Every screen must make these answers obvious:

- Where am I?
- What is this for?
- What matters most right now?
- What can I do next?
- What changed after my action?
- How do I recover if something goes wrong?

### Organizing principles

- Group by user task, not database shape.
- Put frequently used and high-value actions closer to the surface.
- Defer advanced, rare, or dangerous options behind progressive disclosure.
- Keep navigation labels concrete and recognizable.
- Use consistent names for the same concept everywhere.
- Prefer shallow, predictable structures for common workflows.
- Use breadcrumbs, section headings, or persistent context when location may become ambiguous.
- Make destructive, irreversible, or expensive actions visually and semantically distinct.

### Progressive disclosure

Use progressive disclosure when advanced details would slow new or occasional users.

Good uses:

- Advanced filters.
- Optional configuration.
- Expert settings.
- Long explanations.
- Rare destructive options.
- Secondary metadata.

Avoid progressive disclosure when hidden information is required for safe action, comparison, pricing, permission, legal consent, or error recovery.

### Recognition over recall

Support recognition by showing:

- Labels, hints, examples, previews, recent choices, defaults, and current settings.
- Visible selected states.
- Clear affordances for expandable areas.
- Search suggestions and filters where option sets are large.
- Inline validation and constraints near the field they affect.

---

## 6. Layout

Layout is the physical argument of the interface: it tells users what belongs together, what matters, and how to move.

### Universal layout rules

- Start with content priority, then choose layout.
- Use alignment and spacing before borders and boxes.
- Place the primary action where users finish reading or editing.
- Keep related controls near the content they affect.
- Avoid equal visual weight for unequal importance.
- Do not center large bodies of text, dense controls, or data-heavy content.
- Keep scan paths predictable: usually top-to-bottom, start-to-end in the reading direction.
- Maintain stable layout during loading and state changes; avoid large jumps.
- Use whitespace as structure, not filler.

### Page archetypes

#### Editorial/content pages

- Optimize reading: narrow measure, strong headings, generous line height, clear section rhythm.
- Use sidebars only for supportive context, not primary reading.
- Keep long-form content around a readable max width.

#### SaaS/product pages

- Prioritize current task, status, and next action.
- Put global navigation, page heading, primary action, filters, content, and status in predictable regions.
- Avoid turning every metric or option into a card.

#### Documentation pages

- Provide persistent orientation: sidebar/table of contents, page title, section anchors, examples.
- Code blocks need copy affordances, language labels, and readable wrapping/scroll behavior.
- Separate conceptual explanation from procedural steps.

#### Forms/settings pages

- Group related fields under meaningful headings.
- Keep labels visible.
- Place save/cancel actions consistently.
- Show unsaved changes, validation, and destructive settings clearly.

#### Data dashboards

- Lead with decision-critical metrics and anomalies.
- Show trends and comparisons, not just isolated numbers.
- Make filters and time ranges visible.
- Clarify freshness, source, and empty/partial data states.

#### Bento layouts

- Use only when content modules have distinct priority and can be scanned independently.
- Vary size by importance, not decoration.
- Avoid bento grids for linear tasks, forms, or dense data.

---

## 7. Visual Hierarchy

Hierarchy controls attention. Every surface needs an intentional attention path.

### Build hierarchy with

1. Position and reading order.
2. Size and type weight.
3. Spacing and grouping.
4. Contrast and color role.
5. Shape, container, and elevation.
6. Motion, used sparingly.

### Rules

- One primary focal point per view or region.
- One primary action per task context.
- Headings must describe content, not decorate it.
- Secondary actions must look secondary.
- Metadata must not compete with titles or actions.
- Alerts must be visually and semantically prominent enough to notice, but not so loud that they drown the task.
- Empty, loading, and error states need hierarchy too: title, explanation, next action.

### Hierarchy review

Ask:

- What do users see first in three seconds?
- Is that the right thing?
- Can users identify the primary action without reading every word?
- Do grouped items look related?
- Are unrelated items separated enough?
- Is anything visually loud without earning it?

---

## 8. Typography

Typography is interface infrastructure. It determines readability, scan speed, and perceived quality.

### Readability defaults

- Body text should generally start at 16px or equivalent.
- Use line height around 1.45–1.7 for body copy; tighter for headings.
- Keep long-form line length roughly 45–75 characters.
- Avoid light font weights for body text, especially on dark or low-contrast backgrounds.
- Use sentence case for most UI labels unless the product convention differs.
- Avoid all caps except short labels or tokens; increase letter spacing if all caps are used.
- Use tabular numbers for aligned numeric data when available.

### Type hierarchy

- Define a small scale: display/page title, section title, subsection title, body, small/supporting, code/mono if needed.
- Use size, weight, and spacing together; do not rely on color alone.
- Avoid more than two font families unless the product already has a system.
- Pair fonts by role, not novelty: one text face and one optional display/mono face is usually enough.
- Preserve rhythm: headings need more space above than below so they attach to their section.

### Text in components

- Buttons need short verb phrases.
- Labels need stable, explicit nouns.
- Helper text explains constraints before submission.
- Error text explains what happened and how to fix it.
- Placeholder text is not a label.
- Truncation must preserve meaning and expose full content where needed.

---

## 9. Color

Color communicates role, state, and emphasis. It is not decoration by default.

### Color system rules

- Use semantic tokens: background, surface, text, muted text, border, accent, success, warning, danger, info, focus.
- Do not hard-code arbitrary colors when tokens exist.
- Use one primary accent role unless the product system defines more.
- Reserve saturated color for action, state, or meaningful emphasis.
- Ensure interactive and status colors work in light mode, dark mode, high contrast, and color-blind contexts.
- Never communicate status by color alone; add text, icon shape, pattern, or position.

### Contrast

Default target: WCAG 2.2 AA or better.

- Normal text: at least 4.5:1 contrast.
- Large text: at least 3:1 contrast.
- UI components, focus indicators, and meaningful graphics: at least 3:1 against adjacent colors.
- Disabled controls may be lower contrast only when they are truly unavailable and not needed for comprehension.

### Dark mode

- Dark mode is not color inversion.
- Use semantic tokens with separate light/dark values.
- Reduce large saturated surfaces in dark mode.
- Avoid pure black/pure white unless the product intentionally uses high contrast.
- Recheck shadows, borders, focus rings, charts, and status colors in dark mode.

---

## 10. Spacing

Spacing is a system for meaning. It defines grouping, rhythm, density, and calm.

### Rules

- Use the project’s spacing scale. If none exists, establish a simple 4px or 8px-based scale.
- Spacing inside a group must be smaller than spacing between groups.
- Use consistent vertical rhythm for repeated content.
- Align edges across headings, text, controls, and containers.
- Do not use random one-off margins to “nudge” components unless correcting optical alignment.
- Dense UIs still need grouping; reduce spacing proportionally rather than removing structure.
- Touch interfaces need larger interactive spacing than pointer-dense desktop tools.

### Practical spacing relationships

- Label to input: tight.
- Field to helper/error text: tight.
- Field group to field group: medium.
- Section to section: large.
- Page heading to content: medium-large.
- Card padding should be consistent across cards of the same level.
- Modal footer actions should align with the modal content grid.

---

## 11. Grid Systems

Grids create alignment and responsive structure. They should support content, not imprison it.

### Grid rules

- Use a grid for page-level layout; use flex or intrinsic layout for simple component alignment.
- Use max-width containers for readable content.
- Let components adapt to available container width, not only viewport width.
- Prefer mobile-first layout decisions.
- Use container queries for reusable components placed in unpredictable regions.
- Avoid fixed pixel widths that break localization, zoom, or small screens.
- Preserve source order so keyboard and screen-reader flow matches visual flow.

### Responsive grid behavior

- Small screens: single column by default; prioritize task order.
- Medium screens: introduce secondary columns only when they reduce scrolling or support comparison.
- Large screens: increase density carefully; do not stretch text beyond readable measure.
- Ultra-wide screens: use max widths, side panels, or additional context instead of stretching everything.

---

## 12. Components

Components are contracts: structure, behavior, accessibility, states, styling hooks, and composition rules.

### Component philosophy

- Prefer accessible native HTML first.
- Use ARIA only when native semantics cannot express the pattern.
- Use headless/primitive components for complex interactions when available.
- Compose components from small parts with clear responsibilities.
- Keep visual variants finite and named by intent.
- Expose state through props, data attributes, ARIA attributes, or controlled APIs consistently.
- Do not create a component that hides required semantics from consumers.

### Library-derived guidance

Use lessons from shadcn/ui, Radix, Base UI, Chakra, and Mantine without copying their visual style:

- Prefer accessible primitives for dialogs, popovers, menus, tabs, comboboxes, tooltips, sliders, and other complex widgets.
- Let Radix/Base-style primitives own ARIA, focus trapping, roving tabindex, escape behavior, and keyboard conventions.
- Let shadcn-style composition make component source visible and editable inside the product rather than hiding critical UX behind opaque packages.
- Let Chakra/Mantine-style APIs inform consistent variant, size, color-scheme, disabled, loading, and error props.
- Do not mix libraries casually; choose one interaction model and one styling/token model per product surface.
- If a library component is inaccessible, over-abstracted, or visually inconsistent with the product, wrap or replace it at the primitive boundary rather than hacking one-off call sites.

### Component architecture rules

- Separate primitive behavior from product-specific presentation where useful.
- Support controlled and uncontrolled usage only when both are needed and implemented correctly.
- Use a single source of truth for open, selected, checked, expanded, loading, and error states.
- Keep keyboard interactions and focus management in the component, not scattered across callers.
- Make disabled behavior explicit: disabled because impossible, loading because in progress, readonly because visible but not editable.
- Prefer composition over prop explosions.
- Keep variant names semantic: `primary`, `secondary`, `danger`, `ghost`, `outline`, not `blue`, `bigShadow`, `fancy`.
- Avoid wrappers that turn buttons into divs or links into buttons.

### Component minimum contract

Every reusable component should define:

- Purpose and usage boundaries.
- Required and optional props.
- Accessibility name and description behavior.
- Keyboard behavior.
- Focus behavior.
- State list.
- Responsive behavior.
- Theming/token hooks.
- Error/empty/loading handling where relevant.

### Component extraction rules

When matching or extending an existing product:

- Inventory reusable components before creating new ones.
- Extract observed component anatomy: slots, variants, states, density, icon rules, content rules, and responsive behavior.
- Record exact token values from source files when available; do not approximate from memory.
- Treat near-duplicate components as a consolidation signal, not a reason to add a third pattern.
- Keep the component contract portable: behavior, accessibility, and state rules must be understandable from code and Markdown.

---

## 13. States

States are not edge cases. They are the product.

### Required state inventory

For every screen/component, consider:

- Default.
- Hover.
- Focus-visible.
- Active/pressed.
- Disabled.
- Readonly.
- Loading.
- Skeleton/loading placeholder.
- Empty.
- Partial data.
- Error.
- Success.
- Warning.
- Selected/current.
- Expanded/collapsed.
- Invalid/valid.
- Dirty/unsaved.
- Offline/reconnecting.
- Permission denied.
- Not found.
- Conflict/stale data.
- Destructive confirmation.

### Feedback rules

- A user action must produce immediate feedback.
- Long operations need progress, optimistic state, skeletons, or a clear wait message.
- Loading indicators must not cause layout shift if size can be reserved.
- Empty states must explain why content is absent and what the user can do next.
- Error states must preserve user input whenever possible.
- Success states should confirm completion and guide the next step.
- Destructive actions need clear object names and consequences.

---

## 14. Forms

Forms are conversations with constraints. Design them to prevent errors, not merely report them.

### Form structure

- Use explicit visible labels for every field.
- Group related fields with headings or fieldsets/legends when appropriate.
- Keep required/optional conventions consistent.
- Place helper text before errors occur when constraints are non-obvious.
- Put validation near the affected field and summarize at form level for long forms.
- Use input types and autocomplete attributes correctly.
- Preserve entered data on error.
- Use sensible defaults when safe.
- Split long forms into sections when it improves comprehension, but do not hide required context.

### Validation

- Validate as early as helpful, not as early as annoying.
- Do not show errors before the user has had a chance to complete a field.
- Use specific error messages: what is wrong, where, and how to fix it.
- Mark invalid fields programmatically with `aria-invalid` when appropriate.
- Connect errors and helper text with accessible descriptions.

### Actions

- Primary form action should be clear and stable.
- Secondary action should not compete with submit.
- Destructive or discard actions must be visually distinct and often separated.
- Disable submit only when the reason is obvious or explained; otherwise allow submit and show validation.
- Show pending state on submit and prevent duplicate submissions.

---

## 15. Tables

Tables are for comparison and precise data scanning. Do not replace them with cards when rows and columns are the mental model.

Data tables require special discipline because data tables combine information architecture, scanning, comparison, keyboard navigation, responsiveness, and performance.

### Table rules

- Use real table semantics for tabular data.
- Provide clear column headers and row context.
- Align numbers by decimal or right edge; align text by start edge.
- Use tabular numerals for financial, metric, and count data.
- Keep row height dense enough for scanning but large enough for selection and focus.
- Make sorting, filtering, pagination, and selection states explicit.
- Show units in headers or values consistently.
- Preserve context with sticky headers only when implementation remains accessible and performant.
- Avoid horizontal overflow surprises; if horizontal scroll is necessary, make it obvious.

### Responsive table options

Choose based on task:

- **Priority columns** for small screens when only key fields matter.
- **Horizontal scroll** when comparison across columns is essential.
- **Stacked row cards** when each row is read independently and comparison is secondary.
- **Disclosure detail rows** when secondary fields are needed occasionally.

### Data states

- Empty table: explain filters/data absence and provide next action.
- Loading table: preserve header and expected structure.
- Error table: keep filters and user context visible.
- Partial data: disclose missing values and freshness.

---

## 16. Navigation

Navigation is orientation plus movement. It must be predictable, persistent where needed, and proportional to product complexity.

### Navigation rules

- Use navigation patterns users already understand unless product context demands otherwise.
- Keep labels concrete, stable, and mutually exclusive.
- Show current location clearly.
- Distinguish global navigation, local navigation, tabs, filters, and actions.
- Do not use tabs for navigation that changes the whole page unless the project pattern supports it.
- Do not use breadcrumbs as a substitute for clear hierarchy.
- Search is navigation; design its empty, loading, error, and no-results states.
- Menus must be keyboard operable and dismissible.

### Pattern guidance

- **Top navigation**: good for small sets of global destinations.
- **Sidebar navigation**: good for complex apps with persistent sections.
- **Tabs**: good for sibling views of the same object/context.
- **Breadcrumbs**: good for deep hierarchy and object detail pages.
- **Command menus**: good for expert navigation, not the only path for core tasks.
- **Steppers**: good for ordered flows with clear progress; avoid for non-linear tasks.

---

## 17. Dashboards

Dashboards exist to support monitoring, diagnosis, and decisions. They are not metric museums.

### Dashboard rules

- Identify the decision the dashboard supports.
- Lead with the most important status, change, or exception.
- Prefer trends, comparisons, thresholds, and anomalies over standalone numbers.
- Make time range, filters, segment, and data freshness visible.
- Use chart types users can read accurately.
- Do not use decorative charts where text or a table is clearer.
- Show empty, delayed, permission-limited, and partial-data states.
- Provide drill-down paths from summary to detail.
- Keep color meanings consistent across charts and status components.

### Metric hierarchy

For each metric, clarify:

- Name.
- Value.
- Unit.
- Time range.
- Comparison baseline.
- Directionality: is higher good or bad?
- Confidence/freshness if relevant.
- Action or explanation when abnormal.

---

## 18. Mobile

Mobile is not a squeezed desktop. It is a different physical context with limited space, touch input, interruptions, and variable connectivity.

### Mobile rules

- Design mobile-first for content order and core task flow.
- Use single-column layouts by default.
- Keep primary actions reachable and persistent only when they remain contextually safe.
- Touch targets should be at least 24px by WCAG minimum with enough spacing; prefer around 44px or larger for comfortable touch.
- Avoid hover-only interactions.
- Avoid dense toolbars, tiny icon-only actions, and horizontal gestures without visible affordance.
- Use native inputs where possible.
- Respect safe areas, browser chrome, keyboard overlays, and orientation changes.
- Keep modals minimal; prefer full-screen sheets for complex mobile tasks.
- Use bottom sheets carefully: they need focus management, escape paths, and scroll clarity.

### Mobile content

- Prioritize the first screen ruthlessly.
- Collapse secondary metadata.
- Keep forms short and field types correct.
- Use progressive disclosure for advanced controls.
- Support interruption recovery: preserve drafts and state.

---

## 19. Accessibility

Accessibility is a design and engineering requirement. Default target: WCAG 2.2 AA plus robust keyboard and screen-reader behavior.

### Semantic structure

- Use semantic HTML landmarks: `header`, `nav`, `main`, `aside`, `footer` where appropriate.
- Use one main landmark per page.
- Use headings in logical order; do not choose heading levels for visual size.
- Use lists for lists, tables for tabular data, buttons for actions, links for navigation.
- Avoid div/span controls unless native elements cannot express the interaction.
- If custom controls are necessary, implement full semantics, keyboard behavior, focus behavior, and names.

### Keyboard

- All interactive elements must be reachable and operable by keyboard.
- Tab order must follow DOM order and visual reading order.
- Never use positive `tabindex`.
- Use `tabindex="0"` only when adding an element to natural focus order is truly required.
- Use `tabindex="-1"` for programmatic focus targets.
- Composite widgets should use roving tabindex or `aria-activedescendant` according to the pattern.
- Focus must never be lost after closing dialogs, deleting items, filtering lists, or changing routes.
- Focus indicators must be visible and distinct from selected/current states.
- Keyboard traps are forbidden except temporary modal traps with clear escape behavior.

### Screen readers and names

- Every control needs an accessible name.
- Icon-only buttons need labels.
- Decorative icons/images should be hidden from assistive technology.
- Informative images need useful alt text.
- Form controls need associated labels.
- Errors and helper text should be programmatically associated with fields.
- Dynamic changes may need polite or assertive live regions depending on urgency.
- Do not spam announcements for every minor visual change.

### WCAG-oriented practical rules

- Content must not rely on color alone.
- Text must reflow and remain usable at 200% zoom and common narrow widths.
- Text spacing changes must not break content.
- Pointer gestures need alternatives.
- Drag-and-drop needs non-drag alternatives.
- Targets need sufficient size or spacing.
- Authentication and flows should avoid cognitive traps where possible.
- Flashing content is forbidden unless safely below thresholds.
- Motion must respect reduced-motion preferences.

### ARIA rule

No ARIA is better than bad ARIA. Use ARIA to supplement semantics, not replace native behavior.

---

## 20. Motion

Motion must explain, connect, confirm, or orient. Decorative motion is usually debt.

### Motion purposes

Use motion for:

- State feedback.
- Spatial continuity.
- Showing relationship between trigger and result.
- Drawing attention to important but non-obvious changes.
- Reducing perceived wait with honest progress or skeletons.

Avoid motion for:

- Constant background decoration.
- Large parallax/pan/zoom effects.
- Blocking task completion.
- Making simple UI feel “premium.”
- Hiding performance problems with excessive animation.

### Timing guidance

- Micro-interactions: roughly 100–200ms.
- Small transitions: roughly 150–250ms.
- Larger entrances/exits: roughly 200–400ms.
- Keep easing natural; avoid linear movement for physical transitions.
- Use shorter motion for frequent actions.

### Reduced motion

- Respect `prefers-reduced-motion`.
- Replace large movement with opacity, instant state changes, or subtle fades.
- Avoid scale, zoom, parallax, and large panning for reduced-motion users.
- Ensure information conveyed by motion is also conveyed by text, state, or layout.

---

## 21. UX Writing

UX writing reduces uncertainty. It should be clear, specific, brief, and action-oriented.

### Voice rules

- Use the user’s vocabulary.
- Prefer concrete nouns and verbs.
- Keep labels stable across the product.
- Avoid cleverness in critical flows.
- Avoid blaming the user.
- Explain consequences before risky actions.
- Localize-friendly writing: avoid idioms, concatenated strings, and text embedded in images.

### Buttons

- Use verbs: `Save changes`, `Invite member`, `Create project`.
- Avoid vague labels: `Submit`, `OK`, `Yes`, `No` when a specific action is clearer.
- Destructive buttons should name the destructive action: `Delete workspace`.
- Loading buttons should preserve width and indicate progress.

### Labels and helper text

- Labels are nouns or noun phrases.
- Helper text explains format, impact, or constraints.
- Placeholder text may show an example but must not replace the label.

### Empty states

Good empty states include:

1. What is absent.
2. Why it may be absent.
3. What to do next.

Do not use cheerful filler when absence is caused by an error, permission issue, or failed search.

### Loading states

- Say what is loading when the wait may be noticeable.
- Use skeletons only when structure is predictable.
- Use progress when duration or steps are knowable.

### Success states

- Confirm what happened.
- Show the new state or next useful action.
- Do not over-celebrate routine actions.

### Error states

- State the problem in plain language.
- Preserve user work.
- Provide recovery steps.
- Give support/debug details only where useful.

### Dialogs

- Title names the decision or object.
- Body states consequence and context.
- Primary action matches the title.
- Cancel/escape path is clear.
- Dangerous confirmations name the specific object.

---

## 22. Frontend Engineering

Good UI design must survive implementation. Code structure, semantics, performance, and tokens are design materials.

### Semantic implementation

- Choose HTML elements by meaning and behavior.
- Do not attach click handlers to non-interactive elements when a button or link is correct.
- Preserve DOM order to match reading and focus order.
- Use forms, labels, inputs, fieldsets, legends, and validation semantics correctly.
- Use tables for tabular data.
- Use route/page titles and metadata where appropriate.

### CSS architecture

- Prefer design tokens for color, spacing, radius, shadow, typography, and motion.
- Keep component styles local enough to avoid cascade surprises.
- Use utilities consistently if the project uses utility CSS.
- Avoid arbitrary values unless they encode a real product constraint or are promoted to tokens later.
- Use CSS variables for themeable values.
- Keep specificity low.
- Avoid `!important` except for rare integration boundaries.

### Tailwind guidance

- Use existing token classes and project conventions.
- Compose repeated utility sets into components when repetition harms maintainability.
- Use mobile-first utilities correctly: unprefixed is base, breakpoint prefixes apply upward.
- Use container queries for reusable components when viewport breakpoints are insufficient.
- Avoid long class strings full of one-off arbitrary values.

### Performance

- Optimize images: dimensions, responsive sources, lazy loading where possible, modern formats when supported.
- Avoid shipping heavy component libraries for small interactions.
- Keep animations transform/opacity-based when possible.
- Virtualize very large lists/tables when necessary.
- Prevent layout shift by reserving space for images, skeletons, and async content.
- Avoid blocking interactions during network requests unless data integrity requires it.
- Keep client-side JavaScript proportional to interaction complexity.

### Dark mode and theming

- Implement through semantic tokens, not duplicated component branches.
- Check focus rings, borders, shadows, charts, disabled states, and skeletons in every theme.
- Respect user/system preference unless product settings override intentionally.

---

## 23. Responsive Design

Responsive design is adaptive behavior across viewport, container, input mode, density, zoom, language, and data variation.

### Rules

- Start with the smallest viable layout.
- Add complexity as space allows.
- Prefer fluid layouts with sensible min/max constraints.
- Use container queries for components that may live in sidebars, cards, modals, dashboards, or full pages.
- Do not make breakpoints by device name; use content and layout needs.
- Test with real content: long names, missing values, translated strings, large numbers, many items, zero items.
- Ensure zoom and text resizing do not overlap or clip content.
- Use responsive images and avoid fixed-height text containers.

### Responsive decisions

For each region define:

- What stacks?
- What wraps?
- What hides, if anything?
- What becomes a disclosure?
- What remains sticky or persistent?
- What changes from inline to menu/sheet?
- What content must never be hidden?

### Input adaptation

- Touch: larger targets, less hover dependence, simpler density.
- Pointer: higher density can work when scanability remains.
- Keyboard: predictable focus order and shortcuts that do not conflict with platform/assistive technology.
- Screen reader: semantic order must remain coherent regardless of visual layout.

---

## 24. Design Review Checklist

Use this checklist before delivering UI work.

### Product fit

- [ ] Matches existing components, tokens, density, and interaction patterns.
- [ ] Solves the requested user task without unrelated redesign.
- [ ] Primary action and success condition are obvious.
- [ ] Secondary and destructive actions are correctly de-emphasized or separated.

### Information architecture

- [ ] Page answers where am I, what is this, what matters, what next.
- [ ] Groups reflect user tasks, not implementation shape.
- [ ] Navigation/current location is clear.
- [ ] Progressive disclosure hides only non-essential complexity.

### Layout and hierarchy

- [ ] Attention flows in the intended order.
- [ ] Related elements are visually grouped.
- [ ] Alignment is consistent.
- [ ] Spacing uses the project scale.
- [ ] No visual element is louder than its importance.

### Typography

- [ ] Body text is readable at expected sizes.
- [ ] Line length and line height are appropriate.
- [ ] Heading levels reflect document structure.
- [ ] Labels, helper text, and errors are clear.

### Color and theme

- [ ] Contrast meets WCAG AA targets.
- [ ] Status is not communicated by color alone.
- [ ] Dark mode/high contrast do not break meaning.
- [ ] Accent color is used intentionally.

### Accessibility

- [ ] Semantic HTML is correct.
- [ ] Keyboard-only operation works.
- [ ] Focus order is logical.
- [ ] Focus indicator is visible.
- [ ] Controls have accessible names.
- [ ] Errors and dynamic changes are announced where needed.
- [ ] Reduced motion is respected.
- [ ] Touch targets and spacing are adequate.

### States

- [ ] Loading, empty, error, success, disabled, invalid, selected, expanded, and permission states exist where relevant.
- [ ] User input is preserved on error.
- [ ] Destructive states name consequences.
- [ ] Layout remains stable across async changes.

### Responsiveness

- [ ] Works at narrow, medium, large, and container-constrained widths.
- [ ] Works with long content and localization.
- [ ] Works at zoom/text scaling.
- [ ] No hidden content is required for task success.

### Frontend quality

- [ ] Uses existing components and tokens.
- [ ] Avoids unnecessary new dependencies.
- [ ] Avoids arbitrary magic values.
- [ ] Does not introduce avoidable layout shift or heavy client JS.
- [ ] Implementation is maintainable and composable.

---

## 25. Self Critique

Before final output, the agent must critique its own UI work against these questions.

### Clarity

- Can a first-time user identify the purpose in three seconds?
- Is the primary action unmistakable?
- Is any text vague, generic, or ornamental?
- Did I remove everything not supporting task success?

### Consistency

- Did I reuse existing components/tokens/patterns?
- Did I introduce a second convention beside an existing one?
- Are spacing, radius, typography, shadows, and icons consistent?

### Accessibility

- Can the whole flow be completed with keyboard only?
- Are focus, labels, errors, and announcements correct?
- Does it work without color, with reduced motion, and at zoom?

### State completeness

- What happens before data arrives?
- What happens when there is no data?
- What happens when the request fails?
- What happens after success?
- What happens when the user lacks permission?
- What happens if content is long, translated, or missing?

### Aesthetic restraint

- Did I add decoration to compensate for weak structure?
- Are gradients, shadows, icons, cards, and motion earning their place?
- Would the UI still work in grayscale with motion removed?

If any answer fails, revise before delivery.

### Final polish gate

Before declaring UI work ready:

- Fix every accessibility blocker.
- Fix every missing interaction state on interactive elements.
- Snap spacing, type, radius, shadow, and color to the active system.
- Remove or replace every generic AI trope that lacks a product-specific reason.
- Preserve honest placeholders instead of fake logos, fake product art, fake people, fake charts, or invented metrics.
- State any remaining judgment calls for the user to approve.

---

## 26. Anti-patterns

These are common AI-generated UI mistakes. Actively prevent them.

### Visual noise

- **Random gradients**: Use gradients only when the product style calls for them or they communicate hierarchy/brand intentionally.
- **Meaningless glassmorphism**: Avoid translucent panels unless backdrop, contrast, and readability remain strong.
- **Oversized shadows**: Use elevation to communicate layering, not drama.
- **Glow effects**: Avoid unless part of an explicit brand/style layer.
- **Generic hero blobs**: Do not add abstract shapes to fill space.
- **Fake product imagery**: Do not draw CSS/SVG silhouettes, generic device mockups, fake dashboards, or fake product shots as final assets. Use real assets or labeled placeholders.
- **Default AI metaphor**: Avoid gradient orbs, abstract neural blobs, and glowing “AI magic” visuals unless the product’s own visual language uses them.

### Weak structure

- **Generic SaaS cards everywhere**: Use cards only to group independent modules or actions.
- **Card grids for linear content**: Use lists, steps, or sections when order matters.
- **Poor hierarchy**: Do not make every heading, number, and button visually loud.
- **Inconsistent spacing**: Use a scale; do not eyeball every margin.
- **Inconsistent corner radii**: Use project radius tokens by component level.
- **Rounded card with accent stripe**: Do not use `rounded card + left border accent` as the default container pattern. Reserve it for semantic callouts or status.
- **Three-column feature grid reflex**: Do not default every landing page to hero → three features → testimonials → CTA. Choose the structure from the product narrative.

### Typography failures

- **Tiny gray body text**: Body copy must be readable and contrast-compliant.
- **Too many type sizes**: Use a small hierarchy.
- **Centered paragraphs**: Avoid for long or functional content.
- **Uppercase overuse**: Hurts readability and localization.
- **Placeholder-as-label**: Forbidden for real forms.
- **Silent default fonts**: Do not use Inter, Roboto, Arial, system stacks, or fashionable display serifs as unexamined defaults. Use them only when the product system, platform, or chosen direction justifies them.

### Color failures

- **Inaccessible colors**: Contrast must pass, including disabled-adjacent and focus states.
- **Color-only status**: Add text/icon/shape.
- **Too many accents**: Keep semantic roles distinct.
- **Dark mode inversion**: Use designed dark tokens.
- **Invented inline palette**: Do not scatter raw hex values. Colors must trace to tokens, brand values, or a deliberate harmonious palette.

### Interaction failures

- **Weak empty states**: Empty states need cause and next action.
- **Poor loading states**: Avoid spinners where skeleton/progress/context is better.
- **No error recovery**: Errors need explanation and action.
- **Icon abuse**: Icons support labels; they rarely replace labels.
- **Excessive animations**: Motion must be purposeful and reduced-motion safe.
- **Hover-only controls**: Must be accessible to touch and keyboard.
- **Hidden destructive consequences**: State the object and result clearly.
- **Cosmetic variations**: Do not claim meaningful exploration when only accent color, shadow strength, or button radius changed.

### Engineering failures

- **Div buttons**: Use real buttons.
- **Click-only interactions**: Keyboard must work.
- **Positive tabindex**: Do not use.
- **Breaking DOM/visual order**: Avoid layouts that confuse focus and reading order.
- **One-off arbitrary values**: Promote recurring values to tokens.
- **New dependency for one widget**: Avoid unless it materially improves correctness/accessibility.
- **Mock states only**: Implement real states and data behavior.

---

## 27. Final Acceptance Criteria

A UI task is complete only when all applicable criteria are true.

### Experience

- The interface supports the user’s primary task end to end.
- The screen has a clear purpose, hierarchy, and next action.
- Information is grouped by user mental model.
- Navigation and current location are clear.
- Feedback exists for action, wait, success, failure, and recovery.

### Accessibility

- Semantic HTML is correct or custom semantics are fully implemented.
- Keyboard operation is complete and predictable.
- Focus is visible, persistent, and restored after modal/route/destructive changes.
- Accessible names, descriptions, labels, and error associations are present.
- Contrast meets WCAG AA targets.
- Reduced motion, zoom, text scaling, and non-color comprehension are supported.

### Responsiveness

- Layout works at small, medium, large, and constrained container sizes.
- Content remains usable with long text, missing data, localization, and large numbers.
- Touch targets and mobile behaviors are appropriate.
- No required task content disappears at smaller sizes.

### Component quality

- Existing components and tokens are reused where available.
- New components are composable, state-complete, accessible, and consistent.
- Variants are semantic and finite.
- Loading, empty, error, success, disabled, selected, and destructive states are handled where relevant.

### Visual quality

- Spacing, alignment, typography, color, radius, shadow, and icon usage are consistent.
- Decorative effects are intentional and restrained.
- The design does not imitate a vendor style unless explicitly requested.
- The UI remains understandable without motion, color, or decorative imagery.

### Engineering

- Implementation is maintainable and proportional.
- CSS uses tokens/utilities consistently.
- Performance avoids unnecessary layout shift, heavy JS, and oversized assets.
- Dark mode/theming uses semantic tokens if supported.
- The delivered result is verified in the specific scenario changed.

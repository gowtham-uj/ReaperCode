# Driving the browser

`browser_use` runs a Playwright program against a real browser that is already
open and already on the right page. You are not starting a browser, and you are
not calling a wrapper that hides Playwright — you write the Playwright.

Your program runs in the same sandbox `eval` uses, so it can read the workspace
and npm packages but not the filesystem outside it. It has no browser connection
of its own: `page` is a proxy that forwards each Playwright call to the real
page. Two differences follow, and they are worth knowing before you write:

**Await every call, including ones that look synchronous.**

```js
const url = await tabs.url();        // not tabs.url()
const count = await page.locator("a").count();
```

**A chain you have not awaited is a pending call, not a value.**

```js
const others = await page.context().browser().contexts().flatMap(c => c.pages());
if (others.length === 0) { /* this works, the chain was awaited */ }

const pending = page.context().browser().contexts().flatMap(c => c.pages());
if (pending.length === 0) { /* never true: pending.length is not a number */ }
```

Everything else is ordinary Playwright. `getByRole`, `locator`, `click`, `fill`,
`selectOption`, `inputValue`, `.catch()`, `.nth()`, arrays from `.all()` — all of
it behaves as it does outside, because the host is running the same library you
are writing against.

## The loop

Browsing is a loop of *look, act, look*. Getting the second look cheap is the
whole trick.

1. **Look.** `await view()` returns a small outline of the page.
2. **Act.** Write real Playwright against what you saw.
3. **Look at the change.** `await viewChanges()` returns only what is different.

Do not call `view()` again after every action. That re-sends the page and costs
the same as the first look, every step, for the whole task.

```js
await page.goto("https://jobs.example.com");
await view();                       // the page, once

await page.getByRole("link", { name: "AI Engineer" }).click();
await viewChanges();                // url moved, a heading and a button appeared

await page.getByRole("button", { name: "Apply" }).click();
await viewChanges();                // a form appeared
```

## What you get back

`view()` and `viewChanges()` return YAML-shaped text, the page as an
accessibility tree:

```
URL: https://jobs.example.com
Title: Jobs

- heading "Jobs" [level=1] [ref=e2]
- textbox "Search jobs" [ref=e5]
- button "Search" [ref=e6]
- link "AI Engineer" [ref=e9]:
  - /url: /j/1
```

Each line is a role, an accessible name, and — in `view()` — a `[ref=eN]` handle.

`viewChanges()` returns only the delta:

```
URL:
  https://jobs.example.com
  -> https://jobs.example.com/j/1

Added:
  - heading "AI Engineer" [level=1] [ref=e2]
  - button "Apply" [ref=e4]

Removed:
  - textbox "Search jobs"
```

## Write locators against the name, not the ref

The `[ref=eN]` handles are for *reading* the page. For acting, use a role and an
accessible name:

```js
// Good: survives a re-render, and reads like what a person would say.
await page.getByRole("button", { name: "Apply" }).click();
await page.getByLabel("Email").fill(email);
await page.getByRole("link", { name: /AI Engineer/i }).click();

// Bad: position-dependent, and silently points at a different element after
// the page re-renders.
await page.locator("div > button").nth(3).click();
```

If the outline shows a `testId`, that is the most stable locator of all: an
element with `[data-testid="submit"]` in the outline is
`page.getByTestId("submit")`.

## Scope a look when the page is large

`view()` prunes unnamed wrappers, but a real page is still big. If you only care
about a region, ask for it:

```js
return await view(page.getByRole("main"));
return await view(page.locator("form"));      // the first <form>
return await view(page.locator("#apply"));    // by id
```

That is the difference between 25,000 tokens of page and 500 for the form you
are actually filling.

Scope by *role* only where the role is real. A bare `<form>` has no ARIA `form`
role — that role exists only when the form is named — so `getByRole("form")`
matches nothing and the call fails. The same is true of `getByRole("region")`
on an unnamed section. `locator("form")` or an id always works; use a role when
the outline shows that role with a name.

## Understand one thing deeply

When a form or a component confuses you, get its detail rather than the page:

```js
const form = page.locator("form").first();
return await form.ariaSnapshot({ mode: "ai" });   // real Playwright, no wrapper
```

## One program, many actions

You are writing a program, so put the whole sequence in one call. This is real
Playwright — `locator.isVisible()`, loops, `Promise.all`, and branching all work:

```js
await page.goto("https://jobs.example.com");

const apply = page.getByRole("button", { name: "Apply" });
if (await apply.isVisible()) await apply.click();

await page.getByLabel("Email").fill(email);
await page.getByLabel("Password").fill(password);
await page.getByRole("button", { name: "Sign in" }).click();

return await viewChanges();
```

A form with six fields is six `.fill()` calls and one observation, not six round
trips through the model.

## When text is not enough

The outline is empty or useless for canvas, maps, charts, drag and drop, image
editors, CAPTCHA, and sites that build everything out of divs with no roles. For
those:

```js
return await screenshot();       // the page, as an image
```

Use it as escalation, not as the default. For ordinary forms and pages the
outline is smaller, more precise, and directly actionable.

## Multiple pages

A tab is a real Playwright page. It stays open between calls, so open one and
come back to it later:

```js
const cart = await browser.newPage("cart");      // the name is an argument
await cart.goto("https://shop.example.com/cart");

const tabs = await browser.pages();              // the real pages, this thread's only
await tabs[0].pageName;                          // its name, if it has one
await tabs[0].url();                             // pages, not records: Playwright works
await tabs[0].title();                           // and any of them can be driven
await tabs[0].isActivePage;                      // whether a bare `page` means this one
await browser.setActive("cart");                 // or: browser.page("cart")
await page.url();                                // the bare `page` is the cart now

await browser.closePage(cart);                   // and this one closes only it
```

`page` is always the active page, and each thread's pages are its own: another
agent's tabs are not reachable from here.

Prefer names to indices. `browser.setActive(1)` breaks the moment a page closes,
which is the reason pages are named at all: a model that opens a tab, works
elsewhere and comes back has no way to say which one it meant by position.

## What persists

- **Cookies and logins persist** across calls in this thread. Sign in once.
- **Open pages persist** while the browser stays up.
- **A killed script persists nothing.** For a long script that just logged in,
  `await browser.save()` writes the state immediately.

## What is refused

These throw `REAPER_REFUSED`, and the refusal is about the operation, not your
code:

- `chromium.launch()` and friends. Reaper owns the browser process; there is
  already one running and connected.
- Reading `chromium.executablePath()`.
- Installing a browser (`playwright install`, or a package manager fetching
  Chromium).

Use the browser you have. If it is not reachable, the error names the cause and
what to do — retrying with a launch call will not help.

## The shapes you will hit

- `await view()` — whole page. Use it once, at the start, and after a
  navigation that changed everything.
- `await view(locator)` — one region, for when the page is large.
- `await viewChanges()` — the delta. The one you want after an action.
- `await screenshot()` — an image, when the outline cannot describe it.
- `await browser.save()` — write cookies now, mid-script.
- The script's return value comes back as data, so `return await view()` gives
  the model the outline directly.

## Failures worth knowing

- **The click did nothing.** `viewChanges()` says `(no change)` or `URL
  unchanged`. The element was probably not the one you meant, or something
  covered it. Look again with `view()`.
- **The outline is empty.** The site is probably all divs. Escalate to
  `screenshot()`.
- **A locator matches several elements.** Playwright refuses rather than picking
  one. Add `.first()`, or narrow it with a name or a scope.
- **The page navigated and the old handles are stale.** This is normal;
  Playwright re-resolves locators, so keep using role-and-name locators rather
  than element handles you captured earlier.

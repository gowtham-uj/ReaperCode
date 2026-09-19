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

**A callback returning a promise makes the whole call a promise.**

```js
const wrong = list.find(async (p) => (await p.url()).includes("/cart"));   // a promise
const right = await list.find(async (p) => (await p.url()).includes("/cart")); // the page
```

So await the *call*, not a property of what it returns. `await wrong.pageName`
awaits a property of a promise and gives you `undefined`, which then fails
somewhere else with a message about a page that was never a page.

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

## Act with Playwright's own input, not with page JavaScript

This is the difference between an action a site accepts and one it blocks.

```js
// Trusted: Chrome generates the event because Playwright drives it through CDP.
await page.getByRole("button", { name: "Apply" }).click();
await page.getByLabel("Email").fill(email);
await page.locator("#search").press("Enter");

// NOT trusted: the page's own JavaScript dispatches it, and Chrome marks it.
await page.evaluate("document.querySelector('#apply').click()");
await page.evaluate("form.submit()");
```

Sites increasingly check `event.isTrusted`, and a synthetic event fails that
check. It cannot be faked: `isTrusted` is set by the browser and is read-only, so
an event dispatched from `evaluate` is always untrusted no matter how it is
wrapped. The fix is to use the real input API, which is trusted by construction.

That applies to everything a person does with a mouse or a keyboard:

| do this | not this |
|---|---|
| `locator.click()` | `evaluate("el.click()")` |
| `locator.fill(text)` | `evaluate("el.value = text")` |
| `locator.press("Enter")` | `evaluate("form.submit()")` |
| `locator.check()` | `evaluate("el.checked = true")` |
| `locator.selectOption(v)` | setting `.selectedIndex` |

`evaluate` still has its place: reading values, scrolling, waiting for a
condition, and the rare site where nothing else works. What it is not for is
*acting*, because that is the case where the untrusted marker costs you the task.

### A function or a string, as you prefer

`evaluate` and `waitForFunction` take either. Write whichever reads better:

```js
await page.evaluate(() => document.title);      // a function
await page.evaluate("document.title");          // a string
await page.waitForFunction(() => window.ready); // both work
```

## What you get back, and what you do not

A program that returns a value does **not** also get the page dumped after it.
If your program ends with

```js
return { registered: true, url: page.url() };
```

then that object is the whole answer, and the tool does not spend your context on
an accessibility tree you did not ask for. The page is sent when it is worth it:
after a failure, after a step that changed nothing, or when you ask for it.

So when you want to *see* the result of an action, ask in the program itself:

```js
await page.getByRole("button", { name: "Register" }).click();
return { url: page.url(), welcome: await page.getByText("Welcome").isVisible() };
```

That costs a few dozen tokens instead of thousands, and it is the same
information. Reach for `observe: "full"` only when you genuinely need the tree,
and `view({ selector })` when you need one region of it.

## Ask what the browser can do

Do not spend calls working out whether something is possible. Ask:

```js
const caps = await capabilities();
```

It answers, from live state: whether the browser is attached, whether downloads
can start a file on this connection, that trusted input is available (and that
`recover()` is the fix when a page ignores it), which settings apply to the page
now versus at the next launch, and that the download vault is shared with this
thread's workspace. It takes a moment and it is far cheaper than the experiment.

## When an action does nothing

A click that succeeds but dispatches no event, and a click that missed its
target, look identical from a receipt: `NO_CHANGE`, no error. There are two
causes and they need opposite responses.

1. **The locator was wrong.** Read the element back once and check it is the one
   you meant.
2. **The page stopped accepting input.** A renderer can reach a state where it
   renders, answers reads and navigates, but silently drops every trusted event:
   clicks do nothing, typing into a focused field does nothing, Tab never moves
   focus. It is per page, not per browser, and nothing on the page shows it.

For the second, ask before guessing. `probeInput()` answers it in one call:

```js
const check = await probeInput();          // the active page
const other = await probeInput(ti);        // or a page handle you hold
if (!check.delivered) {
  // The page is not accepting input. Nothing you click or type will land.
  await recover(ti);                       // replace that page's renderer
}
```

`probeInput` delivers one real mouse event and reports whether the page heard it,
on the same path a click takes. Use it instead of registering your own listeners
and clicking to test: that is the same experiment, done in one call rather than
ten.

Read the answer for what it is. `delivered: false` is real and means input is not
reaching that page at all. `delivered: true` means the page itself is not why your
click did nothing — so look at the locator, the element, or which tab you are
actually driving. (A blocked main thread and a backgrounded tab both still report
`delivered: true`, because Chrome queues the event either way; neither is the
failure this detects.)

`recover(target?)` replaces the page's renderer and puts it back on the same URL.
Pass the page you mean when you are driving one by handle; with no argument it
recovers the active page.

Logged-in state survives, because cookies live in the browser context rather than
in the renderer that was replaced. It takes a few seconds.

Give it two attempts. If a page still will not take input after that, it is not
going to, and the right move is to finish the task another way rather than to keep
testing the same click. Spending twenty steps proving a page is broken is twenty
steps not spent on the job.

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

`page` is always the *active* page, so it follows `browser.setActive` and
`browser.newPage`. A handle you keep names one specific page and stays with it,
which is how you come back to a tab you left:

```js
const [list] = await browser.pages();     // a handle to a specific tab
await browser.newPage("cart");            // `page` is the new tab now
await page.url();                         // ...the cart
await browser.setActive(list);            // back to the tab the handle names
```

Each thread's pages are its own: another agent's tabs are not reachable from here.

Prefer names to indices. `browser.setActive(1)` breaks the moment a page closes,
which is the reason pages are named at all: a model that opens a tab, works
elsewhere and comes back has no way to say which one it meant by position.

### A handle and the active page are different, and the receipt says which moved

A program that drives a handle does not change what the bare `page` means. So when
you act on a tab you found by URL, the receipt is about *that* tab, not about
`page`:

```js
const tabs = await browser.pages();
const ti = tabs.find(async (p) => (await p.url()).includes("the-internet"));
await ti.goto("/login");   // the receipt describes the-internet, not the active tab
```

Read the note. When the step moved a tab other than the active one, the receipt
says so by name and URL, and the page shown below it is that tab. That is not a
warning to act on; it is telling you where your own work landed.

The failure this prevents is specific and expensive: acting through a handle,
reading a receipt about a different tab, and concluding the click did nothing.
If a step reports `NO_CHANGE` and says other tabs changed, your action worked —
look at the tab it names rather than repeating the click.

## Downloads and uploads

A download is handled for you. You do not need `waitForEvent("download")`,
`saveAs`, a path, or any filesystem code: when you click a link that downloads a
file, the tool catches it and saves it into this thread's own folder.

Use `downloadAfter` when you want the file in the same step:

```js
// Click the thing AND get the file back, in one call.
const invoice = await downloadAfter(page.getByRole("link", { name: "Download Invoice" }));
// { name: "invoice.txt", path: "/…/downloads/invoice.txt", bytes: 66 }
```

Or check for it later with `downloads()` and `download(name)`:

```js
const files = await downloads();          // [{ name, bytes, url }]
const file = await download("invoice.txt"); // { name, path, bytes } or undefined
```

To upload, give `setInputFiles` the path from either call. The path is a real
absolute path in this thread's workspace, so it works directly:

```js
const file = await download("invoice.txt");
await page.locator("#uploadPicture").setInputFiles(file.path);
```

Files persist in the thread's workspace, so a file downloaded one step can be
uploaded on another site a hundred steps later. Do not build your own download
handling with `fetch` and `writeFile`: the vault is the supported path, and it is
what makes the cross-site transfer work after a restart.

If `downloadAfter` returns no file, **stop and report it**. Do not investigate:
not with `waitForEvent`, not with `goto` on the download URL, not by searching
the filesystem from a shell. Those are all attempts to work around the tool, and
they cannot help, because the failure is in the tool rather than in the page.
Measured: a model spent twenty minutes on one invoice this way, trying each of
them in turn, while the page it kept re-examining had worked the whole time. One
retry is reasonable if the click may genuinely have missed. After that, say the
download failed and finish the task another way.

## Changing how the browser presents itself

You can change the browser's own settings, and you should when a site treats you
badly. These are ordinary calls in scope, beside `view` and `browser`:

```js
await setUserAgent("Mozilla/5.0 ...");   // present as a different browser
await setTimezone("America/New_York");
await setViewport(1440, 900);
await setFullscreen(true);
await blockAds(true);                    // skip ad and tracker requests
await bandwidth({ blockImages: true });  // much smaller pages, much faster
const now = await settings();            // what is in force right now
```

They apply to the pages this thread already has open and to any page it opens
later, without restarting the browser, so you can change one mid-task when a site
starts behaving differently. `set({...})` takes several at once:

```js
await set({ userAgent: "...", timezone: "Europe/London", blockImages: true });
```

**Turn on image blocking when you are reading rather than looking.** A page with
its images, media and ads blocked loads several times faster and produces a much
smaller outline, and `view()` does not show images anyway. Reach for
`screenshot()` when you actually need to see the page.

**When a site blocks you.** A page that refuses you is reported as a `BLOCKED:`
line naming the reason, and the user agent is rotated automatically so the next
attempt looks different. You do not have to detect this yourself:

```js
return await view();   // says BLOCKED: the page reports unusual traffic
// then either try again, or change approach:
await setUserAgent("Mozilla/5.0 ...");
await page.reload();
```

Rotating the user agent is worth one retry, not five. If a site keeps refusing,
say so rather than burning the task on it.

**Two settings wait for the next launch.** `set({ userPreferences: {...} })` and
`persist` are Chrome profile settings with no per-page equivalent, so the call
tells you they apply when the browser next starts rather than pretending they
took effect now. Check the return: `applied` are live, `nextLaunch` are not.

## What persists

- **The live page is the real state.** Between calls in this thread it is the
  same Chromium, so the DOM as JavaScript has modified it, form values you
  typed, and the current URL are all still there. That is more than any
  saved-state file can hold, so prefer staying on a page over re-navigating to
  it.
- **Cookies, localStorage and IndexedDB persist** across calls and across a
  restart. Sign in once.
- **Open pages persist** while the browser stays up, and their URLs are restored
  after a restart.
- **Scroll position does not survive a restart.** Reopening a restored tab
  starts at the top, so scroll again if the position matters.
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
- `chromium.connectOverCDP(...)` against anything but the browser you already
  have. Reaper drives Chrome through Steel, which owns the browser process and
  the connection; connecting to Chrome directly skips that layer and gets a
  browser that is not the one the live pane is showing. There is no endpoint
  worth reaching this way, so it is refused rather than merely discouraged.
- `browser.close()` and `context.close()`. The browser outlives every call this
  thread makes: its pages, cookies, logins and live DOM all live in it, and
  nothing can bring them back once it is gone. Reaper owns that lifetime.

**Closing a tab is yours to do.** `await page.close()` and
`await browser.closePage(p)` work, and `await browser.newPage(name)` opens one.
The distinction is page versus browser, and it matters: end a tab when you are
done with it, but do not end the browser.

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

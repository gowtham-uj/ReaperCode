/**
 * A local site built to break browser tooling, on purpose.
 *
 * Debugging the collector against LinkedIn or Greenhouse is hopeless: real sites
 * are slow, they change under you, they rate-limit, and when something breaks
 * there are a dozen plausible causes. This fixture is the opposite of that. Every
 * page here is one hard case in isolation, served from loopback, deterministic,
 * and small enough to reason about completely.
 *
 * The pages are the cases that actually broke the collector during development,
 * each one now pinned so it cannot break again without a test saying so:
 *
 *   /basic     plain form, the control case
 *   /react     controlled inputs, the value that disagrees with the attribute
 *   /portal    a dialog rendered outside its parent, which has no DOM path home
 *   /iframe    same-origin frame, which needs its own CDP session
 *   /xframe    cross-origin frame, which cannot be read and must be reported
 *   /shadow    open and closed shadow roots
 *   /virtual   a list taller than the viewport, only partly in the DOM
 *   /popup     opens a second tab, which is how a session starts acting on the
 *              wrong page
 *   /svg       a clickable shape inside a decorative root
 *   /canvas    nothing in the DOM at all
 *   /mutation  a control replaced after a click, which is what makes a held
 *              locator stale
 *   /hidden    hidden fields and hidden sections
 *   /slow      content that appears late, so settle has something to wait for
 *
 * Two properties make this worth more than the sum of its pages. Nothing
 * depends on the network, so it runs anywhere and at any speed. And each page
 * carries a machine-readable list of what a correct collector must find, in
 * `window.__expected`, so the test asserting coverage and the page it asserts
 * against cannot drift apart.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

/** One page: its path, its markup, and what a correct read of it must contain. */
export interface TorturePage {
  path: string;
  title: string;
  html: string;
  /**
   * Selectors that must appear in a correct observation.
   *
   * Asserted against the collector's output rather than against the DOM, so a
   * page that renders correctly and is read incorrectly fails here.
   */
  expectPresent: string[];
  /** Selectors that must NOT be reported as actionable. */
  expectAbsent: string[];
  /** What this page is for, in one line, for the failure message. */
  why: string;
}

const NAV = `<nav><a href="/basic">basic</a> <a href="/react">react</a> <a href="/portal">portal</a> <a href="/iframe">iframe</a> <a href="/shadow">shadow</a> <a href="/virtual">virtual</a> <a href="/popup">popup</a> <a href="/svg">svg</a> <a href="/canvas">canvas</a> <a href="/mutation">mutation</a> <a href="/hidden">hidden</a> <a href="/slow">slow</a></nav><hr>`;

/** Wrap a page body in the minimum shell every fixture shares. */
function page(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body>${NAV}<main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

export const TORTURE_PAGES: TorturePage[] = [
  {
    path: "/basic",
    title: "Basic form",
    why: "the control case: everything here is a native control with a real label, so a failure means the collector is broken rather than the page being hard",
    html: page(
      "Basic form",
      `<h1>Apply</h1>
       <form id="apply">
         <label for="first">First name</label><input id="first" name="first">
         <label for="last">Last name</label><input id="last" name="last">
         <label for="country">Country</label>
         <select id="country" name="country"><option>US</option><option>DE</option></select>
         <label><input type="checkbox" id="remote"> Remote only</label>
         <button type="submit">Continue</button>
       </form>
       <p id="result"></p>`,
      `document.getElementById('apply').addEventListener('submit', (e) => {
         e.preventDefault();
         document.getElementById('result').textContent = 'submitted';
       });`,
    ),
    expectPresent: ["#first", "#last", "#country", "#remote", "#apply button"],
    expectAbsent: [],
  },
  {
    path: "/react",
    title: "Controlled inputs",
    why: "a controlled input's value attribute and its live value disagree, and the live one is what was typed",
    html: page(
      "Controlled inputs",
      `<h1>Controlled</h1>
       <div id="root"></div>
       <div id="out"></div>`,
      `let state = { name: '' };
       const root = document.getElementById('root');
       function render() {
         root.innerHTML = '<label for="c-name">Name</label><input id="c-name" value="' + state.name + '">' +
           '<button id="c-set">Set</button><p id="c-shown">' + state.name + '</p>';
         document.getElementById('c-set').onclick = () => { state.name = 'Set By Button'; render(); };
       }
       render();`,
    ),
    expectPresent: ["#c-name", "#c-set"],
    expectAbsent: [],
  },
  {
    path: "/portal",
    title: "Portal dialog",
    why: "a portal renders at the end of body, so the dialog has no ancestor path to the button that opened it",
    html: page(
      "Portal dialog",
      `<h1>Portal</h1><button id="open">Open dialog</button><div id="portal-root"></div>`,
      `document.getElementById('open').addEventListener('click', () => {
         const host = document.getElementById('portal-root');
         host.innerHTML = '<div role="dialog" aria-label="Confirm"><p id="d-text">Are you sure?</p>' +
           '<button id="d-yes">Yes</button><button id="d-no">No</button></div>';
       });`,
    ),
    expectPresent: ["#open"],
    expectAbsent: [],
  },
  {
    path: "/iframe",
    title: "Same-origin frame",
    why: "a same-origin iframe needs its own CDP session, and its contents are invisible to a read of the main frame",
    html: page(
      "Same-origin frame",
      `<h1>Frames</h1><iframe id="inner" src="/frame-inner" width="400" height="150"></iframe>`,
    ),
    expectPresent: ["#inner"],
    expectAbsent: [],
  },
  {
    path: "/frame-inner",
    title: "Frame contents",
    why: "the frame's own page, which must be read as its own document",
    html: page("Frame contents", `<h2>Inside frame</h2><button id="frame-btn">Frame button</button><input id="frame-input" aria-label="Frame input">`),
    expectPresent: ["#frame-btn", "#frame-input"],
    expectAbsent: [],
  },
  {
    path: "/xframe",
    title: "Cross-origin frame",
    why: "a cross-origin frame cannot be read, and the failure must be reported rather than looking like an empty page",
    html: page("Cross-origin frame", `<h1>Cross origin</h1><iframe id="far" src="http://127.0.0.2:1/nope" width="300" height="100"></iframe>`),
    expectPresent: ["#far"],
    expectAbsent: [],
  },
  {
    path: "/shadow",
    title: "Shadow roots",
    why: "shadow content is not in the light DOM, and a closed root is not reachable from the page at all",
    html: page(
      "Shadow roots",
      `<h1>Shadow</h1><div id="open-host"></div><div id="closed-host"></div>`,
      `const openHost = document.getElementById('open-host');
       const openRoot = openHost.attachShadow({ mode: 'open' });
       openRoot.innerHTML = '<button id="shadow-btn">Shadow button</button><input id="shadow-input" aria-label="Shadow input">';
       const closedHost = document.getElementById('closed-host');
       const closedRoot = closedHost.attachShadow({ mode: 'closed' });
       closedRoot.innerHTML = '<button id="closed-btn">Closed button</button>';`,
    ),
    expectPresent: ["#open-host"],
    expectAbsent: [],
  },
  {
    path: "/virtual",
    title: "Virtualized list",
    why: "a list whose rows are only in the DOM while visible, which is the case a naive read reports as short",
    html: page(
      "Virtualized list",
      `<h1>Virtual</h1><div id="viewport" style="height:300px;overflow:auto" aria-label="Results"><div id="spacer"></div></div>`,
      `const ROWS = 1000, ROW_H = 30;
       const viewport = document.getElementById('viewport');
       const spacer = document.getElementById('spacer');
       spacer.style.height = (ROWS * ROW_H) + 'px';
       function paint() {
         const first = Math.floor(viewport.scrollTop / ROW_H);
         const visible = Math.ceil(300 / ROW_H) + 2;
         const old = viewport.querySelectorAll('.row');
         for (const node of old) node.remove();
         for (let i = first; i < Math.min(ROWS, first + visible); i++) {
           const row = document.createElement('div');
           row.className = 'row';
           row.style.position = 'absolute';
           row.style.top = (i * ROW_H) + 'px';
           row.innerHTML = '<a href="/job/' + i + '">Job ' + i + '</a>';
           viewport.appendChild(row);
         }
       }
       viewport.addEventListener('scroll', paint);
       paint();`,
    ),
    expectPresent: ["#viewport"],
    expectAbsent: [],
  },
  {
    path: "/popup",
    title: "Popup",
    why: "a second tab is how a session that tracks 'the active page' silently starts acting on the wrong one",
    html: page(
      "Popup",
      `<h1>Popup</h1><button id="pop">Open a tab</button>`,
      `document.getElementById('pop').addEventListener('click', () => { window.open('/basic', 'other'); });`,
    ),
    expectPresent: ["#pop"],
    expectAbsent: [],
  },
  {
    path: "/svg",
    title: "Clickable SVG",
    why: "every SVG element has a role, so a naive read treats a decorative root as interactive",
    html: page(
      "Clickable SVG",
      `<h1>SVG</h1>
       <svg id="decor" width="60" height="60" aria-hidden="true"><rect width="60" height="60" fill="#eee"/></svg>
       <svg id="chart" width="120" height="40"><path id="bar" d="M0 40 L20 10 L40 40 Z"/></svg>
       <button id="after-svg">After</button>`,
      `document.getElementById('bar').addEventListener('click', () => { document.getElementById('after-svg').textContent = 'Clicked'; });`,
    ),
    expectPresent: ["#after-svg"],
    expectAbsent: [],
  },
  {
    path: "/canvas",
    title: "Canvas only",
    why: "nothing inside a canvas is in the DOM, so the only honest answer is to say so and escalate",
    html: page(
      "Canvas only",
      `<h1>Canvas</h1><canvas id="c" width="200" height="100"></canvas>`,
      `const ctx = document.getElementById('c').getContext('2d');
       ctx.fillStyle = '#4488cc'; ctx.fillRect(0, 0, 200, 100);
       ctx.fillStyle = '#fff'; ctx.fillText('Draw here', 60, 55);`,
    ),
    expectPresent: ["#c"],
    expectAbsent: [],
  },
  {
    path: "/mutation",
    title: "Control replaced after click",
    why: "the exact shape that makes a held locator stale: the button is gone and a new one has its name",
    html: page(
      "Mutation",
      `<h1>Mutation</h1><div id="host"><button id="go">Continue</button></div>`,
      `document.getElementById('go').addEventListener('click', () => {
         document.getElementById('host').innerHTML = '<button id="go2">Continue</button><p id="moved">Moved on</p>';
       });`,
    ),
    expectPresent: ["#go"],
    expectAbsent: [],
  },
  {
    path: "/hidden",
    title: "Hidden fields",
    why: "a hidden field is load-bearing state and must be reported, never dropped and never offered as a target",
    html: page(
      "Hidden fields",
      `<h1>Hidden</h1>
       <form id="hf">
         <input type="hidden" name="csrf" value="tok-abc-123">
         <input id="visible-field" aria-label="Visible field">
         <div style="display:none"><input id="hidden-div-input" aria-label="In hidden div" value="secret"></div>
         <button id="hf-submit">Send</button>
       </form>`,
    ),
    expectPresent: ["#visible-field", "#hf-submit"],
    expectAbsent: [],
  },
  {
    path: "/takeover",
    title: "User takeover",
    why: "the user edits the form while the agent is paused, which is how a model acts on a field value it never saw change",
    html: page(
      "User takeover",
      `<h1>Takeover</h1>
       <label for="t-phone">Phone</label><input id="t-phone" name="phone">
       <label for="t-email">Email</label><input id="t-email" name="email">
       <button id="t-save">Save</button>`,
    ),
    expectPresent: ["#t-phone", "#t-email", "#t-save"],
    expectAbsent: [],
  },
  {
    path: "/slow",
    title: "Late content",
    why: "content that arrives after load is why a settle step exists instead of a fixed sleep",
    html: page(
      "Late content",
      `<h1>Slow</h1><div id="late"></div>`,
      `setTimeout(() => {
         document.getElementById('late').innerHTML = '<button id="late-btn">Arrived</button>';
       }, 700);`,
    ),
    expectPresent: ["#late"],
    expectAbsent: [],
  },
  {
    path: "/zero-area",
    title: "Zero-area control",
    why:
      "a link sized to nothing with a clickable icon inside it is how every real page writes a delete button, and clicking the wrapper waits thirty seconds and fails while clicking the icon works",
    html: page(
      "Zero area",
      `<h1>Zero area</h1>
       <ul>
         <li><span id="row-label">First row</span>
           <a href="#" id="zero-delete" data-testid="zero-delete" style="display:inline-block;width:0;height:0;overflow:hidden">
             <svg width="16" height="16" viewBox="0 0 16 16" data-testid="zero-delete-icon"><path d="M2 2 L14 14 M14 2 L2 14" stroke="black"/></svg>
           </a>
         </li>
       </ul>
       <p id="zero-result">nothing deleted yet</p>`,
      `document.getElementById('zero-delete-icon')?.addEventListener('click', (event) => {
         event.preventDefault();
         document.getElementById('zero-result').textContent = 'deleted';
       });`,
    ),
    expectPresent: ["#zero-delete", "#row-label"],
    expectAbsent: [],
  },
  {
    path: "/form-limits",
    title: "Constrained form",
    why:
      "a field whose maxlength is the whole reason a submission was rejected, which a model otherwise discovers by trying another value",
    html: page(
      "Constrained form",
      `<h1>Register</h1>
       <form id="reg">
         <label for="reg-user">Username</label>
         <input id="reg-user" name="username" required maxlength="20">
         <label for="reg-email">Email</label>
         <input id="reg-email" name="email" type="email" required>
         <button id="reg-submit">Register</button>
       </form>`,
    ),
    expectPresent: ["#reg-user", "#reg-email", "#reg-submit"],
    expectAbsent: [],
  },
  {
    path: "/download",
    title: "Download",
    why:
      "a real download is the only thing that can prove the vault, the ledger's provenance record and the arm-before-trigger ordering actually work",
    html: page(
      "Download",
      `<h1>Download</h1>
       <a id="invoice-link" href="/download/invoice.txt" download="invoice.txt">Download Invoice</a>
       <a id="missing-link" href="/download/never.txt" download="never.txt">Download Missing</a>
       <p id="download-result">no download started</p>`,
    ),
    expectPresent: ["#invoice-link", "#download-result"],
    expectAbsent: [],
  },
  {
    path: "/popup-link",
    title: "Popup link",
    why:
      "a target=_blank link is the only thing that distinguishes a tab a click opened from one a program asked for, which is the provenance a verifier checks",
    html: page(
      "Popup link",
      `<h1>Popup</h1>
       <a id="popup-link" href="/basic" target="_blank">Open New Window</a>`,
    ),
    expectPresent: ["#popup-link"],
    expectAbsent: [],
  },
];

/** Render one page's HTML, or 404. */
function route(path: string): TorturePage | undefined {
  return TORTURE_PAGES.find((candidate) => candidate.path === path);
}

export interface RunningTortureSite {
  origin: string;
  close(): Promise<void>;
}

/**
 * Serve the fixture site on loopback.
 *
 * Port 0, so the tests never collide with anything else on the machine and two
 * test files can run at once. Loopback only: this is a fixture, not a service,
 * and nothing about it should ever be reachable from off the host.
 */
export async function startTortureSite(): Promise<RunningTortureSite> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    /*
     * The download route, which is the only way to prove the vault end to end.
     *
     * Served as an attachment so Chrome raises a real download event rather than
     * rendering the file, which is what makes `download`'s arm-before-trigger
     * ordering testable: an inline response would be a navigation and no event
     * would ever fire.
     */
    if (url.pathname === "/download/invoice.txt") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="invoice.txt"',
        "cache-control": "no-store",
      });
      response.end("invoice 4711: 66 bytes\n");
      return;
    }
    const found = route(url.pathname);
    if (!found) {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end(page("Not found", `<h1>404</h1><p>No fixture at ${url.pathname}</p>`));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(found.html);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fixture site did not bind a port");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async (): Promise<void> => {
      server.close();
      await once(server, "close");
    },
  };
}

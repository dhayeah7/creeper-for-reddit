const ARCTIC = 'https://arctic-shift.photon-reddit.com/api';
const PAGE_SIZE = 25;
const RENDER_CONCURRENCY = 6;
const PARTIAL = { Accept: 'text/vnd.reddit.partial+html, text/html;q=0.9' };

let run = null;

function profileContext() {
  const m = location.pathname.match(/^\/(?:user|u)\/([^/]+)\/?(?:(submitted|comments)\/?)?$/i);
  if (!m) return null;
  return { user: m[1], tab: (m[2] || 'overview').toLowerCase() };
}

// Set localStorage "creeper:force" = "1" to run on profiles that aren't hidden (handy for testing).
function isForced() {
  return localStorage.getItem('creeper:force') === '1';
}

function findEmptyState() {
  return document.querySelector('shreddit-feed #empty-feed-content');
}

// --- data -----------------------------------------------------------------

// Arctic Shift answers 422 "Timeout. Maybe slow down a bit" under load; its docs say to retry.
async function getJson(url, retries = 2) {
  const res = await fetch(url);
  if (res.ok) return res.json();
  if (retries > 0 && (res.status === 422 || res.status === 429 || res.status >= 500)) {
    await new Promise((r) => setTimeout(r, (3 - retries) * 1500));
    return getJson(url, retries - 1);
  }
  throw new Error(`HTTP ${res.status} for ${url}`);
}

// One archive stream (posts or comments), newest first, paged by created_utc.
function archiveSource(kind, user) {
  const s = { buffer: [], before: null, done: false };
  s.fill = async () => {
    const params = new URLSearchParams({ author: user, sort: 'desc', limit: String(PAGE_SIZE), fields: 'id,created_utc' });
    if (s.before) params.set('before', String(s.before));
    const { data } = await getJson(`${ARCTIC}/${kind}/search?${params}`);
    if (!data || data.length === 0) { s.done = true; return; }
    const prefix = kind === 'posts' ? 't3_' : 't1_';
    s.buffer.push(...data.map((d) => ({ name: prefix + d.id, created: d.created_utc })));
    s.before = data[data.length - 1].created_utc;
    if (data.length < PAGE_SIZE) s.done = true;
  };
  return s;
}

// k-way merge across sources so Overview stays in date order across page boundaries.
async function nextNames(sources, count) {
  const out = [];
  while (out.length < count) {
    await Promise.all(sources.filter((s) => s.buffer.length === 0 && !s.done).map((s) => s.fill()));
    const live = sources.filter((s) => s.buffer.length > 0);
    if (live.length === 0) break;
    const newest = live.reduce((a, b) => (b.buffer[0].created > a.buffer[0].created ? b : a));
    out.push(newest.buffer.shift().name);
  }
  return out;
}

// --- rendering --------------------------------------------------------------

function separator() {
  const hr = document.createElement('hr');
  hr.className = 'border-0 border-b-sm border-solid border-b-neutral-border-weak';
  return hr;
}

function fragmentFrom(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

// Reddit renders both item types itself, live, for any visitor. We only reject what the user deleted,
// because a public profile wouldn't list those either.
const RENDERERS = {
  t3: {
    url: (name) => `/svc/shreddit/partial-feed-post/${name}?pvc=ProfileFeed2&fvt=cardView`,
    pick: (frag) => {
      const post = frag.querySelector('shreddit-post');
      if (!post || post.hasAttribute('is-author-deleted') || post.getAttribute('author') === '[deleted]') return null;
      if (![...frag.children].some((el) => el.localName === 'hr')) frag.append(separator());
      return frag;
    },
  },
  t1: {
    url: (name) => `/svc/shreddit/comment/${name}?isProfile=true`,
    pick: (frag) => {
      const comment = frag.querySelector('shreddit-profile-comment');
      if (!comment || comment.querySelector('[author="[deleted]"]')) return null;
      // Same wrapper a public profile feed uses around each comment.
      const article = document.createElement('article');
      article.className = 'mb-0 w-full';
      article.dataset.feedElementId = comment.getAttribute('comment-id') || '';
      article.append(frag);
      const out = document.createDocumentFragment();
      out.append(article, separator());
      return out;
    },
  },
};

// Resolves to null for items Reddit won't show (deleted, removed, gone). Throws when Reddit is
// rate-limiting or down, so the caller stops instead of treating every item as deleted.
async function renderItem(name) {
  const renderer = RENDERERS[name.slice(0, 2)];
  const res = await fetch(renderer.url(name), { credentials: 'include', headers: PARTIAL });
  if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} for ${name}`);
  if (!res.ok) {
    console.warn('[creeper] not rendered', name, res.status);
    return null;
  }
  return renderer.pick(fragmentFrom(await res.text()));
}

// Starts every render (bounded), but yields results in feed order so items appear top to bottom.
function renderInOrder(names) {
  const results = names.map(() => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    // The caller stops at the first failure; later failures must not surface as unhandled.
    promise.catch(() => {});
    return { promise, resolve };
  });
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const i = next++;
      const render = renderItem(names[i]);
      results[i].resolve(render);
      await render.catch(() => {});
    }
  };
  for (let w = 0; w < Math.min(RENDER_CONCURRENCY, names.length); w++) worker();
  return results.map((r) => r.promise);
}

function svg(tag, attrs, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

// A drawn copy of 👀: a real emoji is one glyph, so its pupils can't move on their own.
function eyesIcon() {
  const eye = (cx, id) => {
    const shape = { cx, cy: 8, rx: 4.4, ry: 7.2 };
    return [
      svg('clipPath', { id }, svg('ellipse', shape)),
      svg('ellipse', { ...shape, fill: 'url(#creeper-eye-fill)', stroke: '#3b3b3b', 'stroke-width': 0.7 }),
      svg('g', { 'clip-path': `url(#${id})` },
        svg('g', { class: 'creeper-pupil' },
          svg('circle', { cx, cy: 8.6, r: 2.9, fill: '#24170f' }),
          svg('circle', { cx: cx - 0.9, cy: 7.6, r: 0.8, fill: '#fff' }))),
    ];
  };
  return svg('svg', { class: 'creeper-peek', viewBox: '0 0 20 16', width: 20, height: 16, 'aria-hidden': 'true' },
    svg('defs', {},
      svg('radialGradient', { id: 'creeper-eye-fill', cx: '45%', cy: '40%', r: '65%' },
        svg('stop', { offset: '0%', 'stop-color': '#fff' }),
        svg('stop', { offset: '100%', 'stop-color': '#d6d6d6' }))),
    ...eye(5.4, 'creeper-eye-l'),
    ...eye(14.6, 'creeper-eye-r'));
}

function peekingEyes(caption) {
  const loader = document.createElement('div');
  loader.className = 'creeper-loader';
  loader.setAttribute('role', 'status');
  loader.setAttribute('aria-label', caption || 'Loading more');
  loader.append(eyesIcon());
  if (caption) {
    const text = document.createElement('p');
    text.className = 'creeper-caption';
    text.textContent = caption;
    loader.append(text);
  }
  return loader;
}

// --- lifecycle --------------------------------------------------------------

function start(ctx, key) {
  const feed = document.querySelector('shreddit-feed');
  if (!feed) return;
  sweep(true);
  document.documentElement.classList.add('creeper-active');

  const root = document.createElement('div');
  root.id = 'creeper-feed';
  const status = document.createElement('div');
  status.className = 'creeper-status';
  root.append(status);
  feed.after(root);

  const kinds = { overview: ['posts', 'comments'], submitted: ['posts'], comments: ['comments'] }[ctx.tab];
  // queue: names fetched from the archive but not yet rendered, so a retry resumes where it failed.
  const me = { key, root, feed, sources: kinds.map((k) => archiveSource(k, ctx.user)), queue: [], loading: false, done: false, shown: 0 };
  run = me;

  const loadMore = async () => {
    if (me.loading || me.done || run !== me) return;
    me.loading = true;
    status.replaceChildren(peekingEyes(me.shown === 0 ? `creeping on u/${ctx.user}` : ''));
    try {
      const before = me.shown;
      // Keep pulling until something survives the deleted filter, or the archive runs out.
      while (me.shown === before && !me.done) {
        if (me.queue.length === 0) me.queue = await nextNames(me.sources, PAGE_SIZE);
        if (me.queue.length === 0) { me.done = true; break; }
        for (const pending of renderInOrder(me.queue.slice())) {
          const node = await pending;
          if (run !== me) return;
          me.queue.shift();
          if (!node) continue;
          status.before(node);
          if (me.shown++ === 0) status.querySelector('.creeper-caption')?.remove();
        }
      }
      status.textContent = me.done && me.shown === 0 ? 'No public posts or comments found.' : '';
      // The observer only fires on enter/leave; re-observing re-checks a status line that never left view.
      if (!me.done && run === me) { me.io.unobserve(status); me.io.observe(status); }
    } catch (err) {
      console.warn('[creeper]', err);
      if (run !== me) return;
      // A button, not scroll: the status line is usually already on screen, so the observer won't fire again.
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'creeper-retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', loadMore);
      status.replaceChildren("Couldn't load this user's history.", retry);
    } finally {
      me.loading = false;
    }
  };

  me.io = new IntersectionObserver((entries) => entries[0].isIntersecting && loadMore(), { rootMargin: '1200px' });
  me.io.observe(status);
}

// Feeds from runs that have stopped but are still on screen.
const leftovers = new Set();
const LEFTOVER_MS = 5000;

function stop() {
  if (!run) return;
  run.io?.disconnect();
  // Reddit changes the URL first and keeps the old page up until the next one is ready, then swaps
  // it out, taking our feed with it. Removing ours now would flash a bare profile in between.
  leftovers.add({ root: run.root, feed: run.feed, until: Date.now() + LEFTOVER_MS });
  run = null;
}

function sweep(all) {
  for (const l of leftovers) {
    // Some navigations (switching tabs) replace only the feed, so ours goes when the feed it followed goes.
    if (all || !l.feed.isConnected || !l.root.isConnected || Date.now() > l.until) {
      l.root.remove();
      leftovers.delete(l);
    }
  }
  if (!run && leftovers.size === 0) document.documentElement.classList.remove('creeper-active');
}

function check() {
  const ctx = profileContext();
  const key = ctx && `${ctx.user.toLowerCase()}|${ctx.tab}`;
  if (run && (run.key !== key || !run.root.isConnected)) stop();
  sweep(false);
  if (run || !ctx) return;
  if (findEmptyState() || (isForced() && document.querySelector('shreddit-feed'))) start(ctx, key);
}

let pending = null;
new MutationObserver(() => {
  clearTimeout(pending);
  pending = setTimeout(check, 50);
}).observe(document.documentElement, { childList: true, subtree: true });
check();

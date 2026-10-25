import { marked } from 'https://cdn.jsdelivr.net/npm/marked@18.1.1/lib/marked.esm.js';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.4.17/dist/purify.es.mjs';

const $ = id => document.getElementById(id);
const MAX_DOWNLOAD = 100 * 1024 * 1024;
const documentCache = new Map();
const archiveCache = new Map();
let source, current, active, revision = 0;

export function normalizePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value)) throw new Error('Ungültiger Archivpfad.');
  const parts = value.replace(/^\/+/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || !/\.(?:md|7z)$/i.test(value)) throw new Error('Ungültiger Archivpfad.');
  return parts.join('/');
}

export function parseRoute(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '') || 'README.md';
  const split = raw.indexOf('?');
  const path = normalizePath(decodeURIComponent(split < 0 ? raw : raw.slice(0, split)));
  const params = new URLSearchParams(split < 0 ? '' : raw.slice(split + 1));
  const entry = params.get('entry') || '';
  if (entry && (!/^[A-Za-z0-9_-]+\.md$/.test(entry) || !path.endsWith('.7z'))) throw new Error('Ungültiger Videopfad.');
  return { path, entry, at: params.get('at') || '' };
}

export function routeHref(route) {
  const params = new URLSearchParams();
  if (route.entry) params.set('entry', route.entry);
  if (route.at) params.set('at', route.at);
  return '#/' + route.path.split('/').map(encodeURIComponent).join('/') + (params.size ? '?' + params : '');
}

function status(message, { loading = false, error = false, retry = error, progress } = {}) {
  $('status-text').textContent = message;
  $('status').classList.toggle('error', error);
  $('retry').hidden = !retry;
  $('cancel').hidden = !loading;
  $('progress').hidden = !loading;
  if (loading && Number.isFinite(progress)) { $('progress').max = 1; $('progress').value = progress; }
  else $('progress').removeAttribute('value');
}

function cachePut(cache, key, value, bytes, maxBytes, maxItems) {
  if (bytes > maxBytes) return;
  cache.delete(key);
  cache.set(key, { value, bytes });
  while (cache.size > maxItems || [...cache.values()].reduce((sum, item) => sum + item.bytes, 0) > maxBytes) cache.delete(cache.keys().next().value);
}

function cacheGet(cache, key) {
  const item = cache.get(key);
  if (!item) return;
  cache.delete(key); cache.set(key, item);
  return item.value;
}

function fileUrl(path) { return new URL(path.split('/').map(encodeURIComponent).join('/'), source.base).href; }
function prettyBytes(bytes) { return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024) + ' MB'; }

async function download(path, signal) {
  const cached = path.endsWith('.7z') && cacheGet(archiveCache, path);
  if (cached) return cached;
  const response = await fetch(fileUrl(path), { signal, credentials: 'omit' });
  if (!response.ok) { const error = new Error(`Datei konnte nicht geladen werden (${response.status}): ${path}`); error.status = response.status; throw error; }
  const total = Number(response.headers.get('content-length')) || 0;
  if (total > MAX_DOWNLOAD) throw new Error('Diese Archivdatei ist größer als 100 MB.');
  const chunks = [];
  let received = 0;
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    if (blob.size > MAX_DOWNLOAD) throw new Error('Diese Archivdatei ist zu groß.');
    return blob;
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_DOWNLOAD) throw new Error('Diese Archivdatei ist zu groß.');
      chunks.push(value);
      status(`${prettyBytes(received)} geladen${total ? ' von ' + prettyBytes(total) : ''} …`, { loading: true, progress: total ? received / total : undefined });
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const blob = new Blob(chunks);
  if (path.endsWith('.7z')) cachePut(archiveCache, path, blob, blob.size, 100 * 1024 * 1024, 2);
  return blob;
}

async function decodeTranscript(blob, signal, entry) {
  const bytes = await blob.arrayBuffer();
  signal.throwIfAborted();
  const worker = new Worker(new URL('./archive-worker.mjs', import.meta.url), { type: 'module' });
  let abort;
  try {
    const result = await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason || new DOMException('Abgebrochen', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.bytes);
      worker.onerror = event => reject(new Error(event.message || 'Entpacken fehlgeschlagen.'));
      worker.postMessage({ bytes, entry }, [bytes]);
    });
    return new TextDecoder('utf-8', { fatal: true }).decode(result);
  } finally { signal.removeEventListener('abort', abort); worker.terminate(); }
}

async function loadDocument(route, signal) {
  const key = source.base + route.path + '?' + route.entry;
  const cached = cacheGet(documentCache, key);
  if (cached) return cached;
  const blob = await download(route.path, signal);
  let markdown;
  if (route.path.endsWith('.7z')) {
    if (!route.entry) throw new Error('Bitte das Video über seine Kanalübersicht öffnen.');
    status('Kanalarchiv wird entpackt …', { loading: true });
    markdown = await decodeTranscript(blob, signal, route.entry);
  } else markdown = await blob.text();
  if (markdown.length > 16 * 1024 * 1024) throw new Error('Dieses Dokument ist zu groß.');
  const document = { markdown, blob, path: route.path, entry: route.entry };
  cachePut(documentCache, key, route.path.endsWith('.7z') ? { ...document, blob: null } : document, markdown.length * 2 + (route.path.endsWith('.7z') ? 0 : blob.size), 24 * 1024 * 1024, 8);
  return document;
}

function resolveArchiveLink(href, document) {
  const basePath = document.entry ? document.path.slice(0, document.path.lastIndexOf('/') + 1) + document.entry : document.path;
  const url = new URL(href, 'https://archive.invalid/' + basePath);
  if (url.origin !== 'https://archive.invalid') return null;
  const path = normalizePath(decodeURIComponent(url.pathname));
  if (path.endsWith('.7z')) {
    const entry = decodeURIComponent(url.hash.slice(1));
    return { path, entry };
  }
  return { path, at: decodeURIComponent(url.hash.slice(1)) };
}

function decorateContent(document) {
  const content = $('content');
  content.dataset.path = document.path;
  content.dataset.entry = document.entry || '';
  content.innerHTML = DOMPurify.sanitize(marked.parse(document.markdown, { gfm: true, async: false }), {
    USE_PROFILES: { html: true }, FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input', 'video', 'audio'], FORBID_ATTR: ['style', 'srcset'],
  });
  for (const link of content.querySelectorAll('a[href]')) {
    try {
      const route = resolveArchiveLink(link.getAttribute('href'), document);
      if (route) link.href = routeHref(route);
      else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    } catch { link.removeAttribute('href'); }
  }
  for (const table of [...content.querySelectorAll('table')]) {
    const wrapper = window.document.createElement('div'); wrapper.className = 'table-scroll';
    table.before(wrapper); wrapper.append(table);
    if (table.querySelectorAll('thead th').length >= 6) table.classList.add('video-list');
  }
  $('filter-wrap').hidden = !content.querySelector('tbody tr');
  $('filter').value = ''; $('filter-result').hidden = true;
  $('toc').replaceChildren();
  const used = new Map();
  for (const heading of content.querySelectorAll('h1,h2,h3,h4')) {
    const slug = heading.textContent.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'abschnitt';
    const count = used.get(slug) || 0; used.set(slug, count + 1);
    heading.id = slug + (count ? '-' + count : '');
    if (!document.path.endsWith('README.md') && heading.tagName !== 'H1' && $('toc').childElementCount < 80) {
      const link = window.document.createElement('a'); link.textContent = heading.textContent;
      link.href = routeHref({ ...document, at: heading.id }); $('toc').append(link);
    }
  }
  $('toc-wrap').hidden = !$('toc').childElementCount;
  // Highlight timestamps using text nodes; untrusted content is never interpreted here.
  for (const paragraph of content.querySelectorAll('p')) {
    const node = paragraph.firstChild;
    if (node?.nodeType === Node.TEXT_NODE) {
      const match = node.textContent.match(/^\[\d{2,}:\d{2}:\d{2}\]/);
      if (match) { const span = window.document.createElement('span'); span.className = 'timestamp'; span.textContent = match[0]; node.textContent = node.textContent.slice(match[0].length); paragraph.prepend(span); }
    }
  }
  const title = content.querySelector('h1')?.textContent || 'Transkript-Archiv';
  window.document.title = title + ' · legends.army';
}

function breadcrumb(route) {
  const items = [{ label: 'Archiv', route: { path: 'README.md' } }];
  const parts = route.path.split('/');
  if (/^\d{4}$/.test(parts[0])) items.push({ label: parts[0], route: { path: parts[0] + '/README.md' } });
  if (parts.length > 2) items.push({ label: parts[1], route: { path: parts.slice(0, 2).join('/') + '/README.md' } });
  if (route.entry || !route.path.endsWith('README.md')) items.push({ label: (route.entry || parts.at(-1)).replace(/\.md$/, '') });
  $('breadcrumbs').replaceChildren();
  items.forEach((item, index) => {
    if (index) { const divider = document.createElement('span'); divider.textContent = '/'; $('breadcrumbs').append(divider); }
    const element = document.createElement(item.route && index < items.length - 1 ? 'a' : 'span'); element.textContent = item.label;
    if (element.tagName === 'A') element.href = routeHref(item.route);
    $('breadcrumbs').append(element);
  });
  for (const link of $('years').querySelectorAll('a')) {
    if (link.dataset.year === parts[0]) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
}

async function loadYears() {
  try {
    const response = await fetch(fileUrl('README.md'), { credentials: 'omit' });
    if (!response.ok) return;
    const markdown = await response.text();
    $('years').replaceChildren();
    for (const match of markdown.matchAll(/^\|\s*\[(\d{4})\]\(([^)]+)\)([^|]*)\|/gm)) {
      const link = document.createElement('a'); link.textContent = match[1]; link.dataset.year = match[1]; link.href = routeHref({ path: normalizePath(match[2]) });
      if (match[3].includes('incomplete')) { const note = document.createElement('small'); note.textContent = '(incomplete)'; link.append(note); }
      $('years').append(link);
    }
    if (current) breadcrumb(current);
  } catch { /* Loading the selected document will display a useful network error. */ }
}

async function navigate() {
  if (!source) return;
  const id = ++revision;
  active?.abort(); active = new AbortController();
  let route;
  try {
    route = parseRoute();
    if (current && current.routeKey === route.path + ':' + route.entry) {
      current.at = route.at;
      status(current.entry ? 'Transkript geladen' : 'Dokument geladen');
      $('share').disabled = false; $('download-original').disabled = false; $('download-markdown').disabled = false;
      if (route.at) document.getElementById(route.at)?.scrollIntoView();
      return;
    }
    status('Dokument wird geladen …', { loading: true });
    $('content').setAttribute('aria-busy', 'true');
    $('share').disabled = true; $('download-original').disabled = true; $('download-markdown').disabled = true;
    const loaded = await loadDocument(route, active.signal);
    if (id !== revision) return;
    current = { ...loaded, at: route.at, routeKey: route.path + ':' + route.entry };
    if (loaded.path !== route.path || loaded.entry !== route.entry) {
      history.replaceState(null, '', routeHref({ ...loaded, at: route.at }));
      current.routeKey = loaded.path + ':' + loaded.entry;
    }
    decorateContent(current); breadcrumb(current);
    $('content').setAttribute('aria-busy', 'false');
    $('share').disabled = false; $('download-original').disabled = false; $('download-markdown').disabled = false;
    $('download-original').textContent = loaded.path.endsWith('.7z') ? 'Kanalarchiv' : 'Originaldatei';
    status(loaded.entry ? 'Transkript geladen' : 'Dokument geladen');
    $('content').focus({ preventScroll: true });
    if (route.at) document.getElementById(route.at)?.scrollIntoView(); else scrollTo(0, 0);
  } catch (error) {
    if (id !== revision) return;
    $('content').setAttribute('aria-busy', 'false');
    if (error.name === 'AbortError') status('Laden abgebrochen.', { retry: true });
    else status(error.message || 'Dokument konnte nicht geöffnet werden.', { error: true });
  }
}

async function configure() {
  const response = await fetch('./repository.json');
  if (!response.ok) throw new Error('Das Archiv konnte nicht geladen werden.');
  const { repository, branch } = await response.json();
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || typeof branch !== 'string' || !branch.trim()) {
    throw new Error('Das Archiv ist nicht korrekt konfiguriert.');
  }
  source = { repository, branch, base: `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(branch)}/` };
  $('repository-link').href = 'https://github.com/' + repository;
  $('repository-link').hidden = false;
  void loadYears();
  await navigate();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}

$('filter').addEventListener('input', () => {
  const term = $('filter').value.toLocaleLowerCase('de-DE');
  const rows = [...$('content').querySelectorAll('tbody tr')]; let visible = 0;
  for (const row of rows) { row.hidden = !row.textContent.toLocaleLowerCase('de-DE').includes(term); if (!row.hidden) visible++; }
  $('filter-result').hidden = !term; $('filter-result').textContent = `${visible} von ${rows.length} Einträgen`;
});
$('retry').addEventListener('click', () => {
  if (source) void navigate();
  else void configure().catch(error => status(error.message, { error: true }));
});
$('cancel').addEventListener('click', () => active?.abort());
$('share').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); status('Link kopiert.'); } catch { status('Der Link steht in der Adresszeile und kann dort kopiert werden.'); }
});
$('download-markdown').addEventListener('click', () => current && downloadBlob(new Blob([current.markdown], { type: 'text/markdown;charset=utf-8' }), current.entry || current.path.split('/').at(-1)));
$('download-original').addEventListener('click', async () => {
  if (!current) return;
  try {
    const blob = current.blob || await download(current.path, new AbortController().signal);
    downloadBlob(blob, current.path.split('/').at(-1));
    status('Download vorbereitet.');
  } catch (error) { status(error.message, { error: true }); }
});
document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); $('content').focus(); $('content').scrollIntoView(); });
window.addEventListener('hashchange', () => void navigate());
void configure().catch(error => status(error.message, { error: true }));

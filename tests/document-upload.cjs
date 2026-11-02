// Run against a built local app, or set UPLOAD_TEST_BASE_URL to production.
// Uses isolated disposable accounts and removes their PDFs before deleting users.
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { chromium } = require('@playwright/test');
const { createClient } = require('@supabase/supabase-js');
const { createServerClient } = require('@supabase/ssr');

const base = process.env.UPLOAD_TEST_BASE_URL || 'http://127.0.0.1:3000';
const runAnalysis = process.argv.includes('--analysis');
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
const users = [];
const evidence = { base, runAnalysis, checks: [], requests: [] };
const check = message => { evidence.checks.push(message); console.log('PASS:', message); };
let browser;

async function account() {
  const email = `upload-regression-${randomUUID()}@example.com`;
  const password = `Test-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  users.push(data.user.id);
  const cookies = new Map();
  const client = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
      setAll: values => values.forEach(c => cookies.set(c.name, c.value)) },
  });
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: data.user.id, client, cookies: [...cookies].map(([name, value]) => ({ name, value, url: base })) };
}

async function main() {
  const owner = await account();
  const foreign = await account();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  await context.addCookies(owner.cookies);
  const otherContext = await browser.newContext();
  await otherContext.addCookies(foreign.cookies);
  const api = context.request;
  const requestId = randomUUID();
  const metadata = { requestId, filename: 'pending.pdf', size: 100, type: 'application/pdf' };
  let response = await api.post(`${base}/api/documents`, { data: metadata });
  assert.equal(response.status(), 200, await response.text());
  const prepared = await response.json();
  response = await api.post(`${base}/api/documents`, { data: metadata });
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).path, prepared.path);
  check('Authorization retry preserves the same document and server-assigned path');
  response = await api.post(`${base}/api/process-document`, { data: { document_id: requestId } });
  assert.equal(response.status(), 409);
  check('Extraction rejects an unfinished upload');
  response = await otherContext.request.post(`${base}/api/documents/${requestId}/complete`);
  assert.equal(response.status(), 404);
  check('Cross-user completion is rejected');
  const forged = await owner.client.from('documents').update({ upload_verified_at: new Date().toISOString() }).eq('id', requestId);
  assert.ok(forged.error);
  check('Authenticated clients cannot forge verification');
  const wrong = await admin.storage.from('rfps').uploadToSignedUrl(prepared.path, prepared.token, Buffer.from('%PDF-'), { contentType: 'application/pdf' });
  assert.equal(wrong.error, null);
  response = await api.post(`${base}/api/documents/${requestId}/complete`);
  assert.equal(response.status(), 409);
  check('Completion rejects a persisted object with the wrong size');
  response = await api.delete(`${base}/api/documents/${requestId}`);
  assert.equal(response.status(), 200, await response.text());
  assert.ok((await admin.storage.from('rfps').info(prepared.path)).error);
  check('Existing storage-first delete removes the object and document');

  const page = await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error') console.log('Browser:', message.text().slice(0, 1000));
  });
  page.on('response', response => {
    if (response.status() >= 400 && response.url().includes('/storage/v1/upload/resumable')) {
      response.text().then(body => console.log('Storage upload error:', response.status(), body.slice(0, 500))).catch(() => {});
    }
  });
  page.on('request', req => {
    const url = new URL(req.url());
    if (req.method() === 'POST' && url.pathname === '/api/documents') {
      const body = req.postDataBuffer();
      evidence.requests.push({ path: url.pathname, method: req.method(), bytes: body?.length || 0, contentType: req.headers()['content-type'] });
      assert.ok((body?.length || 0) < 2048);
      assert.match(req.headers()['content-type'], /application\/json/);
    }
    if (url.pathname.includes('/storage/v1/upload/resumable') && ['POST', 'PATCH'].includes(req.method())) {
      evidence.requests.push({ host: url.host, path: url.pathname, method: req.method(), bytes: req.postDataBuffer()?.length || 0 });
    }
  });
  if (!runAnalysis) {
    await page.route('**/api/analyze-document', route => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated dispatch failure for recovery test' }),
    }));
  }
  await page.goto(`${base}/dashboard`);
  await page.getByRole('button', { name: 'Upload Tender', exact: true }).click();
  const beforeOversize = evidence.requests.length;
  await page.locator('input[type=file]').setInputFiles({ name: 'oversize.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  await page.getByText('PDF must be between 1 byte and 10 MB.').waitFor();
  assert.equal(evidence.requests.length, beforeOversize);
  check('PDF over 10 MB is rejected before any upload or authorization request');

  const fixture = path.resolve(process.env.UPLOAD_TEST_PDF || 'real-world-docs/6565dbb36c16dTenderdoc144.pdf');
  const bytes = fs.statSync(fixture).size;
  assert.ok(bytes > 4.5 * 1024 * 1024 && bytes <= 10 * 1024 * 1024);
  evidence.pdfBytes = bytes;
  // Pause the final chunk, refresh, then reselect the same file to resume.
  let interrupted;
  const interruptedPromise = new Promise(resolve => { interrupted = resolve; });
  await page.route('**/storage/v1/upload/resumable/**', route => {
    if (route.request().method() === 'PATCH') { interrupted(); return route.abort(); }
    return route.continue();
  });
  await page.locator('input[type=file]').setInputFiles(fixture);
  await page.getByRole('button', { name: 'Start Tender Ingestion & Analysis' }).click();
  await Promise.race([interruptedPromise, page.getByText(/^(Upload|Processing) Failed$/).waitFor({ timeout: 120000 }).then(async () => { throw new Error('Upload failed before interruption: ' + await page.locator('body').innerText()); })]);
  await page.reload();
  await page.unroute('**/storage/v1/upload/resumable/**');
  let lostCompletion = false;
  await page.route('**/api/documents/*/complete', async route => {
    const result = await route.fetch();
    if (result.status() === 200 && !lostCompletion) {
      lostCompletion = true;
      return route.abort(); // Server verified it, but the browser loses the response.
    }
    return route.fulfill({ response: result });
  });
  await page.getByRole('button', { name: 'Upload Tender', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(fixture);
  const processResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/process-document', { timeout: 120000 });
  await page.getByRole('button', { name: 'Start Tender Ingestion & Analysis' }).click();
  await page.getByText(/^(Upload|Processing) Failed$/).waitFor({ timeout: 120000 });
  assert.ok(lostCompletion);
  check('A lost completion response does not display upload success or start extraction');
  await page.getByRole('button', { name: 'Retry Upload & Processing' }).click();
  const extracted = await processResponse;
  assert.equal(extracted.status(), 200, await extracted.text());
  const extraction = await extracted.json();
  assert.equal(extraction.status, 'TEXT_EXTRACTED');
  check('Browser resumes an interrupted >4.5 MB PDF upload after refresh and extraction completes');
  const { data: docs, error: docsError } = await admin.from('documents').select('*').eq('user_id', owner.id);
  assert.equal(docsError, null);
  assert.equal(docs.length, 1);
  const doc = docs[0];
  evidence.documentId = doc.id;
  evidence.extractedPages = extraction.diagnostics.total_pages;
  assert.ok(doc.upload_verified_at);
  const stored = await admin.storage.from('rfps').info(doc.storage_path);
  assert.equal(stored.error, null);
  assert.equal(stored.data.size, bytes);
  check('One document is persisted with the exact object size and server verification');
  const completes = await Promise.all([api.post(`${base}/api/documents/${doc.id}/complete`), api.post(`${base}/api/documents/${doc.id}/complete`)]);
  assert.ok(completes.every(r => r.status() === 200));
  check('Duplicate completion requests are idempotent');
  const forbidden = await foreign.client.storage.from('rfps').download(doc.storage_path);
  assert.ok(forbidden.error);
  check('Another user cannot read the persisted private PDF');
  const library = await api.get(`${base}/api/documents`);
  assert.ok((await library.json()).documents.some(d => d.id === doc.id));
  check('Document appears in the existing library');
  if (runAnalysis) {
    await page.getByText('Tender Accepted & Queued', { exact: true }).waitFor({ timeout: 120000 });
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      const { data: runs } = await admin.from('analysis_runs').select('id,status,last_error').eq('document_id', doc.id);
      if (runs?.some(r => r.status === 'COMPLETED')) { evidence.analysisRuns = runs; break; }
      if (runs?.some(r => r.status === 'FAILED')) throw new Error(`Analysis failed: ${JSON.stringify(runs)}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    assert.ok(evidence.analysisRuns, 'Analysis did not complete in ten minutes');
    const { data: ledger } = await admin.from('analysis_entitlement_ledger').select('status').eq('document_id', doc.id);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].status, 'CONSUMED');
    evidence.ledger = ledger;
    check('Existing analysis completes and exactly one quota reservation is consumed');
    await page.goto(`${base}/documents/${doc.id}`);
    assert.equal(new URL(page.url()).pathname, `/documents/${doc.id}`);
    check('Existing document workspace opens');
  } else {
    await admin.from('documents').update({ status: 'PROCESSING', extraction_lease_until: new Date(Date.now() + 90000).toISOString() }).eq('id', doc.id);
    const busy = await api.post(`${base}/api/process-document`, { data: { document_id: doc.id } });
    assert.equal(busy.status(), 409);
    await admin.from('documents').update({ extraction_lease_until: new Date(Date.now() - 1000).toISOString() }).eq('id', doc.id);
    const races = await Promise.all([api.post(`${base}/api/process-document`, { data: { document_id: doc.id } }), api.post(`${base}/api/process-document`, { data: { document_id: doc.id } })]);
    assert.deepEqual(races.map(r => r.status()).sort(), [200, 409]);
    check('An active extraction lease blocks duplicates; an expired lease allows exactly one concurrent recovery');
    await page.getByText('Simulated dispatch failure for recovery test').waitFor();
    await page.getByRole('button', { name: 'Retry Upload & Processing' }).click();
    await page.getByText('Simulated dispatch failure for recovery test').waitFor();
    const count = await admin.from('documents').select('id', { count: 'exact', head: true }).eq('user_id', owner.id);
    assert.equal(count.count, 1);
    check('Retry after dispatch failure reuses the document and extracted pages');
  }
  await context.close();
  await otherContext.close();
}

main().catch(error => { evidence.error = error.message; console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  for (const id of users) {
    const { data: docs } = await admin.from('documents').select('storage_path').eq('user_id', id);
    if (docs?.length) {
      const { error } = await admin.storage.from('rfps').remove(docs.map(d => d.storage_path));
      if (error) { console.error('Cleanup storage failure:', error.message); process.exitCode = 1; continue; }
    }
    const result = await admin.auth.admin.deleteUser(id);
    if (result.error) { console.error('Cleanup user failure:', result.error.message); process.exitCode = 1; }
  }
  fs.mkdirSync('scratch', { recursive: true });
  fs.writeFileSync(`scratch/upload-test-${new URL(base).hostname}.json`, JSON.stringify(evidence, null, 2));
});

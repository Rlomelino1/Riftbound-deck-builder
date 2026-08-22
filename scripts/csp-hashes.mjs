#!/usr/bin/env node
/**
 * csp-hashes.mjs — recompute the sha256 of every inline <script> in index.html
 * and write them into the page's own Content-Security-Policy.
 *
 *   node scripts/csp-hashes.mjs           # report; non-zero exit if stale
 *   node scripts/csp-hashes.mjs --write   # update the meta tag in place
 *
 * WHY THIS EXISTS
 * ---------------
 * The app is one self-contained HTML file, so its JavaScript is inline. A CSP
 * that keeps `script-src 'unsafe-inline'` to allow that also allows any script
 * an attacker manages to inject, which makes the policy decorative: one missed
 * esc() becomes an XSS. Pinning a hash per inline script lets the policy drop
 * 'unsafe-inline' entirely — the app's own scripts are named, and nothing else
 * inline can run, event handlers included.
 *
 * THE COST, STATED PLAINLY
 * ------------------------
 * Every edit to any inline script changes its hash, and a stale hash is not a
 * warning — it is a blank page. Three things keep that from reaching anyone:
 *   - .gitattributes pins index.html to LF, so the bytes a browser receives are
 *     the same on Windows, on CI and on Pages. Without it a hash can only match
 *     one of the three;
 *   - tests/e2e/csp.spec.js recomputes the hashes and fails if they have moved,
 *     and `main` will not accept a red e2e;
 *   - this script prints exactly what to do about it.
 *
 * This is not a build step: the output is a static string committed to the file,
 * and nothing is generated at runtime or at deploy time.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const FILE = new URL("../index.html", import.meta.url);
const WRITE = process.argv.includes("--write");

const html = await readFile(FILE, "utf8");

if (html.includes("\r\n")) {
  console.error("index.html contains CRLF line endings. The hash would not match");
  console.error("what GitHub Pages serves. Check .gitattributes, then:");
  console.error("  git add --renormalize index.html");
  process.exit(2);
}

/* The browser hashes the element's text content exactly — every byte between
   the tags, leading and trailing newlines included.

   HTML comments are blanked FIRST. A comment that merely mentions a script tag
   is not a script element, and matching one shifts every hash after it — which
   means a blank page, discovered in production. This bit me while writing the
   comment above the CSP itself. Blanked rather than deleted so byte offsets, and
   therefore anything else read from this string, stay put. */
const scannable = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
const scripts = [...scannable.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]);

const sha = (s) => "'sha256-" + createHash("sha256").update(s, "utf8").digest("base64") + "'";
const hashes = scripts.map(sha);

const cspRe = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/;
const found = cspRe.exec(html);
if (!found) { console.error("no CSP meta tag in index.html"); process.exit(2); }

const policy = found[2];
const srcRe = /script-src ([^;]*)/;
const current = srcRe.exec(policy);
if (!current) { console.error("no script-src in the CSP"); process.exit(2); }

/* 'self' stays: the inline module imports the vendored Neon SDK from this
   origin, and those fetches are script-src too. What goes away is
   'unsafe-inline', which is the whole point. */
const wanted = `script-src ${hashes.join(" ")} 'self'`;
const already = current[0].trim() === wanted;

console.log(`inline scripts: ${scripts.length}`);
scripts.forEach((s, i) => console.log(`  ${i}  ${String(s.length).padStart(7)} chars  ${hashes[i]}`));
console.log(`\ncurrent: ${current[0].trim()}`);
console.log(`wanted : ${wanted}`);

if (already) { console.log("\nup to date"); process.exit(0); }

if (!WRITE) {
  console.error("\nSTALE — the policy does not match the scripts. Re-run with --write.");
  process.exit(1);
}

const updated = html.replace(cspRe, (_, a, pol, c) => a + pol.replace(srcRe, wanted) + c);
await writeFile(FILE, updated);
console.log("\nwritten");

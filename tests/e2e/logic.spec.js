import { test, expect } from "@playwright/test";
import { openApp } from "./helpers.js";

// Pure-logic tests driven against the real page via page.evaluate — no logic is
// extracted from index.html, so the single-file constraint is untouched. These
// are the highest-value/lowest-cost tests: deck (de)serialization, collection
// sanitization, and the escaping the XSS fix depends on.

test("serializeDeck / hydrateDeck round-trips a slim {ref,qty} deck", async ({ page }) => {
  await openApp(page);
  const ok = await page.evaluate(() => {
    // Build a small legal-ish deck from real pool cards.
    const units = S.pool.filter(c => c.type === "Unit").slice(0, 3);
    S.zones.main = units.map(c => ({ ...c, id: uid(), qty: 2 }));
    S.legend = { ...S.pool.find(c => c.type === "Legend") };
    const serialized = serializeDeck();
    // Fresh hydrate from the serialized form.
    hydrateDeck(serialized);
    const again = serializeDeck();
    return JSON.stringify(serialized) === JSON.stringify(again);
  });
  expect(ok).toBe(true);
});

test("hydrateDeck preserves an unresolved ref instead of dropping it", async ({ page }) => {
  await openApp(page);
  const res = await page.evaluate(() => {
    hydrateDeck({ zones: { main: [{ ref: "zzz-999-does-not-exist", qty: 2 }] }, legend: null });
    return {
      unresolved: S.unresolved.length,
      ref: S.unresolved[0]?.ref,
      qty: S.unresolved[0]?.qty,
      countedInZone: zoneCount("main"),
    };
  });
  expect(res.unresolved).toBe(1);
  expect(res.ref).toBe("zzz-999-does-not-exist");
  expect(res.qty).toBe(2);
  expect(res.countedInZone).toBe(2); // still counts toward the deck, per design
});

test("liftCollection clamps out-of-range and non-numeric quantities", async ({ page }) => {
  await openApp(page);
  // A flat (pre-stage-9) blob lifts under riftbound and clamps to ITS cap of 3.
  const out = await page.evaluate(() =>
    liftCollection({ a: 0, b: 2, c: 7, d: "two", e: -1, f: 1, g: 3.9 }));
  // 0/-1 dropped, "two" dropped, 7 clamped to 3, 2 and 1 kept, 3.9 floored to 3.
  expect(out).toEqual({ riftbound: { b: 2, c: 3, f: 1, g: 3 } });
});

/* jsStr() is gone, and this replaces its test. It existed because a value bound
   for an inline handler had to survive the HTML attribute parser AND THEN the JS
   parser. Nothing is inline now, so the guarantee worth asserting is different
   and stronger: no control anywhere carries executable markup at all. */
test("no control carries an inline handler, in either game", async ({ page }) => {
  for (const game of ["riftbound", "pokemon"]) {
    await page.addInitScript((g) => localStorage.setItem("ch.game", g), game);
    await openApp(page);
    if (game === "pokemon") await page.waitForFunction(() => PIDX !== null);
    // Render as much of the app as one page can hold at once.
    await page.evaluate(() => {
      addCard(refOf(S.pool[0]), "main");
      toggleDeckMenu(true);
      toggleGameMenu(true);
      paintCard(S.pool[0]);
      location.hash = "collection";
      applyHash();
    });
    await page.waitForTimeout(200);
    const found = await page.evaluate(() => {
      const bad = [];
      for (const el of document.querySelectorAll("*"))
        for (const at of el.attributes)
          if (/^on/i.test(at.name)) bad.push(el.tagName + "[" + at.name + "]");
      return bad;
    });
    expect(found, `inline handlers found in ${game}`).toEqual([]);
  }
});

test("a hostile value in a data attribute stays a string", async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(() => {
    // A payload that tries to close its attribute and add a different action.
    const evil = `" data-a="wipe" x="`;
    document.getElementById("results").innerHTML =
      `<button id="probe" data-a="openCard" data-a1="${esc(evil)}">x</button>`;
    const el = document.getElementById("probe");
    return { action: el.dataset.a, arg: el.dataset.a1, attrs: el.attributes.length };
  });
  // It stayed inside its own attribute: the action was not rewritten.
  expect(r.action).toBe("openCard");
  expect(r.arg).toBe(`" data-a="wipe" x="`);
  expect(r.attrs).toBe(3);
});

test("esc encodes HTML metacharacters for text context", async ({ page }) => {
  await openApp(page);
  const out = await page.evaluate(() => esc(`<img src=x onerror=alert(1)>&"'`));
  expect(out).toBe("&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;");
});

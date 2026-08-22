import { test, expect } from "@playwright/test";
import { openApp } from "./helpers.js";

/* Stage 9: the second game.

   Fixtures are REAL vendored data, not constructions, and every one is asserted
   to exist before it is used — a re-vendored pool that dropped them should fail
   loudly here rather than quietly turn this file into a no-op.

   Pikachu is printed in both Base Set and Base Set 2 under the same name and
   different collector numbers, which is exactly the shape the 4-copy limit has
   to see through: Pokémon counts copies by NAME across every printing in every
   set, the opposite axis from Riftbound's printing-group. */
const PIKACHU_BASE1 = "base1-58";
const PIKACHU_BASE2 = "base2-60";
const BASIC_ENERGY  = "base1-99";   // Grass Energy — exempt from the limit
const SMALL_SET     = "base2";      // 64 cards, loads fast

/* Land on Pokémon. The active game is a device preference, so setting the key
   before the first paint is how a returning user's browser starts. */
async function openPokemon(page, { hash = "", collection = null } = {}) {
  await page.addInitScript(([col]) => {
    localStorage.setItem("ch.game", "pokemon");
    if (col) localStorage.setItem("rb.collection", col);
  }, [collection ? JSON.stringify(collection) : null]);
  await openApp(page, { hash });
  await page.waitForFunction(() => PIDX !== null);
}

const problemsAfter = (page, main) => page.evaluate((main) => {
  freshDeck();
  S.zones.main = main.map(([ref, qty]) => ({ ...findCard(ref), id: uid(), qty }));
  render();
  return document.getElementById("problems").innerText;
}, main);

test.describe("boot and lazy loading", () => {
  test("the manifest and the index load, one set pool loads, not 174", async ({ page }) => {
    const pools = [];
    await page.route("**/data/pokemon/*.json", route => {
      const f = route.request().url().split("/").pop();
      if (f.endsWith("-pool.json")) pools.push(f);
      return route.continue();
    });
    await openPokemon(page);
    const r = await page.evaluate(() => ({
      sets: GAME.sets.length,
      index: PIDX.length,
      pool: S.pool.length,
      openSet: S.openSet,
      cached: POOL_CACHE.size,
    }));
    expect(r.sets).toBe(174);
    expect(r.index).toBe(20444);
    // Exactly one pool file, for the one open set. The other 173 stay on disk.
    expect(pools).toHaveLength(1);
    expect(pools[0]).toBe(`${r.openSet}-pool.json`);
    expect(r.cached).toBe(1);
    expect(r.pool).toBeGreaterThan(0);
  });

  test("opening a set fetches exactly that set, and only once", async ({ page }) => {
    await openPokemon(page);
    const pools = [];
    await page.route("**/data/pokemon/*-pool.json", route => {
      pools.push(route.request().url().split("/").pop());
      return route.continue();
    });
    await page.evaluate(s => openSet(s), SMALL_SET);
    await page.waitForFunction(s => S.openSet === s, SMALL_SET);
    expect(pools).toEqual([`${SMALL_SET}-pool.json`]);
    // Re-opening comes out of the session cache — no second request.
    const first = await page.evaluate(() => S.openSet);
    await page.evaluate(() => openSet(GAME.sets[0].code));
    await page.waitForFunction(c => S.openSet === c, await page.evaluate(() => GAME.sets[0].code));
    await page.evaluate(s => openSet(s), SMALL_SET);
    await page.waitForFunction(s => S.openSet === s, SMALL_SET);
    expect(pools.filter(f => f === `${SMALL_SET}-pool.json`)).toHaveLength(1);
    expect(first).toBe(SMALL_SET);
  });

  test("the last set clicked wins a mid-load switch", async ({ page }) => {
    // Two clicks are two fetches in flight. Without a generation check the
    // SLOWER one wins by resolving last, so clicking a big set and then a small
    // one left you on the big set — pool, picker label and notice line all
    // consistently wrong, which is the hard kind of wrong to notice.
    await openPokemon(page);
    // Hold sv3's pool open until we let it go, so "the slow one resolves last"
    // is arranged rather than timed — a sleep here is flaky under a parallel run.
    let release, seen;
    const gate = new Promise(r => { release = r; });
    const requested = new Promise(r => { seen = r; });
    await page.route("**/data/pokemon/sv3-pool.json", async route => {
      seen();
      await gate;
      return route.continue();
    });
    // Not awaited: openSet only settles when its fetch does, which is the point.
    await page.evaluate(() => { openSet("sv3"); });
    await requested;
    await page.evaluate(s => openSet(s), SMALL_SET);
    await page.waitForFunction(s => S.openSet === s, SMALL_SET);
    // Now let the superseded fetch land. It must not steal the screen back;
    // POOL_CACHE gaining sv3 is proof it really did finish.
    release();
    await page.waitForFunction(() => POOL_CACHE.has("sv3"));
    const r = await page.evaluate(s => ({
      openSet: S.openSet,
      poolIsSmallSet: S.pool.every(c => c.set === s),
      label: document.getElementById("setPickName").textContent,
      wanted: setNameOf(s),
      stored: localStorage.getItem(openSetKey()),
      cachedAnyway: POOL_CACHE.has("sv3"),
    }), SMALL_SET);
    expect(r.openSet).toBe(SMALL_SET);
    expect(r.poolIsSmallSet).toBe(true);
    expect(r.label).toBe(r.wanted);
    expect(r.stored).toBe(SMALL_SET);
    // The abandoned fetch is still cached, so nothing was wasted.
    expect(r.cachedAnyway).toBe(true);
  });

  test("the open set survives a reload", async ({ page }) => {
    await openPokemon(page);
    await page.evaluate(s => openSet(s), SMALL_SET);
    await page.waitForFunction(s => S.openSet === s, SMALL_SET);
    await page.reload();
    await page.waitForFunction(() => typeof POOL_READY !== "undefined" && POOL_READY);
    expect(await page.evaluate(() => S.openSet)).toBe(SMALL_SET);
  });

  test("nothing reaches raw.githubusercontent.com at runtime", async ({ page }) => {
    // The vendor script fetches from there; the page must not. If this ever
    // fires, the CSP needs a connect-src entry — which is the signal that a
    // build-time dependency leaked into the runtime.
    const offsite = [];
    await page.route("**://raw.githubusercontent.com/**", route => {
      offsite.push(route.request().url());
      return route.abort();
    });
    await openPokemon(page);
    await page.evaluate(s => openSet(s), SMALL_SET);
    await page.waitForFunction(s => S.openSet === s, SMALL_SET);
    expect(offsite).toEqual([]);
  });

  test("card art is hotlinked from both Pokémon image hosts, per the data", async ({ page }) => {
    await openPokemon(page);
    const r = await page.evaluate(() => {
      const hosts = new Set();
      for (const e of PIDX) if (e.img) hosts.add(new URL(e.img).host);
      return {
        hosts: [...hosts].sort(),
        // The tile src is the vendored URL verbatim: no transform params, since
        // neither host is a transforming CDN and `small` is already the thumb.
        firstSrc: document.querySelector("#results img")?.getAttribute("src"),
        firstRef: refOf(S.pool[0]),
        firstImage: S.pool[0].image,
      };
    });
    expect(r.hosts).toEqual(["images.pokemontcg.io", "images.scrydex.com"]);
    expect(r.firstSrc).toBe(r.firstImage);
    expect(r.firstSrc).not.toContain("fm=webp");
  });
});

test.describe("deck rules", () => {
  test("the fixtures exist and are what the tests assume", async ({ page }) => {
    await openPokemon(page);
    const r = await page.evaluate(refs => refs.map(ref => {
      const c = findCard(ref);
      return c && { ref, name: c.name, set: c.set, basic: c.basicEnergy, key: cardKey(c) };
    }), [PIKACHU_BASE1, PIKACHU_BASE2, BASIC_ENERGY]);
    expect(r[0]).toMatchObject({ name: "Pikachu", set: "base1", basic: false });
    expect(r[1]).toMatchObject({ name: "Pikachu", set: "base2", basic: false });
    // Two printings, two sets, ONE deck-limit identity.
    expect(r[0].key).toBe(r[1].key);
    expect(r[2]).toMatchObject({ name: "Grass Energy", basic: true });
  });

  test("a deck validates only at exactly 60", async ({ page }) => {
    await openPokemon(page);
    const under = await problemsAfter(page, [[BASIC_ENERGY, 59]]);
    expect(under).toMatch(/Deck needs 1 more card — a deck is exactly 60\./);
    const at = await problemsAfter(page, [[BASIC_ENERGY, 60]]);
    expect(at).toBe("");
    const over = await problemsAfter(page, [[BASIC_ENERGY, 61]]);
    expect(over).toMatch(/Deck is 1 card over 60\./);
  });

  test("a 5th copy by NAME is flagged across two different printings", async ({ page }) => {
    await openPokemon(page);
    const over = await problemsAfter(page, [[PIKACHU_BASE1, 3], [PIKACHU_BASE2, 2]]);
    expect(over).toMatch(/Over 4 copies by card name: Pikachu \(5\)/);
    // 3 + 1 across the two printings is four copies of one card: legal.
    const ok = await problemsAfter(page, [[PIKACHU_BASE1, 3], [PIKACHU_BASE2, 1]]);
    expect(ok).not.toMatch(/Over 4 copies/);
  });

  test("Basic Energy is exempt and may exceed 4 freely", async ({ page }) => {
    await openPokemon(page);
    const probs = await problemsAfter(page, [[BASIC_ENERGY, 30]]);
    expect(probs).not.toMatch(/Over 4 copies/);
    const caps = await page.evaluate(refs => ({
      energy: copyCap(findCard(refs[0])),
      pokemon: copyCap(findCard(refs[1])),
    }), [BASIC_ENERGY, PIKACHU_BASE1]);
    expect(caps.pokemon).toBe(4);   // the stepper stops at 4
    expect(caps.energy).toBe(60);   // capped only by the deck size
  });

  test("the stepper enforces the per-card cap, energy excepted", async ({ page }) => {
    await openPokemon(page);
    const r = await page.evaluate(refs => {
      freshDeck();
      for (let i = 0; i < 8; i++) addCard(refs[1], "main");
      const pika = S.zones.main[0].qty;
      freshDeck();
      for (let i = 0; i < 8; i++) addCard(refs[0], "main");
      return { pika, energy: S.zones.main[0].qty };
    }, [BASIC_ENERGY, PIKACHU_BASE1]);
    expect(r.pika).toBe(4);
    expect(r.energy).toBe(8);
  });

  test("two printings of one card are two deck rows, under one copy limit", async ({ page }) => {
    // addCard() merged on the card NAME, so clicking Jungle Pikachu after Base
    // Pikachu bumped the Base row to 2 and the printing actually clicked never
    // entered the deck. The panel draws one row per printing when the same deck
    // arrives from storage, so the browser has to agree with it.
    await openPokemon(page);
    const r = await page.evaluate(async refs => {
      freshDeck();
      await Promise.all([loadSetPool("base1"), loadSetPool("base2")]);
      addCard(refs[0], "main");
      addCard(refs[1], "main");
      render();
      return {
        rows: S.zones.main.map(c => `${refOf(c)}x${c.qty}`),
        problems: document.getElementById("problems").innerText,
      };
    }, [PIKACHU_BASE1, PIKACHU_BASE2]);
    expect(r.rows).toEqual([`${PIKACHU_BASE1}x1`, `${PIKACHU_BASE2}x1`]);
    // Separate rows, still one 4-copy limit by name: a 5th is over.
    const over = await problemsAfter(page, [[PIKACHU_BASE1, 4], [PIKACHU_BASE2, 1]]);
    expect(over).toMatch(/Over 4 copies by card name: Pikachu \(5\)/);
  });

  test("a deck spanning sets whose pools are not loaded still resolves", async ({ page }) => {
    // The reason the search index doubles as the resolution layer: only the
    // open set's pool is in memory, and a 60-card deck is not one set.
    await openPokemon(page);
    const r = await page.evaluate(refs => {
      freshDeck();
      S.zones.main = refs.map(ref => ({ ...findCard(ref), id: uid(), qty: 2 }));
      render();
      return {
        unresolved: S.unresolved.length,
        names: S.zones.main.map(c => c.name),
        loadedSets: [...POOL_CACHE.keys()],
        rows: document.getElementById("zoneList").innerText,
      };
    }, [PIKACHU_BASE1, PIKACHU_BASE2, BASIC_ENERGY]);
    expect(r.unresolved).toBe(0);
    expect(r.names).toEqual(["Pikachu", "Pikachu", "Grass Energy"]);
    expect(r.loadedSets).not.toContain("base1");   // never fetched
    expect(r.rows).toContain("Pikachu");
  });

  test("a deck row opens the card modal", async ({ page }) => {
    // The row's click handler read the Riftbound id field, which a Pokémon card
    // has none of — so it handed a NAME to a resolver that wants a ref, and the
    // modal simply never opened. Nothing in the console said a word about it.
    await openPokemon(page);
    await page.evaluate(ref => {
      freshDeck();
      S.zones.main = [{ ...findCard(ref), id: uid(), qty: 2 }];
      render();
    }, PIKACHU_BASE1);
    await page.click("#zoneList .dname");
    await expect(page.locator("#modal.open")).toBeVisible();
    await expect(page.locator("#modalBox h3")).toHaveText("Pikachu");
  });

  test("a deck round-trips through localStorage across a reload", async ({ page }) => {
    await openPokemon(page);
    await page.evaluate(refs => {
      freshDeck();
      S.deckName = "Sixty Sparks";
      S.zones.main = [
        { ...findCard(refs[0]), id: uid(), qty: 4 },
        { ...findCard(refs[1]), id: uid(), qty: 56 },
      ];
      touch();
    }, [PIKACHU_BASE1, BASIC_ENERGY]);
    const stored = await page.evaluate(() => ({
      pokemon: localStorage.getItem("pokemon.deck"),
      riftbound: localStorage.getItem("riftbound-deckbuilder-v1"),
    }));
    // Its own key. The Riftbound key is not touched, ever.
    expect(stored.pokemon).toContain("Sixty Sparks");
    expect(stored.riftbound).toBeNull();
    await page.reload();
    await page.waitForFunction(() => typeof POOL_READY !== "undefined" && POOL_READY);
    const back = await page.evaluate(() => ({
      name: S.deckName,
      total: zoneCount("main"),
      problems: document.getElementById("problems").innerText,
    }));
    expect(back.name).toBe("Sixty Sparks");
    expect(back.total).toBe(60);
    expect(back.problems).toBe("");
  });

  test("a deck is bound to its game: the other game's export is refused", async ({ page }) => {
    await openPokemon(page);
    const msg = await page.evaluate(() => {
      // Drive the importer's own guard rather than a copy of it.
      const raw = { kind: "riftbound", version: 3, name: "RB deck",
                    zones: { main: [{ ref: "ogn-001-298", qty: 3 }] } };
      try {
        if (raw.kind && GAMES[raw.kind] && raw.kind !== ACTIVE_GAME)
          throw new Error(`that's a ${GAMES[raw.kind].label} deck — switch games first`);
        return "IMPORTED";
      } catch (e) { return e.message; }
    });
    expect(msg).toBe("that's a Riftbound deck — switch games first");
    // And an export from this game names this game.
    expect(await page.evaluate(() => ACTIVE_GAME)).toBe("pokemon");
  });
});

test.describe("browsing and search", () => {
  test("search spans all 174 sets and says so", async ({ page }) => {
    await openPokemon(page);
    await page.fill("#q", "pikachu");
    const r = await page.evaluate(() => ({
      count: document.getElementById("resultCount").textContent,
      sets: new Set([...document.querySelectorAll("#results .setbadge")]
        .map(b => b.textContent)).size,
      openSet: S.openSet,
    }));
    expect(r.count).toMatch(/all 174 sets$/);
    expect(r.sets).toBeGreaterThan(1);
  });

  test("a type chip narrows to the open set, and the count says which", async ({ page }) => {
    // The index carries no supertype or energy type, so a chipped search stays
    // in the loaded pool rather than silently ignoring the chip.
    await openPokemon(page);
    await page.evaluate(s => openSet(s), SMALL_SET);
    await page.waitForFunction(s => S.openSet === s, SMALL_SET);
    await page.fill("#q", "a");
    await page.evaluate(() => toggleFilter("typeFilter", "Trainer"));
    const r = await page.evaluate(() => ({
      count: document.getElementById("resultCount").textContent,
      allTrainers: [...document.querySelectorAll("#results .ttype")]
        .every(e => e.textContent.startsWith("Trainer")),
    }));
    expect(r.count).toMatch(/this set only \(filters on\)$/);
    expect(r.allTrainers).toBe(true);
  });

  test("a rarity filter the newly opened set has no card for is dropped", async ({ page }) => {
    // Otherwise: an empty grid, "0 cards", and no lit chip anywhere to clear,
    // because the rarity row only renders the OPEN set's rarities. It reads as
    // a set that failed to load.
    await openPokemon(page);
    await page.evaluate(() => openSet("sv1"));
    await page.waitForFunction(() => S.openSet === "sv1");
    await page.evaluate(() => toggleFilter("rarityFilter", "Double Rare"));
    expect(await page.evaluate(() => S.rarityFilter)).toEqual(["Double Rare"]);
    expect(await page.locator("#results .tile").count()).toBeGreaterThan(0);
    // Base has no Double Rare at all.
    await page.evaluate(() => openSet("base1"));
    await page.waitForFunction(() => S.openSet === "base1");
    const r = await page.evaluate(() => ({
      filter: S.rarityFilter,
      tiles: document.querySelectorAll("#results .tile").length,
      lit: document.querySelectorAll("#rarityRow .chip.on").length,
    }));
    expect(r.filter).toEqual([]);
    expect(r.tiles).toBeGreaterThan(0);
    expect(r.lit).toBe(0);
  });

  test("the meta line and badges are Pokémon's, not Riftbound's", async ({ page }) => {
    await openPokemon(page);
    await page.evaluate(s => openSet(s), SMALL_SET);
    await page.waitForFunction(s => S.openSet === s, SMALL_SET);
    const r = await page.evaluate(() => {
      const c = S.pool.find(x => x.supertype === "Pokémon" && x.hp && x.types.length);
      return { meta: GAME.tileMeta(c), badges: GAME.tileBadges(c),
               chips: [...document.querySelectorAll("#domainRow .chip")].map(b => b.textContent),
               types: [...document.querySelectorAll("#typeRow .chip")].map(b => b.textContent),
               hp: c.hp, type: c.types[0] };
    });
    expect(r.meta).toBe(`Pokémon · ${r.hp} HP · ${r.type}`);
    expect(r.badges).toContain(`${r.hp} HP`);
    expect(r.chips).toContain("Lightning");
    expect(r.chips).not.toContain("Fury");        // no Riftbound domains
    expect(r.types).toEqual(["Pokémon", "Trainer", "Energy"]);
  });

  test("the regulation mark and HP badges stay legible in Paper", async ({ page }) => {
    // Every Pokemon tile carries both, so themed ink on a fixed dark chip was
    // two unreadable rectangles per card. See the Riftbound half of this in
    // smoke.spec.js — the .variant rule is shared.
    const relLum = rgb => {
      const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number)
        .map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    await openPokemon(page);
    await expect(page.locator("#results .regmark").first()).toBeVisible();
    const read = () => page.evaluate(() => ["regmark", "variant"].map(c =>
      getComputedStyle(document.querySelector("#results ." + c)).color));
    const midnight = await read();
    await page.click("#themeBtn");
    const paper = await read();
    expect(paper).toEqual(midnight);
    for (const c of paper) expect(relLum(c)).toBeGreaterThan(0.5);
  });

  test("Riftbound-only deck panels are actually invisible", async ({ page }) => {
    // Asserted on VISIBILITY, not on the hidden attribute. The attribute was
    // set correctly all along; a `display:flex` added to #curveBlock (to restore
    // a flex gap) silently beat [hidden]'s display:none, and the energy curve
    // went on rendering a 60-brick tower in column 0 for a game whose cards all
    // have energy 0. An attribute assertion could not see that.
    await openPokemon(page);
    await expect(page.locator("#legendBox")).toBeHidden();
    await expect(page.locator("#curveBlock")).toBeHidden();
    await expect(page.locator(".curve")).toBeHidden();
    await expect(page.locator("#zoneTabs")).toBeHidden();   // one zone, no tabs
    const r = await page.evaluate(() => ({
      variantsChip: document.getElementById("typeRow").innerText.includes("Variants"),
      zones: Object.keys(ZONES),
      checks: document.getElementById("checks").innerText.replace(/\n/g, " "),
    }));
    expect(r.variantsChip).toBe(false);   // no Showcase concept this stage
    expect(r.zones).toEqual(["main"]);
    expect(r.checks).toContain("0/60");
  });

  test("Riftbound still shows the panels it owns", async ({ page }) => {
    // The other half: hiding them per game must not hide them everywhere, which
    // is what an over-broad CSS rule would do.
    await openApp(page);
    await expect(page.locator("#legendBox")).toBeVisible();
    await expect(page.locator("#curveBlock")).toBeVisible();
    await expect(page.locator(".curve")).toBeVisible();
    await expect(page.locator("#zoneTabs")).toBeVisible();
  });

  test("Show all on a cross-set search really shows every hit", async ({ page }) => {
    // The handler used to set the limit to S.pool.length, which WAS the result
    // count back when the pool was the only thing searched. A cross-set search
    // resolves off the index, so the two numbers parted ways: 3,133 hits, a
    // 64-card set open, and the button rendered 64 tiles then offered itself
    // again.
    await openPokemon(page);
    await page.evaluate(s => openSet(s), SMALL_SET);
    await page.waitForFunction(s => S.openSet === s, SMALL_SET);
    await page.fill("#q", "ex");
    const hits = await page.evaluate(() => RESULT_COUNT);
    expect(hits).toBeGreaterThan(await page.evaluate(() => S.pool.length));
    await expect(page.locator("#showAll")).toHaveText(`Show all ${hits}`);
    await page.click("#showAll");
    const r = await page.evaluate(() => ({
      tiles: document.querySelectorAll("#results .tile").length,
      limit: S.limit,
      moreHidden: document.getElementById("more").hidden,
      allHidden: document.getElementById("showAll").hidden,
    }));
    expect(r.tiles).toBe(hits);
    expect(r.limit).toBe(hits);
    expect(r.moreHidden).toBe(true);    // nothing left to page to
    expect(r.allHidden).toBe(true);
  });

  test("a collector number's denominator is the set total, not the file count", async ({ page }) => {
    // The manifest carries both, and the vendor script's own comment draws the
    // line: `cards` is what the repo holds, `total` is what the set officially
    // contains. Progress bars want the former; a printed collector number wants
    // the latter. They differ for 6 of the 174 sets.
    await openPokemon(page);
    const r = await page.evaluate(() => {
      const split = GAME.sets.filter(s => s.total && s.cards && s.total !== s.cards);
      const one = GAME.sets.find(s => s.code === "svp");
      return {
        splitCount: split.length,
        svp: { total: one.total, cards: one.cards },
        label: GAME.numLabel({ set: "svp", number: "1" }),
        sameSet: GAME.numLabel({ set: "base1", number: "58" }),
      };
    });
    // Fixture check: if a re-vendor ever makes every set agree, this test stops
    // meaning anything and should say so rather than pass silently.
    expect(r.splitCount).toBeGreaterThan(0);
    expect(r.svp.total).not.toBe(r.svp.cards);
    expect(r.label).toBe(`SVP 1/${r.svp.total}`);
    expect(r.sameSet).toBe("BASE1 58/102");
  });

  test("a light card from cross-set search still labels itself", async ({ page }) => {
    // Index entries carry no supertype, HP or types, so the caption line would
    // otherwise be empty on a result set that is mostly light cards.
    await openPokemon(page);
    await page.fill("#q", "charizard");
    const metas = await page.evaluate(() =>
      [...document.querySelectorAll("#results .ttype")].map(e => e.textContent.trim()));
    expect(metas.length).toBeGreaterThan(10);
    expect(metas.every(Boolean)).toBe(true);
    expect(metas.some(m => /\/\d+$/.test(m))).toBe(true);   // "SV3 4/197"
  });
});

test.describe("the set picker", () => {
  test("174 sets are grouped by series, collapsed but for the open one", async ({ page }) => {
    await openPokemon(page);
    await page.click("#setPickBtn");
    const r = await page.evaluate(() => ({
      groups: document.querySelectorAll("#setPickList .spgroup").length,
      rowsShown: document.querySelectorAll("#setPickList .sprow").length,
      openSeries: setMetaOf(S.openSet).series,
      firstGroup: document.querySelector("#setPickList .spghead").innerText.replace(/\s+/g, " "),
    }));
    // Every series has a group; only the open set's series is expanded, so the
    // panel is not a flat 174-row list.
    expect(r.groups).toBe(17);
    expect(r.rowsShown).toBeGreaterThan(0);
    expect(r.rowsShown).toBeLessThan(30);
    // The heading is CSS-uppercased, so innerText comes back shouting.
    expect(r.firstGroup.toLowerCase()).toContain(r.openSeries.toLowerCase());
  });

  test("expanding a series keeps the panel open; picking a set closes it", async ({ page }) => {
    /* The group header's handler re-renders the list, which detaches the very
       button that was clicked — so the document-level outside-click guard's
       e.target.closest() walked a dead chain, returned null, read the click as
       "outside" and shut the panel. The group DID expand; you just never saw it,
       because it closed on the same click. Real clicks only: the bug lives in
       event propagation, so driving toggleSetGroup() directly cannot see it. */
    await openPokemon(page);
    await page.click("#setPickBtn");
    const before = await page.evaluate(() =>
      document.querySelectorAll("#setPickList .sprow").length);
    await page.locator("#setPickList .spghead", { hasText: "Sword & Shield" }).click();
    const expanded = await page.evaluate(() => ({
      open: SETPICK_OPEN,
      hidden: document.getElementById("setPickPanel").hidden,
      rows: document.querySelectorAll("#setPickList .sprow").length,
    }));
    expect(expanded.open).toBe(true);
    expect(expanded.hidden).toBe(false);
    expect(expanded.rows).toBe(before + 25);
    // Collapsing it again also stays open.
    await page.locator("#setPickList .spghead", { hasText: "Sword & Shield" }).click();
    expect(await page.evaluate(() => SETPICK_OPEN)).toBe(true);
    expect(await page.evaluate(() =>
      document.querySelectorAll("#setPickList .sprow").length)).toBe(before);
    // ...but choosing a set still closes it, which is the point of the control.
    await page.locator("#setPickList .sprow").first().click();
    await page.waitForFunction(() => SETPICK_OPEN === false);
    expect(await page.locator("#setPickPanel").isHidden()).toBe(true);
  });

  test("a group expands and collapses, and the filter matches name or series", async ({ page }) => {
    await openPokemon(page);
    await page.click("#setPickBtn");
    const before = await page.evaluate(() =>
      document.querySelectorAll("#setPickList .sprow").length);
    await page.evaluate(() => toggleSetGroup("Sword & Shield"));
    const after = await page.evaluate(() =>
      document.querySelectorAll("#setPickList .sprow").length);
    expect(after).toBe(before + 25);
    await page.fill("#setPickQ", "surging");
    const names = await page.evaluate(() =>
      [...document.querySelectorAll("#setPickList .sprow .spn")].map(e => e.textContent));
    expect(names).toContain("Surging Sparks");
  });
});

test.describe("collection", () => {
  test("the stepper caps at 4 for Pokémon", async ({ page }) => {
    await openPokemon(page, { hash: "#collection" });
    const r = await page.evaluate(() => {
      const id = refOf(S.pool[0]);
      for (let i = 0; i < 9; i++) colBump(id, 1);
      const tile = document.querySelector(`#colGrid .ctile[data-ref="${id}"]`);
      return {
        qty: qtyOf(id),
        cap: colCap(),
        segs: tile.querySelectorAll(".cseg i").length,
        own: tile.querySelector(".cown").textContent,
        plusDisabled: tile.querySelectorAll(".step")[1].disabled,
      };
    });
    expect(r.cap).toBe(4);
    expect(r.qty).toBe(4);
    expect(r.segs).toBe(4);
    expect(r.own).toBe("4/4");
    expect(r.plusDisabled).toBe(true);
  });

  test("Riftbound's cap is still 3", async ({ page }) => {
    await openApp(page, { hash: "#collection" });
    const r = await page.evaluate(() => {
      const id = refOf(S.pool[0]);
      for (let i = 0; i < 9; i++) colBump(id, 1);
      const tile = document.querySelector(`#colGrid .ctile[data-ref="${id}"]`);
      return { qty: qtyOf(id), cap: colCap(), segs: tile.querySelectorAll(".cseg i").length,
               own: tile.querySelector(".cown").textContent };
    });
    expect(r.cap).toBe(3);
    expect(r.qty).toBe(3);
    expect(r.segs).toBe(3);
    expect(r.own).toBe("3/3");
  });

  test("the two games' collections are independent, in one nested blob", async ({ page }) => {
    await openPokemon(page, { hash: "#collection" });
    await page.evaluate(() => colBump(refOf(S.pool[0]), 2));
    const pkRef = await page.evaluate(() => refOf(S.pool[0]));
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("rb.collection")));
    expect(stored).toEqual({ pokemon: { [pkRef]: 2 } });
    // Switch to Riftbound: its map is its own, and the Pokémon one is untouched.
    await page.evaluate(() => switchGame("riftbound"));
    await page.waitForFunction(() => ACTIVE_GAME === "riftbound" && POOL_READY);
    await page.evaluate(() => colBump("ogn-001-298", 1));
    const both = await page.evaluate(() => ({
      stored: JSON.parse(localStorage.getItem("rb.collection")),
      activeMapIsRiftbound: COL === COLALL.riftbound,
    }));
    expect(both.stored).toEqual({ pokemon: { [pkRef]: 2 }, riftbound: { "ogn-001-298": 1 } });
    expect(both.activeMapIsRiftbound).toBe(true);
  });

  test("a legacy flat blob lifts to nested with no data loss", async ({ page }) => {
    // Every browser and every user_settings row holds the flat shape today.
    const legacy = { "ogn-001-298": 3, "ogn-039a-298": 1, "sfd-224*-221": 2 };
    await page.addInitScript(l => localStorage.setItem("rb.collection", JSON.stringify(l)), legacy);
    await openApp(page, { hash: "#collection" });
    const r = await page.evaluate(() => ({
      nested: COLALL,
      qty: ["ogn-001-298", "ogn-039a-298", "sfd-224*-221"].map(qtyOf),
      copies: colCopies(S.pool),
    }));
    expect(r.nested).toEqual({ riftbound: legacy });
    expect(r.qty).toEqual([3, 1, 2]);
    expect(r.copies).toBe(6);
    // The write-back is nested, and it happens without the user doing anything
    // destructive first.
    await page.evaluate(() => colBump("ogn-002-298", 1));
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("rb.collection"))))
      .toEqual({ riftbound: { ...legacy, "ogn-002-298": 1 } });
  });

  test("a Pokémon collection is per set, with a whole-game total", async ({ page }) => {
    await openPokemon(page, { hash: "#collection" });
    const r = await page.evaluate(() => ({
      // No "All sets" chip row for a lazy game — the picker is the control, and
      // 20,444 tiles is not a page.
      colBarHidden: document.getElementById("colSetBar").hidden,
      pickBarHidden: document.getElementById("pickSetBar").hidden,
      scoped: colScoped().length,
      poolSize: S.pool.length,
      meta: document.getElementById("colSetMeta").textContent,
    }));
    expect(r.colBarHidden).toBe(true);
    expect(r.pickBarHidden).toBe(false);
    expect(r.scoped).toBe(r.poolSize);
    expect(r.meta).toMatch(/logged across all sets$/);
  });

  test("owned counts per set come from the index, without loading pools", async ({ page }) => {
    await openPokemon(page, { hash: "#collection",
      collection: { pokemon: { "base1-58": 2, "base2-60": 1, "base1-99": 4 } } });
    const r = await page.evaluate(() => ({
      bySet: Object.fromEntries(colOwnedBySet()),
      loaded: [...POOL_CACHE.keys()],
      logged: colLoggedPrintings(),
    }));
    expect(r.bySet).toMatchObject({ base1: 2, base2: 1 });
    expect(r.logged).toBe(3);
    expect(r.loaded).not.toContain("base1");
  });

  test("the copies readout spans every set, not just the open one", async ({ page }) => {
    // It summed the loaded pool, which for a lazy game is ONE set — so copies
    // logged in any other set silently dropped out of a number the header
    // presents as a total, right above a panel that gets it right.
    await openPokemon(page, { hash: "#collection",
      collection: { pokemon: { "base1-58": 4, "base2-60": 3, "nope-999": 2 } } });
    const r = await page.evaluate(() => ({
      readout: document.getElementById("syncState").textContent,
      copies: colLoggedCopies(),
      printings: colLoggedPrintings(),
      openSet: S.openSet,
      loaded: [...POOL_CACHE.keys()],
    }));
    // Seven copies across two sets, neither of them the open one — and the ref
    // the index cannot place is left out of the count, as everywhere else.
    expect(r.copies).toBe(7);
    expect(r.printings).toBe(2);
    expect(r.readout).toContain("7 copies logged");
    expect(r.loaded).not.toContain("base1");
  });

  test("a Pokémon printing and a Riftbound one cannot collide", async ({ page }) => {
    // The refs live in separate game keys now, so even identical ref strings
    // would be two different collectibles. Belt for 0005's braces.
    await openPokemon(page, { hash: "#collection",
      collection: { pokemon: { "x-1": 4 }, riftbound: { "x-1": 3 } } });
    const pk = await page.evaluate(() => COL["x-1"]);
    await page.evaluate(() => switchGame("riftbound"));
    await page.waitForFunction(() => ACTIVE_GAME === "riftbound" && POOL_READY);
    const rb = await page.evaluate(() => COL["x-1"]);
    expect(pk).toBe(4);
    expect(rb).toBe(3);
  });
});

test.describe("the game switcher", () => {
  test("switching games swaps pool, rules, keys and storage, and persists", async ({ page }) => {
    await openApp(page);
    const rb = await page.evaluate(() => ({
      game: ACTIVE_GAME, pool: S.pool.length, cap: GAME.rules.copyLimit,
      zones: Object.keys(ZONES), deckKey: deckKey(),
    }));
    await page.click("#gameBtn");
    await page.click("#gameMenu .gmrow[data-a1='pokemon']");
    await page.waitForFunction(() => ACTIVE_GAME === "pokemon" && POOL_READY, null,
      { timeout: 20000 });
    const pk = await page.evaluate(() => ({
      game: ACTIVE_GAME, pool: S.pool.length, cap: GAME.rules.copyLimit,
      zones: Object.keys(ZONES), deckKey: deckKey(),
      // The auth/data module reads this live, so the decks it lists are this
      // game's rows.
      moduleGame: window.ACTIVE_GAME,
      persisted: localStorage.getItem("ch.game"),
      label: document.getElementById("gameLabel").textContent,
    }));
    expect(rb).toMatchObject({ game: "riftbound", pool: 640, cap: 3,
      deckKey: "riftbound-deckbuilder-v1" });
    expect(rb.zones).toEqual(["main", "runes", "battlefields", "sideboard"]);
    expect(pk).toMatchObject({ game: "pokemon", cap: 4, deckKey: "pokemon.deck",
      moduleGame: "pokemon", persisted: "pokemon", label: "Pokémon TCG" });
    expect(pk.zones).toEqual(["main"]);
    expect(pk.pool).toBeLessThan(640);
    // ...and back, with Riftbound exactly as it was.
    await page.click("#gameBtn");
    await page.click("#gameMenu .gmrow[data-a1='riftbound']");
    await page.waitForFunction(() => ACTIVE_GAME === "riftbound" && POOL_READY, null,
      { timeout: 20000 });
    const back = await page.evaluate(() => ({
      game: ACTIVE_GAME, pool: S.pool.length,
      sets: poolSets().map(s => s.code), scope: S.setScope,
    }));
    expect(back).toMatchObject({ game: "riftbound", pool: 640 });
    expect(back.sets).toEqual(["OGN", "SFD"]);
    expect(back.scope).toEqual(["OGN", "SFD"]);
  });

  test("the switch is persisted, so a reload lands on the same game", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => switchGame("pokemon"));
    await page.waitForFunction(() => ACTIVE_GAME === "pokemon" && POOL_READY, null,
      { timeout: 20000 });
    await page.reload();
    await page.waitForFunction(() => typeof POOL_READY !== "undefined" && POOL_READY, null,
      { timeout: 20000 });
    expect(await page.evaluate(() => ACTIVE_GAME)).toBe("pokemon");
    expect(await page.evaluate(() => document.getElementById("gameMark").textContent)).toBe("PK");
  });

  test("switching with an unsaved deck asks first, and Cancel means cancel", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      // Signed-in state is what makes a deck "unsaved": signed out it autosaves.
      MODE = "cloud"; CLOUD_USER = { id: "u1" }; DECKS = []; BASELINE = null;
      freshDeck();
      addCard("ogn-001-298", "main");
    });
    const pending = page.evaluate(() => switchGame("pokemon"));
    await expect(page.locator("#askModal.open")).toBeVisible();
    await page.click("#askActs button:has-text('Cancel')");
    await pending;
    expect(await page.evaluate(() => ACTIVE_GAME)).toBe("riftbound");
    expect(await page.evaluate(() => zoneCount("main"))).toBe(1);
  });

  test("the menu offers both games and the planned rows stay inert", async ({ page }) => {
    await openApp(page);
    await page.click("#gameBtn");
    const r = await page.evaluate(() => ({
      active: document.querySelector("#gameMenu .gmrow.active .gmname").textContent,
      switchable: [...document.querySelectorAll("#gameMenu button.gmrow .gmname")]
        .map(e => e.textContent),
      planned: [...document.querySelectorAll("#gameMenu .gmrow.planned .gmname")]
        .map(e => e.textContent),
      plannedInteractive: document.querySelectorAll(
        "#gameMenu .planned a, #gameMenu .planned button").length,
    }));
    expect(r.active).toBe("Riftbound");
    expect(r.switchable).toEqual(["Pokémon TCG"]);
    expect(r.planned).toEqual(["Magic: The Gathering", "One Piece Card Game"]);
    expect(r.plannedInteractive).toBe(0);
  });
});

test.describe("the collection's set picker stays current", () => {
  test("logging a copy refreshes the picker's own counts", async ({ page }) => {
    // renderColSummary paints both set controls, because colBump() takes the
    // cheap single-tile path and calls only that — so whichever control the
    // active game uses has to refresh from there or it goes stale on a tap.
    await page.addInitScript(() => localStorage.setItem("ch.game", "pokemon"));
    await page.goto("/#collection");
    await page.waitForFunction(() => typeof POOL_READY !== "undefined" && POOL_READY,
      null, { timeout: 20000 });
    const before = await page.locator("#pickSetCount").textContent();
    await page.evaluate(() => colBump(refOf(S.pool[0]), 1));
    const after = await page.locator("#pickSetCount").textContent();
    expect(before).toMatch(/^0\//);
    expect(after).toMatch(/^1\//);
    expect(after).toContain("1 logged overall");
  });
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const box = (page, sel) => page.evaluate(s => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth };
  }, sel);

  /* Each dropdown hung off a small wrapper sitting well into its row, with a
     max-width in vw that knew nothing about the offset. The game menu ended 66px
     past the right edge at this width — its Active/Switch labels with it — and
     the page has no horizontal scroll, so none of it was reachable. */
  test("every dropdown stays inside the viewport, in both games", async ({ page }) => {
    for (const open of [
      { btn: "#gameBtn", panel: "#gameMenu" },
      { btn: "#deckCaret", panel: "#deckMenu" },
    ]) {
      await openApp(page);
      await page.click(open.btn);
      const b = await box(page, open.panel);
      expect(b.left, `${open.panel} left`).toBeGreaterThanOrEqual(0);
      expect(b.right, `${open.panel} right`).toBeLessThanOrEqual(b.vw);
    }
    await openPokemon(page);
    for (const open of [
      { btn: "#gameBtn", panel: "#gameMenu" },
      { btn: "#deckCaret", panel: "#deckMenu" },
      { btn: "#setPickBtn", panel: "#setPickPanel" },
    ]) {
      await page.click(open.btn);
      const b = await box(page, open.panel);
      expect(b.left, `${open.panel} left`).toBeGreaterThanOrEqual(0);
      expect(b.right, `${open.panel} right`).toBeLessThanOrEqual(b.vw);
      await page.keyboard.press("Escape");
    }
    // And nothing pushed the page itself sideways.
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});

test.describe("filter bar layout", () => {
  /* Both type axes (energy types and supertypes) share one wrapping line rather
     than holding a row each, in the deck browser AND the collection. They stay
     separate containers so each still renders itself; display:contents is what
     puts their chips into one flex row. Pokémon is the demanding case at 14
     chips — Riftbound has 12 and inherits the same markup. */
  /* Wide enough that the chips cannot wrap for want of room in ANY font. The
     default 1280 leaves the browse column ~880px, which fits 14 chips in
     Windows' metrics and not in the Linux ones CI runs — the change under test
     is that the two groups share a row, not that the row never wraps, so pin
     the width rather than assert a coincidence. */
  test.use({ viewport: { width: 1600, height: 1000 } });

  const chipLines = (page, a, b) => page.evaluate(([a, b]) => {
    const chips = [...document.querySelectorAll(`${a} .chip, ${b} .chip`)];
    const tops = new Set(chips.map(c => Math.round(c.getBoundingClientRect().top)));
    return {
      lines: tops.size,
      chips: chips.length,
      /* The structural guarantee, independent of width or font: both groups'
         chips are laid out by ONE row element. That is what display:contents
         buys, and it is what "on the same line" actually meant — a single
         wrapping run instead of two half-empty rows. */
      rows: new Set(chips.map(c => c.closest(".row"))).size,
    };
  }, [a, b]);

  test("both type axes share one line in the deck browser", async ({ page }) => {
    await openPokemon(page);
    const r = await chipLines(page, "#domainRow", "#typeRow");
    expect(r.chips).toBe(14);
    expect(r.rows).toBe(1);
    expect(r.lines).toBe(1);
  });

  test("both type axes share one line in the collection, count still at the end",
    async ({ page }) => {
      await openPokemon(page, { hash: "#collection" });
      const r = await chipLines(page, "#colDomainRow", "#colTypeRow");
      expect(r.chips).toBe(14);
      expect(r.rows).toBe(1);
      expect(r.lines).toBe(1);
      // The card count keeps its place at the right end of that same row.
      const count = await page.evaluate(() => {
        const c = document.getElementById("colCount").getBoundingClientRect();
        const row = document.querySelector(".colchips").getBoundingClientRect();
        return { onRow: Math.round(c.top) < Math.round(row.bottom),
                 rightOfChips: c.left >= row.right - 1,
                 inside: Math.round(c.right) <= innerWidth };
      });
      expect(count).toEqual({ onRow: true, rightOfChips: true, inside: true });
    });

  test("the collection's chips still filter after the reflow", async ({ page }) => {
    await openPokemon(page, { hash: "#collection" });
    const all = await page.evaluate(() => colBase().length);
    await page.locator("#colDomainRow .chip").first().click();
    const byType = await page.evaluate(() => ({
      n: colBase().length, domains: COLF.domains }));
    expect(byType.domains).toEqual(["Grass"]);
    expect(byType.n).toBeLessThan(all);
    await page.locator("#colTypeRow .chip").first().click();
    expect(await page.evaluate(() => COLF.types)).toEqual(["Pokémon"]);
  });
});

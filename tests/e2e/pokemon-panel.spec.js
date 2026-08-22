import { test, expect } from "@playwright/test";
import { openApp } from "./helpers.js";

/* Stage 10: the Pokémon deck panel — stats, the two single-card rules, the
   sectioned list, and the PTCGL decklist round trip.

   Every fixture is REAL vendored data and is asserted to be what the test
   assumes before it is used, so a re-vendor that moved one fails loudly here
   instead of quietly turning a test into a no-op.

   sv1's Scatterbug -> Spewpa -> Vivillon is a complete three-stage evolution
   line inside one set, which is what makes the indent testable without loading
   three pools. */
const MIRAIDON = "sv1-81";      // Basic, Lightning + Colorless attack costs
const SCATTER  = "sv1-8";       // Basic
const SPEWPA   = "sv1-9";       // Stage 1, evolves from Scatterbug
const VIVILLON = "sv1-10";      // Stage 2, evolves from Spewpa
const MEW_EX   = "sv3pt5-151";  // Colorless-cost attacker only
const ACE_A    = "sv8-162";     // ACE SPEC
const ACE_B    = "sv8-164";     // a DIFFERENT ACE SPEC
const ULTRA    = "sv1-196";     // Trainer, Item
const RESEARCH = "sv1-189";     // Trainer, Supporter
const L_ENERGY = "sv1-257";     // Basic Lightning Energy
const W_ENERGY = "sv2-279";     // Basic Water Energy
const SPECIAL  = "sv4-266";     // Reversal Energy (Special)

async function openPokemon(page) {
  await page.addInitScript(() => localStorage.setItem("ch.game", "pokemon"));
  await openApp(page);
  await page.waitForFunction(() => PIDX !== null);
}

/* Build a deck from refs, with every set involved loaded first so the panel is
   looking at full detail rather than light cards. */
async function build(page, refs) {
  await page.evaluate(async (refs) => {
    freshDeck();
    const sets = [...new Set(refs.map(([r]) => r.slice(0, r.lastIndexOf("-"))))];
    await Promise.all(sets.map((s) => loadSetPool(s)));
    S.zones.main = refs
      .map(([ref, qty]) => {
        const c = findCard(ref);
        return c ? { ...c, id: uid(), qty } : null;
      })
      .filter(Boolean);
    hydrateDeckDetail();
    render();
  }, refs);
  await page.waitForFunction(() => DECK_DETAIL_PENDING === 0);
}

test.describe("the fixtures are what these tests assume", () => {
  test("every card used below is the card it is named for", async ({ page }) => {
    await openPokemon(page);
    const got = await page.evaluate(async (refs) => {
      await Promise.all(["sv1", "sv2", "sv3pt5", "sv4", "sv8"].map((s) => loadSetPool(s)));
      return refs.map((ref) => {
        const c = findCard(ref);
        return c && {
          ref, name: c.name, supertype: c.supertype, subtypes: c.subtypes,
          costs: c.costs, evolvesFrom: c.evolvesFrom, energyType: c.energyType,
          basicPokemon: c.basicPokemon, specialEnergy: c.specialEnergy,
        };
      });
    }, [MIRAIDON, SCATTER, SPEWPA, VIVILLON, MEW_EX, ACE_A, ACE_B, ULTRA, RESEARCH,
        L_ENERGY, W_ENERGY, SPECIAL]);
    const by = Object.fromEntries(got.map((c) => [c.ref, c]));
    expect(by[MIRAIDON]).toMatchObject({ supertype: "Pokémon", basicPokemon: true });
    expect(by[MIRAIDON].costs).toContain("Lightning");
    expect(by[SPEWPA]).toMatchObject({ evolvesFrom: "Scatterbug" });
    expect(by[VIVILLON]).toMatchObject({ evolvesFrom: "Spewpa" });
    // The card the whole attack-cost decision rests on: it costs ONLY Colorless.
    expect(by[MEW_EX].costs).toEqual(["Colorless"]);
    expect(by[ACE_A].subtypes).toContain("ACE SPEC");
    expect(by[ACE_B].subtypes).toContain("ACE SPEC");
    expect(by[ACE_A].name).not.toBe(by[ACE_B].name);
    expect(by[ULTRA].subtypes).toContain("Item");
    expect(by[RESEARCH].subtypes).toContain("Supporter");
    expect(by[L_ENERGY]).toMatchObject({ energyType: "Lightning" });
    expect(by[W_ENERGY]).toMatchObject({ energyType: "Water" });
    expect(by[SPECIAL]).toMatchObject({ specialEnergy: true });
  });
});

test.describe("supertype counts and pills", () => {
  test("the bar splits the deck by supertype and the legend names all three",
    async ({ page }) => {
      await openPokemon(page);
      await build(page, [[MIRAIDON, 4], [SCATTER, 3], [ULTRA, 4], [RESEARCH, 2],
                         [L_ENERGY, 10]]);
      const r = await page.evaluate(() => ({
        segments: [...document.querySelectorAll(".dsbar i")].map((i) => i.textContent),
        legend: [...document.querySelectorAll(".dslegend span")].map((s) => s.textContent),
        pokemon: pkMainQty(pkOfSupertype("Pokémon")),
        trainer: pkMainQty(pkOfSupertype("Trainer")),
        energy: pkMainQty(pkOfSupertype("Energy")),
      }));
      expect(r).toMatchObject({ pokemon: 7, trainer: 6, energy: 10 });
      expect(r.segments).toEqual(["7", "6", "10"]);
      expect(r.legend).toEqual(["Pokémon", "Trainer", "Energy"]);
    });

  test("a zero-count supertype collapses out of the bar", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 4], [L_ENERGY, 10]]);   // no Trainers at all
    expect(await page.evaluate(() =>
      [...document.querySelectorAll(".dsbar i")].map((i) => i.textContent)))
      .toEqual(["4", "10"]);
  });

  test("the 60-card pill passes only at exactly 60", async ({ page }) => {
    await openPokemon(page);
    const pill = () => page.evaluate(() => {
      const p = document.querySelector(".dspill");
      return { text: p.textContent.trim(), ok: p.classList.contains("ok") };
    });
    await build(page, [[MIRAIDON, 4], [L_ENERGY, 55]]);   // 59
    expect(await pill()).toMatchObject({ ok: false });
    await build(page, [[MIRAIDON, 4], [L_ENERGY, 56]]);   // 60
    expect(await pill()).toMatchObject({ ok: true });
    await build(page, [[MIRAIDON, 4], [L_ENERGY, 57]]);   // 61
    expect(await pill()).toMatchObject({ ok: false });
  });

  test("the Basic Pokémon pill fails a deck with no Basics, and it is a banner too",
    async ({ page }) => {
      await openPokemon(page);
      // Spewpa and Vivillon are Stage 1 and Stage 2 — nothing to start a game with.
      await build(page, [[SPEWPA, 3], [VIVILLON, 2]]);
      const r = await page.evaluate(() => ({
        pills: [...document.querySelectorAll(".dspill")].map((p) =>
          `${p.textContent.trim()}:${p.classList.contains("ok") ? "ok" : "bad"}`),
        problems: document.getElementById("problems").innerText,
      }));
      expect(r.pills.some((p) => /Basic Pokémon:bad/.test(p))).toBe(true);
      expect(r.problems).toMatch(/No Basic Pokémon/);
      // ...and it passes once a Basic is in.
      await build(page, [[SPEWPA, 3], [SCATTER, 1]]);
      expect(await page.evaluate(() =>
        document.getElementById("problems").innerText)).not.toMatch(/No Basic Pokémon/);
    });

  test("the ACE SPEC pill appears only once the deck holds one", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 4]]);
    expect(await page.evaluate(() =>
      document.querySelector(".dspills").textContent)).not.toMatch(/ACE SPEC/);
    await build(page, [[MIRAIDON, 4], [ACE_A, 1]]);
    const r = await page.evaluate(() => {
      const p = [...document.querySelectorAll(".dspill")].find((x) => /ACE SPEC/.test(x.textContent));
      return { text: p.textContent.replace(/\s+/g, " ").trim(), ok: p.classList.contains("ok") };
    });
    expect(r.text).toMatch(/ACE SPEC 1\/1/);
    expect(r.ok).toBe(true);
  });
});

test.describe("mulligan maths", () => {
  /* Exact values, precomputed from C(60-b,7)/C(60,7) — the reference points the
     brief names. If the arithmetic ever drifts to floating-point factorials,
     these are the numbers that catch it. */
  const CASES = [[15, "11.8"], [12, "19.1"], [10, "25.9"]];

  for (const [basics, pct] of CASES) {
    test(`${basics} Basics in 60 is ${pct}%`, async ({ page }) => {
      await openPokemon(page);
      await build(page, [[MIRAIDON, basics], [L_ENERGY, 60 - basics]]);
      const r = await page.evaluate(() => ({
        b: pkMulligan().b, n: pkMulligan().n, pct: pkMulligan().pct,
        shown: document.querySelector(".dsmullhead").textContent.replace(/\s+/g, " ").trim(),
      }));
      expect(r).toMatchObject({ b: basics, n: 60 });
      expect(r.pct.toFixed(1)).toBe(pct);
      expect(r.shown).toContain(`${pct}%`);
      expect(r.shown).toContain(`Basics ${basics}`);
    });
  }

  test("C(n,k) is exact, not a float factorial", async ({ page }) => {
    await openPokemon(page);
    expect(await page.evaluate(() => [
      pkChoose(60, 7).toString(), pkChoose(45, 7).toString(),
      pkChoose(52, 5).toString(), pkChoose(200, 100).toString().length,
    ])).toEqual(["386206920", "45379620", "2598960", 59]);
  });

  test("it is computed against the deck's real size, not always 60", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 4], [L_ENERGY, 26]]);   // 30 cards, 4 Basics
    const r = await page.evaluate(() => pkMulligan());
    expect(r).toMatchObject({ b: 4, n: 30 });
    // C(26,7)/C(30,7) = 657800/2035800
    expect(r.pct.toFixed(1)).toBe("32.3");
  });

  test("an em dash below 7 cards and with no Basics at all", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 4]]);                  // 4 cards
    expect(await page.evaluate(() => pkMulligan().pct)).toBeNull();
    expect(await page.evaluate(() =>
      document.querySelector(".dsmullhead").textContent)).toContain("—");
    await build(page, [[L_ENERGY, 30]]);                 // 30 cards, zero Basics
    expect(await page.evaluate(() => pkMulligan().pct)).toBeNull();
  });
});

test.describe("Trainer subtype chips", () => {
  test("counts by subtype, and a zero chip stays put rather than hiding",
    async ({ page }) => {
      await openPokemon(page);
      await build(page, [[ULTRA, 4], [RESEARCH, 2], [MIRAIDON, 1]]);
      const r = await page.evaluate(() =>
        [...document.querySelectorAll(".dschip")].map((c) => ({
          text: c.textContent.replace(/\s+/g, " ").trim(),
          zero: c.classList.contains("zero"),
        })));
      expect(r.map((x) => x.text)).toEqual(["Items4", "Supporters2", "Stadiums0", "Tools0"]);
      expect(r.map((x) => x.zero)).toEqual([false, false, true, true]);
    });

  /* All four sit on ONE line inside the 340px deck panel. Asserted as geometry
     rather than trusted to the font metrics that make it fit, so a future
     padding or type-size change that pushes "Tools" onto a second row fails
     here instead of on someone's screen. */
  const chipGeometry = (page) => page.evaluate(() => {
    const chips = [...document.querySelectorAll(".dschip")];
    return {
      count: chips.length,
      lines: new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size,
      clipped: chips.filter((c) =>
        c.scrollWidth > Math.ceil(c.getBoundingClientRect().width) + 1).length,
      overflowing: chips.filter((c) => {
        const row = document.querySelector(".dstrainers").getBoundingClientRect();
        const b = c.getBoundingClientRect();
        return b.right > Math.ceil(row.right) + 1;
      }).length,
    };
  });

  test("all four stay on one line, unclipped", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[ULTRA, 16], [RESEARCH, 10], [MIRAIDON, 4]]);
    expect(await chipGeometry(page)).toEqual({ count: 4, lines: 1, clipped: 0, overflowing: 0 });
  });

  test("...even with every count in double digits", async ({ page }) => {
    await openPokemon(page);
    /* The widest the row can get: four two-digit counts. Real Trainer cards of
       each subtype, so the labels are the real labels. */
    await page.evaluate(async () => {
      freshDeck();
      const list = await loadSetPool("sv1");
      const pick = (st) => list.find((c) =>
        c.supertype === "Trainer" && (c.subtypes || []).some((x) => x.startsWith(st)));
      for (const st of ["Item", "Supporter", "Stadium", "Pokémon Tool"]) {
        const c = pick(st);
        if (c) S.zones.main.push({ ...c, id: uid(), qty: 44 });
      }
      hydrateDeckDetail();
      render();
    });
    await page.waitForFunction(() => DECK_DETAIL_PENDING === 0);
    const counts = await page.evaluate(() =>
      [...document.querySelectorAll(".dschip b")].map((b) => b.textContent));
    // Fixture check: this is only the worst case if the counts really are wide.
    expect(counts.filter((c) => c.length >= 2).length).toBeGreaterThanOrEqual(3);
    expect(await chipGeometry(page)).toEqual({ count: 4, lines: 1, clipped: 0, overflowing: 0 });
  });

  test("and on a phone, where the panel is full width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPokemon(page);
    await build(page, [[ULTRA, 16], [RESEARCH, 10], [MIRAIDON, 4]]);
    expect(await chipGeometry(page)).toEqual({ count: 4, lines: 1, clipped: 0, overflowing: 0 });
  });
});

test.describe("ACE SPEC and Radiant: one per deck, across all of them", () => {
  test("a second, different ACE SPEC is refused at add time", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[ACE_A, 1]]);
    const r = await page.evaluate((ref) => {
      const before = pkSubtypeCount("ACE SPEC");
      addCard(ref, "main");
      return { before, after: pkSubtypeCount("ACE SPEC"),
               rows: S.zones.main.length,
               notice: document.getElementById("notice").textContent };
    }, ACE_B);
    expect(r).toMatchObject({ before: 1, after: 1, rows: 1 });
    expect(r.notice).toMatch(/Only 1 ACE SPEC per deck/);
    // ...and it names what is already there, so the block is explicable.
    expect(r.notice).toMatch(/already has/);
  });

  test("a second copy of the SAME ACE SPEC is refused too", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[ACE_A, 1]]);
    await page.evaluate((ref) => addCard(ref, "main"), ACE_A);
    expect(await page.evaluate(() => pkSubtypeCount("ACE SPEC"))).toBe(1);
  });

  test("an over-cap deck that arrived from storage is reported, not silently kept",
    async ({ page }) => {
      await openPokemon(page);
      // Two different ACE SPECs, as a hand-edited blob or an import could produce.
      await build(page, [[ACE_A, 1], [ACE_B, 1], [MIRAIDON, 4]]);
      const r = await page.evaluate(() => ({
        count: pkSubtypeCount("ACE SPEC"),
        problems: document.getElementById("problems").innerText,
        pill: [...document.querySelectorAll(".dspill")]
          .find((p) => /ACE SPEC/.test(p.textContent)),
      }));
      expect(r.count).toBe(2);
      expect(r.problems).toMatch(/2 ACE SPEC cards — the limit is 1 per deck/);
      expect(await page.evaluate(() => {
        const p = [...document.querySelectorAll(".dspill")].find((x) => /ACE SPEC/.test(x.textContent));
        return { text: p.textContent.replace(/\s+/g, " ").trim(), bad: p.classList.contains("bad") };
      })).toMatchObject({ bad: true });
    });

  test("the rule is data, and Riftbound declares none of it", async ({ page }) => {
    await openApp(page);
    expect(await page.evaluate(() => GAME.rules.subtypeCaps)).toEqual([]);
    expect(await page.evaluate(() => !!GAME.blockAdd)).toBe(false);
    // The 3-copy limit still works, i.e. nothing was broken by the new gate.
    await page.evaluate(() => {
      freshDeck();
      for (let i = 0; i < 5; i++) addCard("ogn-001-298", "main");
    });
    expect(await page.evaluate(() => S.zones.main[0].qty)).toBe(3);
  });
});

test.describe("the type alignment strip", () => {
  const align = (page) => page.evaluate(() => ({
    ...pkAlignment(),
    flagged: !!document.querySelector(".dsflag"),
  }));

  test("a matched deck raises nothing", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 4], [L_ENERGY, 10]]);
    expect(await align(page)).toMatchObject({
      required: ["Lightning"], provided: ["Lightning"], missing: [],
      warn: false, flagged: false });
  });

  test("a missing type warns and names itself", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 4], [W_ENERGY, 10]]);
    expect(await align(page)).toMatchObject({
      required: ["Lightning"], provided: ["Water"], missing: ["Lightning"],
      warn: true, flagged: true });
    await expect(page.locator(".dsflag")).toHaveAttribute("title", /Lightning/);
  });

  test("a Colorless-only attacker asks for nothing — the reason costs beat card types",
    async ({ page }) => {
      /* Mew ex is Psychic by card type and costs only Colorless. Matching on the
         card's own type would flag a deck running it with no Psychic energy;
         matching on attack costs correctly asks for nothing. */
      await openPokemon(page);
      await build(page, [[MEW_EX, 2], [L_ENERGY, 10]]);
      const r = await align(page);
      expect(r.required).toEqual([]);
      expect(r.anyColorless).toBe(true);
      expect(r.warn).toBe(false);
      expect(r.flagged).toBe(false);
    });

  test("Special Energy suppresses the warning entirely", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 4], [SPECIAL, 4]]);
    const r = await align(page);
    // The requirement is still unmet — it is the WARNING that is suppressed,
    // because what a Special Energy provides is deliberately not modelled.
    expect(r.missing).toEqual(["Lightning"]);
    expect(r).toMatchObject({ special: true, warn: false, flagged: false });
  });

  test("several missing types are all named", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 2], [SCATTER, 2], [L_ENERGY, 4]]);
    const r = await align(page);
    if (r.missing.length) {
      const title = await page.locator(".dsflag").getAttribute("title");
      for (const t of r.missing) expect(title).toContain(t);
    }
  });
});

test.describe("the sectioned deck list", () => {
  test("three sections in play order, each with its own count", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 4], [ULTRA, 4], [RESEARCH, 2], [L_ENERGY, 10]]);
    expect(await page.evaluate(() =>
      [...document.querySelectorAll("#zoneList .dssec")]
        .map((h) => h.textContent.replace(/\s+/g, " ").trim())))
      .toEqual(["Pokémon 4", "Trainer 6", "Energy 10"]);
  });

  test("an evolution indents under its pre-evolution, Stage 2 under Stage 1",
    async ({ page }) => {
      await openPokemon(page);
      await build(page, [[VIVILLON, 2], [SCATTER, 4], [SPEWPA, 3], [MIRAIDON, 1]]);
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll("#zoneList li")].map((li) => ({
          name: li.querySelector(".dname")?.textContent,
          depth: li.classList.contains("evo2") ? 2 : li.classList.contains("evo1") ? 1 : 0,
          orphan: !!li.querySelector(".dorphan"),
        })));
      const line = rows.filter((r) => ["Scatterbug", "Spewpa", "Vivillon"].includes(r.name));
      // Drawn as a line, in order, regardless of the order they were added in.
      expect(line).toEqual([
        { name: "Scatterbug", depth: 0, orphan: false },
        { name: "Spewpa", depth: 1, orphan: false },
        { name: "Vivillon", depth: 2, orphan: false },
      ]);
      // A Basic with no evolutions is not indented and is not an orphan.
      expect(rows.find((r) => r.name === "Miraidon ex")).toMatchObject({ depth: 0, orphan: false });
    });

  test("an evolution whose pre-evolution is absent gets a hint, not an error",
    async ({ page }) => {
      await openPokemon(page);
      await build(page, [[SPEWPA, 3], [VIVILLON, 2], [SCATTER, 1]]);
      // Drop the Basic: Spewpa becomes a root, and says its pre-evolution is gone.
      await page.evaluate(() => {
        S.zones.main = S.zones.main.filter((c) => c.name !== "Scatterbug");
        render();
      });
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll("#zoneList li")].map((li) => ({
          name: li.querySelector(".dname")?.textContent,
          depth: li.classList.contains("evo2") ? 2 : li.classList.contains("evo1") ? 1 : 0,
          orphan: !!li.querySelector(".dorphan"),
          title: li.querySelector(".dorphan")?.title || null,
        })));
      const spewpa = rows.find((r) => r.name === "Spewpa");
      expect(spewpa).toMatchObject({ depth: 0, orphan: true });
      expect(spewpa.title).toMatch(/Scatterbug/);
      // Its own evolution still hangs off it.
      expect(rows.find((r) => r.name === "Vivillon")).toMatchObject({ depth: 1 });
      // A hint, NOT a legality error.
      expect(await page.evaluate(() =>
        document.getElementById("problems").innerText)).not.toMatch(/evolv/i);
    });

  test("two printings of one pre-evolution do not duplicate the line",
    async ({ page }) => {
      await openPokemon(page);
      // sv1-8 and a second Scatterbug printing under the same name.
      const other = await page.evaluate(async () => {
        await loadSetPool("sv1");
        const dup = PIDX.find((e) => e.n === "Scatterbug" && e.id !== "sv1-8");
        return dup ? dup.id : null;
      });
      test.skip(!other, "no second Scatterbug printing in the corpus");
      await build(page, [[SCATTER, 2], [other, 2], [SPEWPA, 3]]);
      const spewpas = await page.evaluate(() =>
        [...document.querySelectorAll("#zoneList .dname")]
          .filter((n) => n.textContent === "Spewpa").length);
      expect(spewpas).toBe(1);
    });

  test("an ACE SPEC row carries its badge", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[ACE_A, 1], [MIRAIDON, 1]]);
    const badged = await page.evaluate(() =>
      [...document.querySelectorAll("#zoneList li")]
        .filter((li) => li.querySelector(".dbadge"))
        .map((li) => `${li.querySelector(".dname").textContent}:${li.querySelector(".dbadge").textContent}`));
    expect(badged).toEqual(["Amulet of Hope:ACE"]);
  });

  test("a row stamps the PTCGL code and collector number", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 1], [ACE_A, 1]]);
    expect(await page.evaluate(() =>
      [...document.querySelectorAll("#zoneList .dset")].map((s) => s.textContent).sort()))
      .toEqual(["SSP 162", "SVI 81"]);
  });

  test("Riftbound's list stays flat, and its row keeps its energy cell",
    async ({ page }) => {
      await openApp(page);
      await page.evaluate(() => {
        freshDeck();
        addCard("ogn-001-298", "main");
        addCard("ogn-002-298", "main");
      });
      const r = await page.evaluate(() => ({
        sections: document.querySelectorAll("#zoneList .dssec").length,
        rows: document.querySelectorAll("#zoneList li").length,
        energyCells: document.querySelectorAll("#zoneList .denergy").length,
        badges: document.querySelectorAll("#zoneList .dbadge").length,
        code: document.querySelector("#zoneList .dset")?.textContent,
        statsHidden: document.getElementById("deckStats").hidden,
      }));
      expect(r).toEqual({ sections: 0, rows: 2, energyCells: 2, badges: 0,
                          code: "OGN", statsHidden: true });
    });
});

test.describe("decklist text, in the standard format", () => {
  const DECK = [[MIRAIDON, 4], [SCATTER, 4], [SPEWPA, 3], [VIVILLON, 2],
                [MEW_EX, 2], [ACE_A, 1], [ULTRA, 4], [RESEARCH, 4], [L_ENERGY, 10]];

  test("Copy as text emits the PTCGL sectioned format", async ({ page }) => {
    await openPokemon(page);
    await build(page, DECK);
    const text = await page.evaluate(() => GAME.deckText());
    const lines = text.trim().split("\n");
    // Sections, in order, each headed by its count.
    expect(lines[0]).toBe("Pokémon: 15");
    expect(text).toMatch(/^Trainer: 9$/m);
    expect(text).toMatch(/^Energy: 10$/m);
    // "<qty> <name> <SETCODE> <number>", flat inside a section.
    expect(text).toMatch(/^4 Miraidon ex SVI 81$/m);
    expect(text).toMatch(/^10 Basic Lightning Energy SVI 257$/m);
    expect(text).toMatch(/^1 Amulet of Hope SSP 162$/m);
    // The on-screen indentation is a reading aid, not part of the format.
    expect(text).not.toMatch(/^\s+\d/m);
  });

  test("the round trip is byte-identical", async ({ page }) => {
    await openPokemon(page);
    await build(page, DECK);
    const first = await page.evaluate(() => GAME.deckText());
    const second = await page.evaluate((t) => {
      const parsed = GAME.parseDeckText(t);
      freshDeck();
      hydrateDeck(parsed);
      hydrateDeckDetail();
      render();
      return GAME.deckText();
    }, first);
    expect(second).toBe(first);
    expect(await page.evaluate(() => ({
      total: zoneCount("main"), unresolved: S.unresolved.length }))).toEqual(
      { total: 34, unresolved: 0 });
  });

  test("a genuine PTCGL export imports, chrome and all", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 1]]);
    const r = await page.evaluate(() => {
      const list = [
        "Pokémon: 6", "4 Miraidon ex SVI 81", "2 Mew ex MEW 151", "",
        "Trainer: 4", "4 Ultra Ball SVI 196", "",
        "Energy: 10", "10 Basic Lightning Energy SVI 257", "",
        "Total Cards: 60", "",
      ].join("\n");
      freshDeck();
      hydrateDeck(GAME.parseDeckText(list));
      render();
      return { total: zoneCount("main"), rows: S.zones.main.length,
               unresolved: S.unresolved.length };
    });
    // The header counts and the "Total Cards" footer are skipped, not parsed.
    expect(r).toEqual({ total: 20, rows: 4, unresolved: 0 });
  });

  test("a printing the pool cannot explain is kept, visibly", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 1]]);
    const r = await page.evaluate(() => {
      freshDeck();
      hydrateDeck(GAME.parseDeckText("Pokémon: 3\n3 Fakemon ex ZZZ 999\n"));
      render();
      return { unresolved: S.unresolved, problems: document.getElementById("problems").innerText };
    });
    expect(r.unresolved).toEqual([{ zone: "main", ref: "Fakemon ex ZZZ 999", qty: 3 }]);
    expect(r.problems).toMatch(/aren't in the current card pool/);
  });

  test("a list with no card lines is refused rather than silently emptying a deck",
    async ({ page }) => {
      await openPokemon(page);
      expect(await page.evaluate(() => {
        try { GAME.parseDeckText("just some prose\n\nTotal Cards: 60\n"); return "PARSED"; }
        catch (e) { return e.message; }
      })).toMatch(/no card lines/);
    });

  test("Riftbound's Copy as text is untouched", async ({ page }) => {
    await openApp(page);
    const text = await page.evaluate(() => {
      freshDeck();
      S.deckName = "Test deck";
      addCard("ogn-001-298", "main");
      addCard("ogn-001-298", "main");
      return GAME.deckText();
    });
    expect(text.split("\n")[0]).toBe("// Test deck");
    expect(text).toMatch(/^Main deck:$/m);
    expect(text).toMatch(/^2 Blazing Scorcher$/m);
    // No PTCGL sections, and no set codes on the lines.
    expect(text).not.toMatch(/^Pokémon:/m);
    expect(text).not.toMatch(/OGN/);
  });
});

test.describe("detail arrives on demand", () => {
  test("the deck's own sets are fetched, and only those", async ({ page }) => {
    await openPokemon(page);
    const fetched = [];
    await page.route("**/data/pokemon/*-pool.json", (route) => {
      fetched.push(route.request().url().split("/").pop().replace("-pool.json", ""));
      return route.continue();
    });
    // Refs alone, no preloading: this is the page-load path for a saved deck.
    await page.evaluate((refs) => {
      freshDeck();
      hydrateDeck({ schema: 1, zones: { main: refs.map((ref) => ({ ref, qty: 2 })) } });
      render();
    }, [MIRAIDON, MEW_EX, ACE_A]);
    /* Before the pools land, the rows are light and the panel says so. Read
       both in one tick: the pending state is transient, and a retrying locator
       can miss it entirely once the fetches resolve. */
    const whilePending = await page.evaluate(() => ({
      pending: DECK_DETAIL_PENDING,
      note: document.querySelector(".dspending")?.textContent.trim() || null,
      bar: !!document.querySelector(".dsbar"),
      light: S.zones.main.filter((c) => c.light).length,
    }));
    expect(whilePending.pending).toBeGreaterThan(0);
    expect(whilePending.note).toMatch(/Reading card detail/);
    expect(whilePending.bar).toBe(false);       // no numbers it cannot stand behind
    expect(whilePending.light).toBeGreaterThan(0);
    await page.waitForFunction(() => DECK_DETAIL_PENDING === 0, null, { timeout: 20000 });
    const r = await page.evaluate(() => ({
      light: S.zones.main.filter((c) => c.light).length,
      supertypes: S.zones.main.every((c) => !!c.supertype),
      bar: !!document.querySelector(".dsbar"),
    }));
    expect(r).toEqual({ light: 0, supertypes: true, bar: true });
    // Three sets for three cards, plus nothing else.
    expect(new Set(fetched)).toEqual(new Set(["sv1", "sv3pt5", "sv8"]));
  });

  test("the subtype checks stay quiet until the detail is in", async ({ page }) => {
    await openPokemon(page);
    // Hold the pool open so the pending window is observable.
    await page.route("**/data/pokemon/sv1-pool.json", async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      return route.continue();
    });
    await page.evaluate((ref) => {
      freshDeck();
      hydrateDeck({ schema: 1, zones: { main: [{ ref, qty: 4 }] } });
      render();
    }, SCATTER);
    // A deck of Basics must NOT be told it has no Basic Pokémon while its
    // Pokémon are still in flight.
    expect(await page.evaluate(() =>
      document.getElementById("problems").innerText)).not.toMatch(/No Basic Pokémon/);
    await page.waitForFunction(() => DECK_DETAIL_PENDING === 0, null, { timeout: 20000 });
    expect(await page.evaluate(() =>
      document.getElementById("problems").innerText)).not.toMatch(/No Basic Pokémon/);
  });
});

test.describe("a deck of exactly 60 cannot grow", () => {
  /* Reported from the running app: a 60-card deck went to 63 by topping a row
     up to four copies. The cause was broader than the report — the 60-card rule
     was not enforced at add time AT ALL, and the row's + stepper never ran the
     add-time gates, so it also walked past the one-ACE-SPEC rule. One gate now,
     both paths through it. */
  test("the + stepper cannot push a full deck over 60", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 4], [L_ENERGY, 55], [SCATTER, 1]]);
    expect(await page.evaluate(() => zoneCount("main"))).toBe(60);
    const r = await page.evaluate(() => {
      const row = S.zones.main.find((c) => c.name === "Scatterbug");
      const noticeBefore = document.getElementById("notice").textContent;
      for (let i = 0; i < 3; i++) bump("main", row.id, 1);
      return { total: zoneCount("main"),
               qty: S.zones.main.find((c) => c.name === "Scatterbug").qty,
               noticeBefore, notice: document.getElementById("notice").textContent };
    });
    // Scatterbug is at 1 of an allowed 4, and still cannot be raised.
    expect(r).toMatchObject({ total: 60, qty: 1 });
    /* Silently. The deck header already reads 60/60 and the + is disabled with
       the reason on it, so a notice line would only restate that and then sit
       there afterwards. */
    expect(r.notice).toBe(r.noticeBefore);
  });

  test("a brand-new card cannot be added to a full deck either", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 4], [L_ENERGY, 56]]);
    const r = await page.evaluate((ref) => {
      const before = zoneCount("main");
      const noticeBefore = document.getElementById("notice").textContent;
      addCard(ref, "main");
      return { before, after: zoneCount("main"), noticeBefore,
               notice: document.getElementById("notice").textContent,
               // The browse tile carries the refusal instead.
               tileOff: [...document.querySelectorAll("#results .acts .btn")]
                 .filter((b) => b.disabled).length,
               tileTitle: document.querySelector("#results .acts .btn[disabled]")?.title };
    }, ULTRA);
    expect(r).toMatchObject({ before: 60, after: 60 });
    expect(r.notice).toBe(r.noticeBefore);
    expect(r.tileOff).toBeGreaterThan(0);
    expect(r.tileTitle).toMatch(/exactly 60/);
  });

  test("the + stepper respects the one-per-deck subtypes", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[ACE_A, 1]]);
    await page.evaluate(() => {
      const row = S.zones.main[0];
      bump("main", row.id, 1);
      bump("main", row.id, 1);
    });
    expect(await page.evaluate(() => pkSubtypeCount("ACE SPEC"))).toBe(1);
    expect(await page.evaluate(() =>
      document.getElementById("notice").textContent)).toMatch(/Only 1 ACE SPEC/);
  });

  test("under 60 the stepper still works, and removing frees room again",
    async ({ page }) => {
      await openPokemon(page);
      await build(page, [[MIRAIDON, 1], [L_ENERGY, 10]]);
      await page.evaluate(() => {
        const row = S.zones.main.find((c) => c.name === "Miraidon ex");
        bump("main", row.id, 1);
      });
      expect(await page.evaluate(() => zoneCount("main"))).toBe(12);
      // Fill to 60, get refused, remove one, and the same add now lands.
      const r = await page.evaluate((ref) => {
        const energy = S.zones.main.find((c) => c.energyType);
        energy.qty = 58;                       // 2 Miraidon + 58 energy = 60
        render();
        addCard(ref, "main");
        const blocked = zoneCount("main");
        bump("main", energy.id, -1);
        addCard(ref, "main");
        return { blocked, after: zoneCount("main") };
      }, ULTRA);
      expect(r).toEqual({ blocked: 60, after: 60 });
    });

  test("a + that would be refused is disabled, with a reason", async ({ page }) => {
    await openPokemon(page);
    await build(page, [[MIRAIDON, 4], [L_ENERGY, 56]]);
    const r = await page.evaluate(() =>
      [...document.querySelectorAll("#zoneList li")].map((li) => {
        const plus = li.querySelectorAll(".step")[1];
        return { name: li.querySelector(".dname")?.textContent,
                 disabled: plus.disabled, title: plus.title };
      }));
    // Full deck: every + refuses, and says why rather than looking live.
    expect(r.every((x) => x.disabled)).toBe(true);
    expect(r.map((x) => x.title).join(" ")).toMatch(/exactly 60|copy limit/);
  });

  test("an over-size deck from an import is still reported, and can be cut down",
    async ({ page }) => {
      await openPokemon(page);
      // Nothing stops a deck ARRIVING over 60 — only the app building one.
      await build(page, [[MIRAIDON, 4], [L_ENERGY, 60]]);
      expect(await page.evaluate(() => ({
        total: zoneCount("main"),
        problems: document.getElementById("problems").innerText,
      }))).toMatchObject({ total: 64 });
      expect(await page.evaluate(() =>
        document.getElementById("problems").innerText)).toMatch(/4 cards over 60/);
      // And − still works, so there is a way back.
      await page.evaluate(() => {
        const energy = S.zones.main.find((c) => c.energyType);
        for (let i = 0; i < 4; i++) bump("main", energy.id, -1);
      });
      expect(await page.evaluate(() => zoneCount("main"))).toBe(60);
    });

  test("a full deck refuses quietly, but a subtype refusal still explains itself",
    async ({ page }) => {
      /* The 60-card state is already on screen three times over — the deck
         header, the legality pill, and every add control being disabled — so
         restating it in the notice line was noise that then lingered. A
         one-per-deck refusal has no such backdrop, so that one still speaks. */
      await openPokemon(page);
      await build(page, [[MIRAIDON, 4], [L_ENERGY, 56]]);
      const quiet = await page.evaluate((ref) => {
        const before = document.getElementById("notice").textContent;
        addCard(ref, "main");
        return document.getElementById("notice").textContent === before;
      }, ULTRA);
      expect(quiet).toBe(true);

      await build(page, [[ACE_A, 1]]);
      const loud = await page.evaluate((ref) => {
        addCard(ref, "main");
        return document.getElementById("notice").textContent;
      }, ACE_B);
      expect(loud).toMatch(/Only 1 ACE SPEC/);
    });

  test("Riftbound is untouched: no add-time size gate, no disabled steppers",
    async ({ page }) => {
      await openApp(page);
      const r = await page.evaluate(() => {
        freshDeck();
        // Its main deck is 40 OR MORE, so there is no size to gate on.
        for (let i = 0; i < 12; i++) addCard("ogn-001-298", "main");
        for (let i = 0; i < 12; i++) addCard("ogn-002-298", "main");
        return {
          exact: GAME.rules.deckSizeExact,
          main: zoneCount("main"),
          disabled: document.querySelectorAll("#zoneList .step[disabled]").length,
          titled: document.querySelectorAll("#zoneList .step[title]").length,
        };
      });
      // 3 + 3 by the copy limit, nothing gated by size, nothing disabled.
      expect(r).toEqual({ exact: null, main: 6, disabled: 0, titled: 0 });
    });
});

/* ------------------------------------------------------------------------
   images.pokemontcg.io answers a MISSING card with HTTP 404 *and* a decodable
   PNG of the card back. An <img> decodes it and fires load, not error, so the
   onerror fallback never runs and the back renders as though it were the card
   (McDonald's Collection 2014/15/17/18 are entirely like this upstream).

   The tell is the size: 640x892 at both the small and the hires URL, which is
   neither a real small (245x342, 240x330 on the oldest sets) nor a real hires
   (734x1024).
   ------------------------------------------------------------------------ */
import zlib from "node:zlib";

/* A real, valid 8-bit greyscale PNG of the given size — the placeholder's
   shape, so the browser genuinely decodes it and genuinely fires load. */
function png(width, height) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;            // bit depth
  ihdr[9] = 0;            // greyscale
  const raw = Buffer.alloc(height * (width + 1));   // filter byte + row, all zero
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test.describe("a 404 that decodes as a card back", () => {
  test("the placeholder is swapped for our own fallback art", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("ch.game", "pokemon"));
    /* Serve EVERY card image the way the host serves a missing one: 404 plus a
       decodable card back. Both hosts — the set that opens by default is a Mega
       Evolution set, whose art is on scrydex, not pokemontcg.io. */
    await page.route(/images\.(pokemontcg\.io|scrydex\.com)/, (route) =>
      route.fulfill({ status: 404, contentType: "image/png", body: png(640, 892) }));
    await openApp(page);
    await page.waitForFunction(() => PIDX !== null);
    await page.waitForFunction(() =>
      document.querySelectorAll("#results .tile").length > 0);
    /* Tiles are loading="lazy", so only the ones on screen ever fire load —
       assert on what actually loaded rather than on the whole grid. */
    await page.waitForFunction(() =>
      document.querySelectorAll("#results .frame svg").length > 0, null,
      { timeout: 10000 });
    const r = await page.evaluate(() => ({
      tiles: document.querySelectorAll("#results .tile").length,
      fallbacks: document.querySelectorAll("#results .frame svg").length,
      // Any image that has decoded and is still standing at the placeholder's
      // size would be a card back on screen.
      backsLeft: [...document.querySelectorAll("#results .frame img")]
        .filter((i) => i.naturalWidth === 640 && i.naturalHeight === 892).length,
    }));
    expect(r.tiles).toBeGreaterThan(0);
    expect(r.fallbacks).toBeGreaterThan(0);
    expect(r.backsLeft).toBe(0);                // not one card back left standing
  });

  test("a correctly sized image is left alone", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("ch.game", "pokemon"));
    // A real small's dimensions: not the placeholder, so hands off.
    await page.route(/images\.(pokemontcg\.io|scrydex\.com)/, (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: png(245, 342) }));
    await openApp(page);
    await page.waitForFunction(() => PIDX !== null);
    await page.waitForFunction(() =>
      document.querySelectorAll("#results .tile").length > 0);
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => ({
      imgs: document.querySelectorAll("#results .frame img").length,
      fallbacks: document.querySelectorAll("#results .frame svg").length,
      // Proof the stub actually served these, so this cannot pass by accident.
      served: [...document.querySelectorAll("#results .frame img")]
        .filter((i) => i.naturalWidth === 245).length,
    }));
    expect(r.imgs).toBeGreaterThan(0);
    expect(r.served).toBeGreaterThan(0);
    expect(r.fallbacks).toBe(0);
  });

  test("the decision is the dimensions, and it is per game", async ({ page }) => {
    await openApp(page);
    // Riftbound declares no placeholder, so nothing is ever swapped...
    expect(await page.evaluate(() => !!GAME.artPlaceholder)).toBe(false);
    expect(await page.evaluate(() => {
      const el = document.createElement("img");
      Object.defineProperty(el, "naturalWidth", { value: 640 });
      Object.defineProperty(el, "naturalHeight", { value: 892 });
      el.id = "probe";
      document.body.appendChild(el);
      imgLoaded(el, "anything");
      const still = document.getElementById("probe");
      const tag = (still || document.body.lastElementChild).tagName.toLowerCase();
      document.body.lastElementChild.remove();
      return tag;
    })).toBe("img");
    /* Riftbound's images still carry data-card (the listeners are shared and
       global now), but imgLoaded() returns immediately without a declared
       placeholder, so nothing is ever swapped. */
    expect(await page.evaluate(() =>
      [...document.querySelectorAll("#results .frame img")]
        .filter((i) => i.dataset.card).length)).toBeGreaterThan(0);
  });

  test("the card panel says the image is missing, once", async ({ page }) => {
    /* On a tile the generated fallback speaks for itself. Opened up close it
       does not — the name, HP and types beside it are all real — so the panel
       has to say that only the picture is absent. */
    await page.addInitScript(() => localStorage.setItem("ch.game", "pokemon"));
    await page.route(/images\.(pokemontcg\.io|scrydex\.com)/, (route) =>
      route.fulfill({ status: 404, contentType: "image/png", body: png(640, 892) }));
    await openApp(page);
    await page.waitForFunction(() => PIDX !== null);
    await page.evaluate(() => openCard(refOf(S.pool[0])));
    await expect(page.locator("#modalBox .artmiss")).toBeVisible();
    const r = await page.evaluate(() => ({
      text: document.querySelector("#modalBox .artmiss").textContent,
      count: document.querySelectorAll("#modalBox .artmiss").length,
      // Above the actions, below the card's own detail.
      order: [...document.querySelectorAll("#modalBox .meta > *")].map((e) => e.className),
      art: !!document.querySelector("#modalBox svg"),
    }));
    expect(r.text).toMatch(/no image/i);
    expect(r.count).toBe(1);
    expect(r.art).toBe(true);
    expect(r.order.indexOf("artmiss")).toBeLessThan(r.order.indexOf("modalacts"));

    // Reopening must not stack a second copy.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Escape");
      await page.evaluate(() => openCard(refOf(S.pool[0])));
      await expect(page.locator("#modalBox .artmiss")).toBeVisible();
    }
    expect(await page.locator("#modalBox .artmiss").count()).toBe(1);
  });

  test("a card whose art loads gets no such message", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("ch.game", "pokemon"));
    await page.route(/images\.(pokemontcg\.io|scrydex\.com)/, (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: png(245, 342) }));
    await openApp(page);
    await page.waitForFunction(() => PIDX !== null);
    await page.evaluate(() => openCard(refOf(S.pool[0])));
    await expect(page.locator("#modalBox img")).toBeVisible();
    await page.waitForTimeout(400);
    expect(await page.locator("#modalBox .artmiss").count()).toBe(0);
  });

  test("every card image is wired to the load/error listeners", async ({ page }) => {
    /* The handlers are delegated now — no inline onload/onerror anywhere, so the
       CSP can forbid inline script. What each image carries instead is the
       data-card the capture listeners read. */
    await page.addInitScript(() => localStorage.setItem("ch.game", "pokemon"));
    await openApp(page);
    await page.waitForFunction(() => PIDX !== null);
    await page.waitForFunction(() =>
      document.querySelectorAll("#results .frame img").length > 0);
    const r = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll("#results .frame img")];
      return { total: imgs.length,
               wired: imgs.filter((i) => i.dataset.card).length,
               inlineHandlers: imgs.filter((i) =>
                 i.getAttribute("onload") || i.getAttribute("onerror")).length };
    });
    expect(r.total).toBeGreaterThan(0);
    expect(r.wired).toBe(r.total);
    expect(r.inlineHandlers).toBe(0);
  });
});

test.describe("the deck switcher's row summary", () => {
  /* Its subtitle was Riftbound's outright: a Legend name and three zone counts
     (main/runes/battlefields). A Pokémon deck has no Legend and one zone, so it
     read "No legend yet · 60/0/0" — two facts about a different game. */
  const menu = (page, rows) => page.evaluate((rows) => {
    MODE = "cloud";
    CLOUD_USER = { id: "u1" };
    DECKS = rows;
    toggleDeckMenu(true);
    return {
      sub: document.querySelector("#deckMenu .dmsub")?.textContent.replace(/\s+/g, " ").trim(),
      mentionsLegend: /legend/i.test(document.getElementById("deckMenu").innerText),
      head: document.querySelector("#deckMenu .dmhead")?.innerText.replace(/\s+/g, " ").trim(),
    };
  }, rows);

  test("a Pokémon row counts one deck against 60, and says nothing of Legends",
    async ({ page }) => {
      await openPokemon(page);
      const r = await menu(page, [{
        id: "r1", name: "Test", updated_at: new Date().toISOString(),
        payload: { schema: 1, legend: null, champion: null,
                   zones: { main: [{ ref: "sv1-81", qty: 4 }, { ref: "sv1-257", qty: 56 }] } },
      }]);
      expect(r.sub).toBe("60/60 cards");
      expect(r.mentionsLegend).toBe(false);
      expect(r.head).toMatch(/pokémon tcg/i);   // innerText is CSS-uppercased
    });

  test("an incomplete Pokémon deck says how far off it is", async ({ page }) => {
    await openPokemon(page);
    const r = await menu(page, [{
      id: "r1", name: "WIP", updated_at: new Date().toISOString(),
      payload: { schema: 1, zones: { main: [{ ref: "sv1-81", qty: 4 }] } },
    }]);
    expect(r.sub).toBe("4/60 cards");
  });

  test("a Riftbound row keeps its Legend and its three zone counts",
    async ({ page }) => {
      await openApp(page);
      const r = await menu(page, [{
        id: "r1", name: "RB", updated_at: new Date().toISOString(),
        payload: { schema: 1, legend: null, champion: null, zones: {
          main: [{ ref: "ogn-001-298", qty: 2 }],
          runes: [{ ref: "ogn-004-298", qty: 1 }],
          battlefields: [{ ref: "ogn-002-298", qty: 1 }],
        } },
      }]);
      expect(r.sub).toBe("No legend yet · 2/1/1");
      expect(r.mentionsLegend).toBe(true);
    });
});

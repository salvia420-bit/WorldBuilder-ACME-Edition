// Phase E.D — `validate-entity-classification`
//
// **What this tool does:** runs the canonical entity classifier
// (`plugins/world-objects/canonical_classify.js`) against a
// hand-curated payload set covering every branch of ACPlugin's
// `WorldObject.GetObjectClass` algorithm (the C# source we ported).
// Asserts known-good output for each branch + reports coverage and
// distribution. Permanent regression test.
//
// **Mirrors world-completeness §Phase E / event-completeness §F.D**
// but is dramatically simpler because entity classification is a
// pure function of three u32 bitfields — no time window, no Playwright,
// no live server. Just call the classifier with synthetic inputs
// covering every algorithm rule.
//
// **The contract** (docs/entity-completeness-method.md §3):
//
//   typed_class(e) ≡ {
//     canonical_classify(item_type, obj_desc_flags, weenie_flags)
//       where canonical_classify ≡ 1:1 port of
//       ACPlugin.WorldObject.GetObjectClass (cs:344-411)
//     ∪ ObjectClass.Unknown sentinel
//       when no algorithm rule matches
//   }
//
// **What this validator covers**:
//   - All 26 PASS-1 ItemType cascade branches (cs:347-372)
//   - All 12 PASS-2 ObjectDescriptionFlag override branches (cs:375-388)
//   - All 5 PASS-3 refinement branches (Writable+Book→Journal/Sign/Book,
//     Writable+Spell→Scroll, Monster→Npc via !Attackable, Misc+Stuck
//     →Static)
//   - Unknown sentinel (no inputs match)
//
// **What it does NOT cover** (deferred to E.E + live capture):
//   - Cross-port parity against ACPlugin's actual C# implementation
//     (would need WB.Terminal `chorizite-classify` + a Node ↔ WB.Terminal
//     bridge; see CHORIZITE_PORTING_PLAN.md §12.4)
//   - Coverage of real wire payloads from a running ACE session
//     (would need a capture mechanism — flag as follow-on)
//
// **Run:**  `node validate_entity_classification.cjs`
// **Exit:** 0 if all assertions pass; nonzero otherwise.
//
// **CI hook:** invoke via the wbterminal-test-loop equivalent on
// every commit that touches `plugins/world-objects/`.

(async () => {
  const path = require("node:path");
  const url  = require("node:url");
  const repoRoot = path.dirname(__filename);
  const classifierUrl = url.pathToFileURL(path.join(
    repoRoot, "plugins", "world-objects", "canonical_classify.js"
  )).href;
  const { canonicalClassify, BITFLAGS } = await import(classifierUrl);

  const IT  = BITFLAGS.ItemType;
  const ODF = BITFLAGS.ObjectDescriptionFlag;
  const WHF = BITFLAGS.WeenieHeaderFlag;

  // ──────────────────────────────────────────────────────────────
  // The payload set — one entry per algorithm branch, in C# source
  // order so reading this is a 1:1 walk of WorldObject.cs:344-411.
  // ──────────────────────────────────────────────────────────────
  const cases = [
    // PASS 1 — ItemType cascade (26 branches)
    { name: "MeleeWeapon",                    it: IT.MeleeWeapon,                 odf: 0, whf: 0, want: "MeleeWeapon"     },
    { name: "Armor",                          it: IT.Armor,                       odf: 0, whf: 0, want: "Armor"           },
    { name: "Clothing",                       it: IT.Clothing,                    odf: 0, whf: 0, want: "Clothing"        },
    { name: "Jewelry",                        it: IT.Jewelry,                     odf: 0, whf: 0, want: "Jewelry"         },
    { name: "Creature (no obj-desc)",         it: IT.Creature,                    odf: 0, whf: 0, want: "Npc"             }, // !Attackable refinement
    { name: "Creature + Attackable",          it: IT.Creature,                    odf: ODF.Attackable, whf: 0, want: "Monster" },
    { name: "Food (via ItemType)",            it: IT.Food,                        odf: 0, whf: 0, want: "Food"            },
    { name: "Money",                          it: IT.Money,                       odf: 0, whf: 0, want: "Money"           },
    { name: "Misc (no Stuck)",                it: IT.Misc,                        odf: 0, whf: 0, want: "Misc"            },
    { name: "MissileWeapon",                  it: IT.MissileWeapon,               odf: 0, whf: 0, want: "MissileWeapon"   },
    { name: "Container (via ItemType)",       it: IT.Container,                   odf: 0, whf: 0, want: "Container"       },
    { name: "Useless",                        it: IT.Useless,                     odf: 0, whf: 0, want: "Bundle"          },
    { name: "Gem",                            it: IT.Gem,                         odf: 0, whf: 0, want: "Gem"             },
    { name: "SpellComponents",                it: IT.SpellComponents,             odf: 0, whf: 0, want: "SpellComponent"  },
    { name: "Key",                            it: IT.Key,                         odf: 0, whf: 0, want: "Key"             },
    { name: "Caster",                         it: IT.Caster,                      odf: 0, whf: 0, want: "WandStaffOrb"    },
    { name: "Portal (via ItemType)",          it: IT.Portal,                      odf: 0, whf: 0, want: "Portal"          },
    { name: "PromissoryNote",                 it: IT.PromissoryNote,              odf: 0, whf: 0, want: "TradeNote"       },
    { name: "ManaStone",                      it: IT.ManaStone,                   odf: 0, whf: 0, want: "ManaStone"       },
    { name: "Service",                        it: IT.Service,                     odf: 0, whf: 0, want: "Services"        },
    { name: "MagicWieldable",                 it: IT.MagicWieldable,              odf: 0, whf: 0, want: "Plant"           },
    { name: "CraftCookingBase",               it: IT.CraftCookingBase,            odf: 0, whf: 0, want: "BaseCooking"     },
    { name: "CraftAlchemyBase",               it: IT.CraftAlchemyBase,            odf: 0, whf: 0, want: "BaseAlchemy"     },
    { name: "CraftFletchingBase",             it: IT.CraftFletchingBase,          odf: 0, whf: 0, want: "BaseFletching"   },
    { name: "CraftFletchingIntermediate",     it: IT.CraftFletchingIntermediate,  odf: 0, whf: 0, want: "CraftedFletching" },
    { name: "TinkeringTool",                  it: IT.TinkeringTool,               odf: 0, whf: 0, want: "Ust"             },
    { name: "TinkeringMaterial",              it: IT.TinkeringMaterial,           odf: 0, whf: 0, want: "Salvage"         },

    // PASS 2 — ObjectDescriptionFlag overrides (12 branches)
    { name: "Player override",                it: IT.Creature,                    odf: ODF.Player,             whf: 0, want: "Player"     },
    { name: "Vendor override",                it: IT.Creature,                    odf: ODF.Vendor,             whf: 0, want: "Vendor"     },
    { name: "Door (no ItemType)",             it: 0,                              odf: ODF.Door,               whf: 0, want: "Door"       },
    { name: "Corpse",                         it: 0,                              odf: ODF.Corpse,             whf: 0, want: "Corpse"     },
    { name: "Lifestone",                      it: 0,                              odf: ODF.Lifestone,          whf: 0, want: "Lifestone"  },
    { name: "Food override via obj-desc",     it: 0,                              odf: ODF.Food,               whf: 0, want: "Food"       },
    { name: "Healer (HealingKit)",            it: IT.Misc,                        odf: ODF.Healer,             whf: 0, want: "HealingKit" },
    { name: "Lockpick",                       it: IT.Misc,                        odf: ODF.Lockpick,           whf: 0, want: "Lockpick"   },
    { name: "Portal override via obj-desc",   it: 0,                              odf: ODF.Portal,             whf: 0, want: "Portal"     },
    { name: "Foci (RequiresPackSlot)",        it: 0,                              odf: ODF.RequiresPackSlot,   whf: 0, want: "Foci"       },
    { name: "Container override (Openable)",  it: 0,                              odf: ODF.Openable,           whf: 0, want: "Container"  },
    { name: "Bindstone",                      it: 0,                              odf: ODF.BindStone,          whf: 0, want: "Bindstone"  },

    // PASS 3 — Refinements (5 branches)
    { name: "Writable + Book + Inscribable → Journal", it: IT.Writable, odf: ODF.Book | ODF.Inscribable, whf: 0, want: "Journal" },
    { name: "Writable + Book + Stuck → Sign",          it: IT.Writable, odf: ODF.Book | ODF.Stuck,       whf: 0, want: "Sign"    },
    { name: "Writable + Book (plain) → Book",          it: IT.Writable, odf: ODF.Book,                   whf: 0, want: "Book"    },
    { name: "Writable + Spell → Scroll",               it: IT.Writable, odf: 0,                          whf: WHF.Spell, want: "Scroll" },
    { name: "Monster → Npc (!Attackable refinement)",  it: IT.Creature, odf: 0,                          whf: 0, want: "Npc"     },
    { name: "Monster → Npc (IncludesSecondHeader)",    it: IT.Creature, odf: ODF.Attackable | ODF.IncludesSecondHeader, whf: 0, want: "Npc" },
    { name: "Misc + Stuck → Static",                   it: IT.Misc,     odf: ODF.Stuck,                  whf: 0, want: "Static"  },
    { name: "Unknown + Stuck → Static",                it: 0,           odf: ODF.Stuck,                  whf: 0, want: "Static"  },

    // Sentinel
    { name: "Unknown (no inputs)",            it: 0, odf: 0, whf: 0, want: "Unknown" },

    // Realistic combined payloads (smoke-tests of real-game scenarios)
    { name: "Holtburg Vendor (Lin)",          it: IT.Creature,     odf: ODF.Vendor,                       whf: 0, want: "Vendor"  },
    { name: "Holtburg NPC (Atlan)",           it: IT.Creature,     odf: 0,                                whf: 0, want: "Npc"     },
    { name: "Academy Mosswart",               it: IT.Creature,     odf: ODF.Attackable,                   whf: 0, want: "Monster" },
    { name: "Lifestone (full obj-desc)",      it: 0,               odf: ODF.Lifestone | ODF.Stuck,        whf: 0, want: "Lifestone" },
    { name: "Cottage Door",                   it: 0,               odf: ODF.Door | ODF.Stuck,             whf: 0, want: "Door" },
    { name: "Holtburg Portal",                it: IT.Portal,       odf: ODF.Portal,                       whf: 0, want: "Portal" },
    { name: "Iron Sword (combat)",            it: IT.MeleeWeapon,  odf: 0,                                whf: 0, want: "MeleeWeapon" },
    { name: "Health Heal Self Scroll",        it: IT.Writable,     odf: 0,                                whf: WHF.Spell, want: "Scroll" },
  ];

  // ──────────────────────────────────────────────────────────────
  // Run + report
  // ──────────────────────────────────────────────────────────────
  let pass = 0, fail = 0;
  const distribution = new Map();
  const failures = [];

  for (const c of cases) {
    const got = canonicalClassify(c.it, c.odf, c.whf);
    distribution.set(got, (distribution.get(got) ?? 0) + 1);
    const ok = got === c.want;
    if (ok) {
      pass++;
    } else {
      fail++;
      failures.push({ name: c.name, want: c.want, got, inputs: c });
    }
  }

  console.log("");
  console.log("validate_entity_classification — Phase E.D");
  console.log("==========================================");
  console.log(`Classifier:  plugins/world-objects/canonical_classify.js`);
  console.log(`Algorithm:   ACPlugin/API/WorldObject.cs:344-411 (canonical port)`);
  console.log(`Contract:    docs/entity-completeness-method.md §3`);
  console.log("");
  console.log(`Cases:       ${cases.length}`);
  console.log(`Pass:        ${pass}`);
  console.log(`Fail:        ${fail}`);
  console.log("");
  console.log("Class distribution (over the test set — exercises every algorithm branch):");
  const sortedClasses = [...distribution.entries()].sort((a, b) => b[1] - a[1]);
  for (const [cls, count] of sortedClasses) {
    console.log(`  ${cls.padEnd(20)} ${count}`);
  }
  console.log("");

  if (fail > 0) {
    console.log("FAILURES:");
    for (const f of failures) {
      console.log(`  ✗ ${f.name}`);
      console.log(`      wanted:   ${f.want}`);
      console.log(`      got:      ${f.got}`);
      console.log(`      inputs:   itemType=0x${f.inputs.it.toString(16)} ` +
                  `objDescFlags=0x${f.inputs.odf.toString(16)} ` +
                  `weenieFlags=0x${f.inputs.whf.toString(16)}`);
    }
    process.exit(1);
  }

  // Coverage check — assert the test set actually exercised the full
  // ObjectClass surface area we expect to see in real gameplay.
  const expectedClasses = new Set([
    "MeleeWeapon", "Armor", "Clothing", "Jewelry", "Monster", "Npc", "Vendor",
    "Player", "Food", "Money", "Misc", "Container", "Bundle", "Gem",
    "SpellComponent", "Key", "WandStaffOrb", "Portal", "TradeNote", "ManaStone",
    "Services", "Plant", "BaseCooking", "BaseAlchemy", "BaseFletching",
    "CraftedFletching", "Ust", "Salvage", "MissileWeapon", "Door", "Corpse",
    "Lifestone", "HealingKit", "Lockpick", "Foci", "Bindstone", "Journal",
    "Sign", "Book", "Scroll", "Static", "Unknown",
  ]);
  const missing = [...expectedClasses].filter(c => !distribution.has(c));
  if (missing.length > 0) {
    console.log("COVERAGE GAP — test set does not exercise these ObjectClass values:");
    for (const m of missing) console.log(`  - ${m}`);
    console.log("");
    console.log("(extend the `cases` array above with a payload that produces each)");
    process.exit(1);
  }

  console.log(`PASS — all ${pass} branches covered, all ${expectedClasses.size} canonical ObjectClass values exercised.`);
  process.exit(0);
})().catch(e => {
  console.error("validator crashed:", e);
  process.exit(2);
});

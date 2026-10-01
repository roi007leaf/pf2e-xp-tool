const fs = require("fs");

const source = fs.readFileSync("scripts/main.js", "utf8");
const instrumented = source.replace(
  /\}\)\(\);\s*$/,
  "globalThis.__xpHpTest = { calculateXPWithHpBoost, requiredFortifyPercent, setActorHpBoost, toggleAllHpBoost }; })();"
);
if (instrumented === source) throw new Error("Could not expose HP boost test seam");

globalThis.foundry = { appv1: { api: { Dialog: class {} } }, utils: { deepClone: value => value } };
globalThis.Hooks = { once() {}, on() {} };
globalThis.game = {
  pf2e: {
    gm: {
      calculateXP() {
        return {
          totalXP: 40,
          encounterBudgets: { trivial: 40, low: 60, moderate: 80, severe: 120, extreme: 160 },
          rating: "trivial",
          ratingXP: 40,
          xpPerPlayer: 40
        };
      }
    }
  }
};

new Function(instrumented)();

(async () => {
  const bulkNpcs = [{ previewHpBoost: false }, { previewHpBoost: true }];
  if (!globalThis.__xpHpTest.toggleAllHpBoost(bulkNpcs) || bulkNpcs.some(npc => !npc.previewHpBoost)) {
    throw new Error("Bulk HP boost did not select all enemies");
  }
  if (globalThis.__xpHpTest.toggleAllHpBoost(bulkNpcs) || bulkNpcs.some(npc => npc.previewHpBoost)) {
    throw new Error("Bulk HP boost did not clear all enemies");
  }

  const percent = globalThis.__xpHpTest.requiredFortifyPercent(100, 80, 80);
  if (percent !== 25) throw new Error(`Expected 25% HP across 80 selected XP; received ${percent}`);
  const oneEnemyPercent = globalThis.__xpHpTest.requiredFortifyPercent(100, 80, 40);
  if (oneEnemyPercent !== 50) throw new Error(`Expected 50% HP on one 40 XP enemy; received ${oneEnemyPercent}`);

  const result = globalThis.__xpHpTest.calculateXPWithHpBoost(3, 4, [3], [25], [], false);
  if (result.totalXP !== 50 || result.hpSurcharge !== 10) {
    throw new Error(`Expected 40 XP creature with 25% HP to become 50 effective XP; received ${result.totalXP}`);
  }

  let hpBoostFlag = null;
  const actor = {
    system: { attributes: { hp: { max: 40, value: 40 } } },
    getFlag() { return hpBoostFlag; },
    async update(changes) {
      const previousMax = this.system.attributes.hp.max;
      if ("system.attributes.hp.max" in changes) {
        this.system.attributes.hp.max = Math.max(changes["system.attributes.hp.max"], this.system.attributes.hp.value);
      }
      if ("system.attributes.hp.value" in changes) {
        this.system.attributes.hp.value = Math.min(changes["system.attributes.hp.value"], previousMax);
      }
      const flagKey = "flags.pf2e-xp-tool.hpBoost";
      if (flagKey in changes) hpBoostFlag = changes[flagKey];
    },
    async unsetFlag() { hpBoostFlag = null; }
  };

  await globalThis.__xpHpTest.setActorHpBoost(actor, true, 7.5);
  if (actor.system.attributes.hp.max !== 43 || actor.system.attributes.hp.value !== 43) {
    throw new Error(`HP boost did not raise current HP with max HP: ${actor.system.attributes.hp.value}/${actor.system.attributes.hp.max}`);
  }
  await globalThis.__xpHpTest.setActorHpBoost(actor, false);
  if (actor.system.attributes.hp.max !== 40 || actor.system.attributes.hp.value !== 40 || hpBoostFlag) {
    throw new Error("HP boost removal did not restore original HP state");
  }

  actor.system.attributes.hp.value = 30;
  await globalThis.__xpHpTest.setActorHpBoost(actor, true, 7.5);
  if (actor.system.attributes.hp.max !== 43 || actor.system.attributes.hp.value !== 33) {
    throw new Error("HP boost did not preserve existing damage");
  }
  await globalThis.__xpHpTest.setActorHpBoost(actor, false);
  if (actor.system.attributes.hp.max !== 40 || actor.system.attributes.hp.value !== 30) {
    throw new Error("HP boost removal did not restore damaged HP state");
  }

  let eliteHpBoostFlag = null;
  const eliteActor = {
    _source: { system: { attributes: { hp: { max: 30, value: 40 } } } },
    system: { attributes: { adjustment: "elite", hp: { max: 40, value: 40 } } },
    getFlag() { return eliteHpBoostFlag; },
    async update(changes) {
      const previousMax = this.system.attributes.hp.max;
      if ("system.attributes.hp.max" in changes) {
        this._source.system.attributes.hp.max = changes["system.attributes.hp.max"];
        this.system.attributes.hp.max = changes["system.attributes.hp.max"] + 10;
      }
      if ("system.attributes.hp.value" in changes) {
        this._source.system.attributes.hp.value = changes["system.attributes.hp.value"];
        this.system.attributes.hp.value = Math.min(changes["system.attributes.hp.value"], previousMax);
      }
      const flagKey = "flags.pf2e-xp-tool.hpBoost";
      if (flagKey in changes) eliteHpBoostFlag = changes[flagKey];
    },
    async unsetFlag() { eliteHpBoostFlag = null; }
  };

  await globalThis.__xpHpTest.setActorHpBoost(eliteActor, true, 25);
  if (eliteActor.system.attributes.hp.max !== 50 || eliteActor.system.attributes.hp.value !== 50) {
    throw new Error(`Elite HP boost did not raise current HP with derived max HP: ${eliteActor.system.attributes.hp.value}/${eliteActor.system.attributes.hp.max}`);
  }
  await globalThis.__xpHpTest.setActorHpBoost(eliteActor, false);
  if (eliteActor.system.attributes.hp.max !== 40 || eliteActor.system.attributes.hp.value !== 40 || eliteHpBoostFlag) {
    throw new Error(`Elite HP boost removal did not restore original HP state: ${eliteActor.system.attributes.hp.value}/${eliteActor.system.attributes.hp.max}`);
  }

  eliteActor._source.system.attributes.hp.max = 50;
  eliteActor._source.system.attributes.hp.value = 50;
  eliteActor.system.attributes.hp.max = 60;
  eliteActor.system.attributes.hp.value = 50;
  eliteHpBoostFlag = { baseMax: 40, percent: 25 };
  await globalThis.__xpHpTest.setActorHpBoost(eliteActor, false);
  if (eliteActor.system.attributes.hp.max !== 40 || eliteActor.system.attributes.hp.value !== 40 || eliteHpBoostFlag) {
    throw new Error(`Legacy Elite HP boost was not repaired during removal: ${eliteActor.system.attributes.hp.value}/${eliteActor.system.attributes.hp.max}`);
  }
  console.log("PASS: HP boost XP, application, and removal");
})();

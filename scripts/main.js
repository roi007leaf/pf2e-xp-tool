"use strict";

(function () {
  const MODULE_ID = "pf2e-xp-tool";
  const CREATURE_INDEX_TIMEOUT_MS = 3000;
  let lastAppliedBatch = [];
  let lastAddedTokens = [];
  let creatureCandidatesPromise = null;

  const DialogClass =
    (typeof foundry !== "undefined" && foundry.appv1 && foundry.appv1.api && foundry.appv1.api.Dialog) ||
    globalThis.Dialog;

  const L = function (key) { return game.i18n.localize(key); };
  const T = function (key, data) {
    const full = `PF2EXPTool.${key}`;
    return data ? game.i18n.format(full, data) : game.i18n.localize(full);
  };

  function levelDelta(baseLevel, adj) {
    if (adj === "elite") return baseLevel < 1 ? 2 : 1;
    if (adj === "weak")  return baseLevel === 1 ? -2 : -1;
    return 0;
  }
  function effectiveLevel(baseLevel, adj) {
    return baseLevel + levelDelta(baseLevel, adj);
  }

  const ADJ_KEYS = ["weak", "normal", "elite"];
  const ADJUSTMENTS = new Proxy({}, {
    get(_, key) {
      if (typeof key !== "string" || !ADJ_KEYS.includes(key)) return undefined;
      return { label: T(`adj.${key}.label`), short: T(`adj.${key}.short`) };
    },
    has(_, key) { return typeof key === "string" && ADJ_KEYS.includes(key); }
  });


  function clampInt(value, fallback) {
    const n = Math.abs(Math.trunc(Number(value)));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function clampFloat(value, fallback) {
    const n = Math.abs(Number(value));
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.round(n * 100) / 100;
  }

  function signed(n) { return n >= 0 ? "+" + n : String(n); }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function loadCreatureCandidates() {
    if (creatureCandidatesPromise) return creatureCandidatesPromise;
    creatureCandidatesPromise = (async () => {
      const byLevel = new Map();
      const packs = game.packs.filter(pack => pack.documentName === "Actor");
      const results = await Promise.allSettled(packs.map(async pack => {
        const index = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve([]), CREATURE_INDEX_TIMEOUT_MS);
          pack.getIndex({ fields: [
            "type", "system.details.level.value", "system.traits.rarity",
            "system.traits.value", "system.details.publicNotes",
            "system.details.description.value", "system.description.value"
          ] })
            .then(value => { clearTimeout(timer); resolve(value); })
            .catch(error => { clearTimeout(timer); reject(error); });
        });
        return { pack, index };
      }));
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const { pack, index } = result.value;
        for (const entry of index) {
          if (entry.type !== "npc") continue;
          const level = Number(foundry.utils.getProperty(entry, "system.details.level.value"));
          if (!Number.isFinite(level)) continue;
          const uuid = entry.uuid || `Compendium.${pack.collection}.Actor.${entry._id}`;
          const list = byLevel.get(level) || [];
          const traits = foundry.utils.getProperty(entry, "system.traits.value") || [];
          const description = foundry.utils.getProperty(entry, "system.details.publicNotes") ||
            foundry.utils.getProperty(entry, "system.details.description.value") ||
            foundry.utils.getProperty(entry, "system.description.value") || "";
          list.push({
            name: entry.name, uuid, pack: pack.collection,
            traits: Array.isArray(traits) ? traits : [],
            searchText: String(description).replace(/<[^>]*>/g, " ").toLowerCase()
          });
          byLevel.set(level, list);
        }
      }
      for (const [level, entries] of byLevel) {
        const seen = new Set();
        const unique = entries
          .filter(entry => entry.name && entry.uuid && !seen.has(entry.uuid) && seen.add(entry.uuid))
          .sort((a, b) => a.name.localeCompare(b.name));
        byLevel.set(level, unique);
      }
      return byLevel;
    })();
    return creatureCandidatesPromise;
  }

  function getActorAdjustment(actor) {
    const adj = actor && actor.system && actor.system.attributes && actor.system.attributes.adjustment;
    return ADJUSTMENTS[adj] ? adj : "normal";
  }

  function getActorHpBoost(actor) {
    return !!(actor && actor.getFlag && actor.getFlag(MODULE_ID, "hpBoost"));
  }

  function getActorHpBoostPercent(actor) {
    const flag = actor && actor.getFlag && actor.getFlag(MODULE_ID, "hpBoost");
    return flag ? Number(flag.percent ?? 25) : 0;
  }

  function getBaseLevel(actor) {
    if (!actor) return 0;
    const base = actor.system && actor.system.details && actor.system.details.level && actor.system.details.level.base;
    if (typeof base === "number") return base;
    const adj = getActorAdjustment(actor);
    const eff = Number(actor.level);
    if (adj === "elite") {
      if (eff <= 1) return -1;
      if (eff === 2) return 1;
      return eff - 1;
    }
    if (adj === "weak") {
      if (eff === -1) return 1;
      return eff + 1;
    }
    return eff;
  }


  const STANDARD_XP_MAP = {
    "-4": 10, "-3": 15, "-2": 20, "-1": 30, "0": 40,
    "1": 60, "2": 80, "3": 120, "4": 160
  };
  const PWOL_XP_MAP = {
    "-7": 9, "-6": 12, "-5": 14, "-4": 18, "-3": 21, "-2": 26, "-1": 32, "0": 40,
    "1": 48, "2": 60, "3": 72, "4": 90, "5": 108, "6": 135, "7": 160
  };
  const SIMPLE_HAZARD_XP_MAP = {
    "-4": 2, "-3": 3, "-2": 4, "-1": 6, "0": 8,
    "1": 12, "2": 16, "3": 24, "4": 32
  };
  const DIFFICULTY_KEYS = ["trivial", "low", "moderate", "severe", "extreme"];
  const BASE_ENCOUNTER_BUDGETS = { trivial: 40, low: 60, moderate: 80, severe: 120, extreme: 160 };
  const CHARACTER_ADJUSTMENTS = { trivial: 10, low: 20, moderate: 20, severe: 30, extreme: 40 };
  const QUICK_GROUPS = {
    "boss-lackeys": { slots: [2, -4, -4, -4, -4], budget: 120 },
    "boss-lieutenant": { slots: [2, 0], budget: 120 },
    "elite-enemies": { slots: [0, 0, 0], budget: 120 },
    "lieutenant-lackeys": { slots: [0, -4, -4, -4, -4], budget: 80 },
    "mated-pair": { slots: [0, 0], budget: 80 },
    troop: { slots: [0, -2, -2], budget: 80 },
    "mook-squad": { slots: [-4, -4, -4, -4, -4, -4], budget: 60 }
  };

  function encounterBudgetsForParty(partySize) {
    const extraCharacters = Number(partySize) - 4;
    return Object.fromEntries(DIFFICULTY_KEYS.map(difficulty => [
      difficulty,
      Math.max(0, BASE_ENCOUNTER_BUDGETS[difficulty] + CHARACTER_ADJUSTMENTS[difficulty] * extraCharacters)
    ]));
  }

  function xpForDelta(delta, pwol) {
    const map = pwol ? PWOL_XP_MAP : STANDARD_XP_MAP;
    const range = pwol ? 7 : 4;
    const bounded = Math.max(-range, Math.min(range, delta));
    return map[String(bounded)] || 0;
  }

  function calculateXP(partyLevel, partySize, npcLevels, hazards, pwol) {
    const result = game.pf2e.gm.calculateXP(partyLevel, partySize, npcLevels, hazards, { pwol: pwol });
    return { ...result, encounterBudgets: encounterBudgetsForParty(partySize) };
  }

  function calculateXPWithHpBoost(partyLevel, partySize, npcLevels, hpPercents, hazards, pwol) {
    const result = calculateXP(partyLevel, partySize, npcLevels, hazards, pwol);
    const surcharge = Math.round(npcLevels.reduce((sum, level, index) =>
      sum + singleNpcXP(level, partyLevel, pwol) * (Number(hpPercents[index]) || 0) * 0.01, 0));
    const totalXP = result.totalXP + surcharge;
    const rating = ratingForTotal(totalXP, result.encounterBudgets);
    return {
      ...result,
      totalXP,
      rating,
      ratingXP: BASE_ENCOUNTER_BUDGETS[rating],
      xpPerPlayer: Math.floor(totalXP / partySize * 4),
      hpSurcharge: surcharge
    };
  }

  function requiredFortifyPercent(targetXP, unboostedXP, selectedCreatureXP) {
    if (selectedCreatureXP <= 0 || targetXP <= unboostedXP) return 0;
    return Math.round(((targetXP - unboostedXP) / selectedCreatureXP) * 10000) / 100;
  }

  function singleNpcXP(level, partyLevel, pwol) {
    return xpForDelta(level - partyLevel, pwol);
  }

  function getCreatureXpOptions(partyLevel, pwol) {
    const minDelta = pwol ? -7 : -4;
    const maxDelta = pwol ? 7 : 4;
    const options = [];
    for (let delta = minDelta; delta <= maxDelta; delta++) {
      const level = partyLevel + delta;
      if (level < -1) continue;
      const xp = xpForDelta(delta, pwol);
      if (xp > 0) options.push({ delta, level, xp });
    }
    options.sort((a, b) => b.xp - a.xp || b.delta - a.delta);
    return options;
  }

  function getHazardXpOptions(partyLevel, isComplex, pwol) {
    const minDelta = isComplex && pwol ? -7 : -4;
    const maxDelta = isComplex && pwol ? 7 : 4;
    const options = [];
    for (let delta = minDelta; delta <= maxDelta; delta++) {
      const level = partyLevel + delta;
      if (level < -1) continue;
      const xp = isComplex ? xpForDelta(delta, pwol) : (SIMPLE_HAZARD_XP_MAP[String(delta)] || 0);
      if (xp > 0) options.push({ delta, level, xp, isComplex });
    }
    options.sort((a, b) => b.xp - a.xp || b.delta - a.delta);
    return options;
  }

  function hazardXpForLevel(level, partyLevel, isComplex, pwol) {
    if (isComplex) return singleNpcXP(level, partyLevel, pwol);
    const delta = Math.max(-4, Math.min(4, level - partyLevel));
    return SIMPLE_HAZARD_XP_MAP[String(delta)] || 0;
  }

  function getRemovalOptions(entities, getKey, getOption) {
    const grouped = new Map();
    for (const entity of entities) {
      const key = getKey(entity);
      const current = grouped.get(key);
      if (current) current.maxCount++;
      else grouped.set(key, { ...getOption(entity), maxCount: 1 });
    }
    return Array.from(grouped.values()).sort((a, b) => b.xp - a.xp || b.level - a.level);
  }

  function insertPlan(map, sum, plan, maxPerSum) {
    if (sum <= 0) return;
    const list = map.get(sum) || [];
    const signature = plan.parts
      .map(p => `${p.level}:${p.count}`)
      .join("|");
    if (list.some(p => p.signature === signature)) return;
    list.push({ ...plan, signature });
    list.sort((a, b) => {
      if (a.totalCount !== b.totalCount) return a.totalCount - b.totalCount;
      if (a.distinct !== b.distinct) return a.distinct - b.distinct;
      return b.sum - a.sum;
    });
    map.set(sum, list.slice(0, maxPerSum));
  }

  function buildFillPlans(target, options) {
    const targetValue = Math.max(0, Math.trunc(target));
    if (targetValue <= 0 || options.length === 0) return { exact: [], near: [], bySum: new Map() };

    const maxXp = Math.max.apply(null, options.map(o => o.xp));
    const maxCreatures = 10;
    const maxSum = targetValue + maxXp;
    const maxPerSum = 10;
    const picks = new Array(options.length).fill(0);
    const plansBySum = new Map();

    function record(sum, used) {
      if (sum <= 0 || used <= 0) return;
      const parts = [];
      for (let i = 0; i < picks.length; i++) {
        if (picks[i] > 0) {
          const o = options[i];
          parts.push({
            count: picks[i], level: o.level, delta: o.delta,
            xp: o.xp, subtotal: o.xp * picks[i]
          });
        }
      }
      if (parts.length === 0) return;
      insertPlan(plansBySum, sum, {
        sum, parts, totalCount: used, distinct: parts.length
      }, maxPerSum);
    }

    function dfs(index, sum, used) {
      if (sum > maxSum || used > maxCreatures) return;
      if (index >= options.length) { record(sum, used); return; }
      const option = options[index];
      const maxByCount = maxCreatures - used;
      const maxBySum = Math.floor((maxSum - sum) / option.xp);
      const available = Number.isFinite(option.maxCount) ? option.maxCount : maxByCount;
      const maxTake = Math.max(0, Math.min(maxByCount, maxBySum, available));
      for (let take = maxTake; take >= 0; take--) {
        picks[index] = take;
        dfs(index + 1, sum + take * option.xp, used + take);
      }
      picks[index] = 0;
    }

    dfs(0, 0, 0);

    const all = [];
    plansBySum.forEach((list, sum) => {
      list.forEach(p => {
        all.push({ ...p, sum, deviation: Math.abs(sum - targetValue) });
      });
    });
    all.sort((a, b) => {
      if (a.deviation !== b.deviation) return a.deviation - b.deviation;
      if (a.totalCount !== b.totalCount) return a.totalCount - b.totalCount;
      if (a.distinct !== b.distinct) return a.distinct - b.distinct;
      return b.sum - a.sum;
    });
    return {
      exact: all.filter(p => p.deviation === 0).slice(0, 12),
      near: all.filter(p => p.deviation > 0).slice(0, 8),
      bySum: plansBySum
    };
  }

  function buildAdjustOptions(state) {
    const options = [];
    state.npcs.forEach((npc, idx) => {
      const fromAdj = npc.previewAdjustment;
      const fromLevel = effectiveLevel(npc.baseLevel, fromAdj);
      const fromBaseXP = singleNpcXP(fromLevel, state.partyLevel, state.pwol);
      const fromXP = fromBaseXP + Math.round(fromBaseXP * npc.previewHpPercent * 0.01);
      ["weak", "normal", "elite"].forEach(toAdj => {
        if (toAdj === fromAdj) return;
        const toLevel = effectiveLevel(npc.baseLevel, toAdj);
        if (toLevel < -1) return;
        const toBaseXP = singleNpcXP(toLevel, state.partyLevel, state.pwol);
        const toXP = toBaseXP + Math.round(toBaseXP * npc.previewHpPercent * 0.01);
        const deltaXP = toXP - fromXP;
        if (deltaXP === 0) return;
        options.push({
          npcIdx: idx, npcName: npc.name,
          fromAdj, toAdj, fromLevel, toLevel,
          fromXP, toXP, deltaXP
        });
      });
    });
    return options;
  }

  function buildAdjustmentCandidates(adjOptions, maxAdjust, maxPerState = 3) {
    const byNpc = new Map();
    adjOptions.forEach(option => {
      if (!byNpc.has(option.npcIdx)) byNpc.set(option.npcIdx, []);
      byNpc.get(option.npcIdx).push(option);
    });
    let states = new Map([["0:0", [{ sum: 0, picked: [] }]]]);

    function insert(map, candidate) {
      const key = `${candidate.picked.length}:${candidate.sum}`;
      const list = map.get(key) || [];
      const signature = candidate.picked.map(option => `${option.npcIdx}:${option.toAdj}`).join("|");
      if (list.some(entry => entry.signature === signature)) return;
      list.push({ ...candidate, signature });
      map.set(key, list.slice(0, maxPerState));
    }

    byNpc.forEach(options => {
      const next = new Map();
      states.forEach(list => list.forEach(candidate => {
        insert(next, candidate);
        if (candidate.picked.length >= maxAdjust) return;
        options.forEach(option => insert(next, {
          sum: candidate.sum + option.deltaXP,
          picked: [...candidate.picked, option]
        }));
      }));
      states = next;
    });

    const candidates = [];
    states.forEach(list => list.forEach(candidate => {
      if (candidate.picked.length > 0) candidates.push(candidate);
    }));
    return candidates;
  }

  function buildAdjustPlans(targetGap, adjOptions, maxAdjust, maxResults) {
    if (adjOptions.length === 0) return { exact: [], near: [] };
    const raw = buildAdjustmentCandidates(adjOptions, maxAdjust).map(candidate => ({
      ...candidate,
      deviation: Math.abs(candidate.sum - targetGap),
      count: candidate.picked.length
    }));

    function dedupSorted(arr) {
      const seen = new Set();
      const unique = [];
      for (const p of arr) {
        const sig = p.picked.map(o => `${o.npcIdx}:${o.toAdj}`).sort().join("|");
        if (!seen.has(sig)) { seen.add(sig); unique.push(p); }
      }
      return unique;
    }

    const exact = raw.filter(p => p.deviation === 0);
    exact.sort((a, b) => a.count - b.count || Math.abs(a.sum) - Math.abs(b.sum));
    const near = raw.filter(p => p.deviation > 0);
    near.sort((a, b) => a.deviation - b.deviation || a.count - b.count);
    return {
      exact: dedupSorted(exact).slice(0, maxResults),
      near: dedupSorted(near).slice(0, maxResults)
    };
  }

  function buildCompositePlans(targetGap, adjOptions, addPlansResult, isAdd, maxAdjust, maxResults) {
    if (!adjOptions || adjOptions.length === 0) return { exact: [], near: [] };
    const addBySum = (addPlansResult && addPlansResult.bySum) || new Map();
    if (addBySum.size === 0) return { exact: [], near: [] };

    const addSums = [];
    addBySum.forEach((_, sum) => { if (sum > 0) addSums.push(sum); });
    addSums.sort((a, b) => a - b);

    const addDirection = isAdd ? 1 : -1;
    const allComposite = [];

    function tryCombineWithAdds(adjustsPicked, adjustSum) {
      const addNeeded = (targetGap - adjustSum) * addDirection;
      const ranked = addSums
        .map(s => ({ sum: s, dev: Math.abs(s - addNeeded) }))
        .sort((a, b) => a.dev - b.dev)
        .slice(0, 4);
      ranked.forEach(cs => {
        const plansForSum = addBySum.get(cs.sum) || [];
        plansForSum.slice(0, 2).forEach(ap => {
          const totalSum = adjustSum + ap.sum * addDirection;
          allComposite.push({
            adjustsPicked: adjustsPicked.slice(),
            addParts: ap.parts,
            adjustSum,
            addSum: ap.sum,
            addDirection,
            totalSum,
            adjustCount: adjustsPicked.length,
            addCount: ap.totalCount,
            totalCount: adjustsPicked.length + ap.totalCount,
            deviation: Math.abs(totalSum - targetGap)
          });
        });
      });
    }

    buildAdjustmentCandidates(adjOptions, maxAdjust, 2).forEach(candidate => {
      tryCombineWithAdds(candidate.picked, candidate.sum);
    });

    allComposite.sort((a, b) => {
      if (a.deviation !== b.deviation) return a.deviation - b.deviation;
      if (a.totalCount !== b.totalCount) return a.totalCount - b.totalCount;
      return a.adjustCount - b.adjustCount;
    });

    const seen = new Set();
    const unique = [];
    allComposite.forEach(p => {
      if (p.addCount === 0) return;
      const adjSig = p.adjustsPicked.map(o => `${o.npcIdx}:${o.toAdj}`).sort().join("|");
      const addSig = p.addParts.map(q => `${q.level}:${q.count}`).sort().join("|");
      const sig = `${adjSig}/${addSig}`;
      if (!seen.has(sig)) { seen.add(sig); unique.push(p); }
    });

    return {
      exact: unique.filter(p => p.deviation === 0).slice(0, maxResults),
      near: unique.filter(p => p.deviation > 0).slice(0, Math.max(2, Math.floor(maxResults / 2)))
    };
  }

  function recompute(state) {
    if (!state.openingLevels) {
      state.openingLevels = state.npcs.map(n => effectiveLevel(n.baseLevel, n.currentAdjustment));
      state.openingHpPercents = state.npcs.map(n => n.currentHpPercent);
    }
    const baselineLevels = state.openingLevels;
    const baselineHpPercents = state.openingHpPercents;
    const npcLevels = state.npcs.map(n => effectiveLevel(n.baseLevel, n.previewAdjustment));
    state.npcLevels = npcLevels;
    state.baselineLevels = baselineLevels;
    const unboostedXP = calculateXP(state.partyLevel, state.partySize, npcLevels, state.hazardActors, state.pwol);
    state.baselineXP = calculateXPWithHpBoost(state.partyLevel, state.partySize, baselineLevels, baselineHpPercents, state.hazardActors, state.pwol);
    state.base4 = calculateXPWithHpBoost(state.partyLevel, 4, baselineLevels, baselineHpPercents, state.hazardActors, state.pwol);
    const baselineTarget = Math.ceil((state.base4.xpPerPlayer * state.partySize) / 4);
    state.targetTotal = state.targetMode === "custom"
      ? state.customTarget
      : DIFFICULTY_KEYS.includes(state.targetMode)
        ? unboostedXP.encounterBudgets[state.targetMode]
        : baselineTarget;
    const selectedCreatureXP = state.npcs.reduce((sum, npc, index) =>
      sum + (npc.previewHpBoost ? singleNpcXP(npcLevels[index], state.partyLevel, state.pwol) : 0), 0);
    state.fortifyPercent = requiredFortifyPercent(state.targetTotal, unboostedXP.totalXP, selectedCreatureXP);
    state.canFortify = state.targetTotal > unboostedXP.totalXP;
    state.npcs.forEach(npc => { npc.previewHpPercent = npc.previewHpBoost ? state.fortifyPercent : 0; });
    const hpPercents = state.npcs.map(n => n.previewHpPercent);
    state.xp = calculateXPWithHpBoost(state.partyLevel, state.partySize, npcLevels, hpPercents, state.hazardActors, state.pwol);
    state.gap = state.targetTotal - state.xp.totalXP;
    state.baselineGap = state.targetTotal - state.baselineXP.totalXP;
    state.options = state.gap < 0
      ? getRemovalOptions(
          state.npcs.map((npc, index) => ({ level: state.npcLevels[index], hpPercent: npc.previewHpPercent })),
          entity => `${entity.level}:${entity.hpPercent}`,
          entity => {
            const baseXP = singleNpcXP(entity.level, state.partyLevel, state.pwol);
            return {
              level: entity.level, delta: entity.level - state.partyLevel,
              xp: baseXP + Math.round(baseXP * entity.hpPercent * 0.01)
            };
          }
        )
      : getCreatureXpOptions(state.partyLevel, state.pwol);
    state.addPlans = buildFillPlans(Math.abs(state.gap), state.options);
    const simpleHazardOptions = state.gap < 0
      ? getRemovalOptions(
          state.hazards.filter(h => !h.isComplex),
          h => String(h.level),
          h => ({ level: h.level, delta: h.level - state.partyLevel, xp: hazardXpForLevel(h.level, state.partyLevel, false, state.pwol), isComplex: false })
        )
      : getHazardXpOptions(state.partyLevel, false, state.pwol);
    const complexHazardOptions = state.gap < 0
      ? getRemovalOptions(
          state.hazards.filter(h => h.isComplex),
          h => String(h.level),
          h => ({ level: h.level, delta: h.level - state.partyLevel, xp: hazardXpForLevel(h.level, state.partyLevel, true, state.pwol), isComplex: true })
        )
      : getHazardXpOptions(state.partyLevel, true, state.pwol);
    state.simpleHazardPlans = buildFillPlans(
      Math.abs(state.gap), simpleHazardOptions
    );
    state.complexHazardPlans = state.gap > 0
      ? state.addPlans
      : buildFillPlans(Math.abs(state.gap), complexHazardOptions);
    state.adjustOptions = buildAdjustOptions(state);
    state.adjustPlans = buildAdjustPlans(state.gap, state.adjustOptions, 5, 8);
    state.compositePlans = buildCompositePlans(
      state.gap, state.adjustOptions, state.addPlans, state.gap > 0, 4, 8
    );
  }


  function planActions(item) {
    if (item.kind === "adjust") return 1;
    if (item.kind === "add") return item.plan.totalCount;
    if (item.kind === "composite") return 1 + item.plan.addCount;
    if (item.kind === "simple-hazard" || item.kind === "complex-hazard") return item.plan.totalCount;
    return 0;
  }

  function kindRank(kind) {
    if (kind === "adjust") return 0;
    if (kind === "add") return 1;
    if (kind === "composite") return 2;
    if (kind === "simple-hazard") return 3;
    if (kind === "complex-hazard") return 4;
    return 3;
  }

  function getAllPlans(state, includeNear) {
    const all = [];
    state.adjustPlans.exact.forEach((p, i) => all.push({ kind: "adjust", plan: p, sourceKey: "exact", sourceIdx: i }));
    state.addPlans.exact.forEach((p, i) => all.push({ kind: "add", plan: p, sourceKey: "exact", sourceIdx: i }));
    state.compositePlans.exact.forEach((p, i) => all.push({ kind: "composite", plan: p, sourceKey: "exact", sourceIdx: i }));
    if (includeNear) {
      state.adjustPlans.near.forEach((p, i) => all.push({ kind: "adjust", plan: p, sourceKey: "near", sourceIdx: i }));
      state.addPlans.near.forEach((p, i) => all.push({ kind: "add", plan: p, sourceKey: "near", sourceIdx: i }));
      state.compositePlans.near.forEach((p, i) => all.push({ kind: "composite", plan: p, sourceKey: "near", sourceIdx: i }));
    }
    all.forEach(item => {
      item.actions = planActions(item);
      item.deviation = item.plan.deviation || 0;
    });
    all.sort((a, b) => {
      if (a.deviation !== b.deviation) return a.deviation - b.deviation;
      if (a.actions !== b.actions) return a.actions - b.actions;
      return kindRank(a.kind) - kindRank(b.kind);
    });
    return all;
  }



  function projectedTotal(state) {
    return Math.max(0, state.xp.totalXP + (state.previewActive ? state.virtualPlanDelta : 0));
  }

  function ratingForTotal(total, budgets) {
    if (total <= budgets.trivial) return "trivial";
    if (total <= budgets.low) return "low";
    if (total <= budgets.moderate) return "moderate";
    if (total <= budgets.severe) return "severe";
    return "extreme";
  }

  function renderHeader(state) {
    const targetOptions = ["baseline", ...DIFFICULTY_KEYS, "custom"].map(key =>
      `<option value="${key}"${state.targetMode === key ? " selected" : ""}>${T(`difficulty.${key}`)}</option>`
    ).join("");
    const customInput = state.targetMode === "custom"
      ? `<input type="number" class="xp-input custom-target-input" value="${state.customTarget}" min="1" step="1" title="${T("difficulty.customXP")}">`
      : "";
    return `
      <div class="xp-header">
        <div class="xp-stat">
          <div class="xp-stat-label">${T("header.partySize")}</div>
          <div class="xp-stat-value">
            <input type="number" class="xp-input party-size-input" value="${state.partySize}" min="1" step="0.5">
          </div>
        </div>
        <div class="xp-stat">
          <div class="xp-stat-label">${T("header.partyLevel")}</div>
          <div class="xp-stat-value">
            <input type="number" class="xp-input party-level-input" value="${state.partyLevel}" min="1">
          </div>
        </div>
        <div class="xp-stat target">
          <div class="xp-stat-label">${T("header.target")}</div>
          <div class="xp-stat-value target-control">
            <select class="difficulty-input">${targetOptions}</select>${customInput}
          </div>
        </div>
      </div>
    `;
  }

  function themeTraits(state) {
    return String(state.theme || "").split(",").map(value => value.trim()).filter(Boolean);
  }

  function addThemeTrait(state, value) {
    const traits = themeTraits(state);
    for (const trait of String(value || "").split(",").map(part => part.trim()).filter(Boolean)) {
      if (!traits.some(existing => existing.toLowerCase() === trait.toLowerCase())) traits.push(trait);
    }
    state.theme = traits.join(", ");
    state.themeCandidateCache = new Map();
  }

  function removeThemeTrait(state, index) {
    const traits = themeTraits(state);
    if (index < 0 || index >= traits.length) return;
    traits.splice(index, 1);
    state.theme = traits.join(", ");
    state.themeCandidateCache = new Map();
  }

  function creatureTraitOptions() {
    return Object.entries(globalThis.CONFIG?.PF2E?.creatureTraits ?? {}).map(([slug, key]) => {
      const localized = game?.i18n?.localize?.(key);
      return { slug, label: localized && localized !== key ? localized : slug };
    }).sort((a, b) => a.label.localeCompare(b.label));
  }

  function renderThemeControl(state) {
    const options = creatureTraitOptions();
    const labels = new Map(options.map(({ slug, label }) => [slug.toLowerCase(), label]));
    const cards = themeTraits(state).map((trait, index) => `
      <span class="trait-card">
        <span>${escapeHtml(labels.get(trait.toLowerCase()) ?? trait)}</span>
        <button type="button" class="trait-remove" data-trait-index="${index}"
          aria-label="${T("plans.removeTrait", { trait: escapeHtml(trait) })}" title="${T("plans.removeTrait", { trait: escapeHtml(trait) })}">
          <i class="fas fa-xmark"></i>
        </button>
      </span>
    `).join("");
    return `
      <div class="xp-theme-row">
        <label for="xp-tool-theme">${T("plans.theme")}</label>
        <div class="trait-card-list">
          ${cards}
          <div class="trait-mode" role="group" aria-label="${T("plans.themeMode")}">
            ${["or", "and"].map(mode => `<button type="button" class="trait-mode-btn${(state.themeMode || "or") === mode ? " active" : ""}"
              data-theme-mode="${mode}" aria-pressed="${(state.themeMode || "or") === mode}"
              title="${T(`plans.themeModeHint.${mode}`)}">${mode.toUpperCase()}</button>`).join("")}
          </div>
          <button id="xp-tool-theme" type="button" class="trait-add" aria-controls="xp-tool-trait-picker"
            aria-expanded="${Boolean(state.traitPickerOpen)}" title="${T("plans.addTrait")}">
            <i class="fas fa-plus"></i> ${T("plans.addTrait")}
          </button>
          ${state.traitPickerOpen ? `<div id="xp-tool-trait-picker" class="trait-picker">
            <input class="trait-search" type="search" placeholder="${T("plans.themePlaceholder")}" aria-label="${T("plans.themePlaceholder")}" autocomplete="off">
            <div class="trait-picker-options" role="listbox">${options.map(({ slug, label }) => `
            <button type="button" class="trait-option" role="option" data-trait-slug="${escapeHtml(slug)}"
              data-trait-search="${escapeHtml(`${label} ${slug}`.toLowerCase())}">${escapeHtml(label)}</button>
            `).join("")}</div>
          </div>` : ""}
        </div>
      </div>
    `;
  }

  function renderStructureControl(state) {
    const options = Object.entries(QUICK_GROUPS).map(([id, group]) =>
      `<option value="${id}"${state.quickGroup === id ? " selected" : ""}>${T(`plans.quickGroupOptions.${id}`)}${state.pwol ? "" : ` (${group.budget} XP)`}</option>`
    ).join("");
    return `
      <div class="xp-structure-control">
        <label for="xp-tool-structure">${T("plans.quickGroup")}</label>
        <select id="xp-tool-structure" class="quick-group-select${state.quickGroup && state.quickGroup !== "auto" ? " active" : ""}">
          <option value="auto"${!state.quickGroup || state.quickGroup === "auto" ? " selected" : ""}>${T("plans.quickGroupAuto")}</option>
          ${options}
        </select>
      </div>
    `;
  }

  function buildQuickGroupPlan(state) {
    const group = QUICK_GROUPS[state.quickGroup];
    if (!group || state.gap <= 0 || state.candidateLoadState !== "ready") return null;
    const parts = [];
    for (const delta of group.slots) {
      const level = state.partyLevel + delta;
      if (level < -1 || themeCandidatesAtLevel(level, state).length === 0) return null;
      const last = parts[parts.length - 1];
      if (last && last.level === level) last.count++;
      else parts.push({ level, count: 1, xp: xpForDelta(delta, state.pwol) });
    }
    const sum = parts.reduce((total, part) => total + part.count * part.xp, 0);
    return { parts, sum, totalCount: group.slots.length, deviation: Math.abs(state.gap - sum) };
  }

  function renderProgressBar(state) {
    const current = projectedTotal(state);
    const target = state.targetTotal;
    const currentRating = ratingForTotal(current, state.xp.encounterBudgets);
    const targetRating = DIFFICULTY_KEYS.includes(state.targetMode)
      ? state.targetMode
      : ratingForTotal(target, state.xp.encounterBudgets);
    const currentThreat = L("PF2E.Encounter.Budget.Threats." + currentRating);
    const targetThreat = L("PF2E.Encounter.Budget.Threats." + targetRating);
    let max = Math.max(current, target);
    if (max === 0) max = 1;
    max = max * 1.15;
    const currentPct = Math.min(100, (current / max) * 100);
    const targetPct = Math.min(100, (target / max) * 100);
    const ratio = target > 0 ? current / target : 1;
    const fillCls = ratio < 0.95 ? "under" : (ratio <= 1.05 ? "match" : "over");
    const gap = target - current;
    let gapHtml;
    if (gap === 0) gapHtml = `<span class="gap-label match">${T("gap.match")}</span>`;
    else if (gap > 0) gapHtml = `<span class="gap-label under">${T("gap.under", { n: gap })}</span>`;
    else                gapHtml = `<span class="gap-label over">${T("gap.over",  { n: Math.abs(gap) })}</span>`;
    const fortifyWarning = state.fortifyPercent > 50
      ? `<div class="fortify-warning"><i class="fas fa-triangle-exclamation"></i> ${T("hpBoost.warning", { percent: state.fortifyPercent })}</div>`
      : "";
    return `
      <div class="xp-bar-wrap">
        <div class="encounter-route">
          <div class="route-point current ${currentRating}">
            <span class="route-label">${T(state.previewActive ? "header.previewThreat" : "header.threat")}</span>
            <strong>${currentThreat}</strong><span>${current} XP</span>
          </div>
          <i class="fas fa-arrow-right route-arrow"></i>
          <div class="route-point target ${targetRating}">
            <span class="route-label">${T("header.target")}</span>
            <strong>${targetThreat}</strong><span>${target} XP</span>
          </div>
          ${gapHtml}
        </div>
        <div class="xp-bar">
          <div class="xp-bar-fill ${fillCls}" style="width:${currentPct}%"></div>
          <div class="xp-bar-target" style="left:${targetPct}%"></div>
        </div>
        ${fortifyWarning}
      </div>
    `;
  }


  function npcHasPendingChange(npc) {
    return npc.previewAdjustment !== npc.currentAdjustment ||
      Math.abs((npc.previewHpPercent || 0) - (npc.currentHpPercent || 0)) > 0.01;
  }

  function toggleAllHpBoost(npcs) {
    const enable = npcs.some(npc => !npc.previewHpBoost);
    npcs.forEach(npc => { npc.previewHpBoost = enable; });
    return enable;
  }

  function renderNpcCard(npc, idx, state) {
    const finalLevel = effectiveLevel(npc.baseLevel, npc.previewAdjustment);
    const changed = npcHasPendingChange(npc);
    const adjKey = npc.previewAdjustment;
    const baseXP = singleNpcXP(finalLevel, state.partyLevel, state.pwol);
    const npcXP = baseXP + Math.round(baseXP * npc.previewHpPercent * 0.01);
    const hpDisabled = !state.canFortify && !npc.previewHpBoost;

    const buttons = ["weak", "normal", "elite"].map(a => {
      const active = adjKey === a ? ` active adj-${a}` : "";
      return `<button type="button" class="adj-btn${active}" data-npc-idx="${idx}" data-adj="${a}" title="${ADJUSTMENTS[a].label}">${ADJUSTMENTS[a].short}</button>`;
    }).join("");

    return `
      <div class="npc-card${changed ? " changed" : ""}">
        <div class="npc-name"><button type="button" class="npc-sheet-link" data-npc-idx="${idx}" title="${T("npc.openSheet")}">${escapeHtml(npc.name)}</button>${changed ? ' <span class="changed-dot">●</span>' : ""}</div>
        <div class="npc-level ${adjKey}">Lv ${finalLevel}</div>
        <div class="npc-xp">${npcXP} XP</div>
        <div class="adj-toggle">${buttons}</div>
        <button type="button" class="hp-boost-btn${npc.previewHpBoost ? " active" : ""}" data-npc-idx="${idx}" title="${T("hpBoost.title", { percent: npc.previewHpPercent })}"${hpDisabled ? " disabled" : ""}>${npc.previewHpBoost ? T("hpBoost.active", { percent: npc.previewHpPercent }) : T("hpBoost.short")}</button>
      </div>
    `;
  }

  function renderNpcSection(state) {
    const hasContent = state.npcs.length > 0 || state.hazards.length > 0 ||
      (state.previewEntities || []).some(entity => entity.action === "add" && entity.kind === "creature");
    if (!hasContent) {
      return `<details open><summary>${T("npc.selectedUnits")}</summary><div class="details-body"><p class="empty-msg">${T("npc.empty")}</p></div></details>`;
    }
    const npcsHtml = state.npcs.map((n, i) => renderNpcCard(n, i, state)).join("");
    const allHpBoosted = state.npcs.length > 0 && state.npcs.every(npc => npc.previewHpBoost);
    const anyHpBoosted = state.npcs.some(npc => npc.previewHpBoost);
    const bulkHpButton = state.npcs.length > 0
      ? `<div class="npc-column-head">
          <span>${T("npc.creature")}</span><span>${T("npc.level")}</span><span>${T("npc.xp")}</span>
          <span>${T("npc.template")}</span>
          <button type="button" class="hp-boost-all-btn${allHpBoosted ? " active" : ""}" title="${T("hpBoost.allTitle")}"${!state.canFortify && !anyHpBoosted ? " disabled" : ""}>${allHpBoosted ? T("hpBoost.clearAll") : T("hpBoost.selectAll")}</button>
        </div>`
      : "";
    const previewCreatures = (state.previewEntities || []).filter(entity => entity.action === "add" && entity.kind === "creature");
    const previewCreaturesHtml = previewCreatures.map(entity => `
      <div class="npc-card preview-added">
        <div class="npc-name"><i class="fas fa-plus"></i> <button type="button" class="preview-creature-link" data-creature-uuid="${escapeHtml(entity.uuid || "")}">${escapeHtml(entity.count > 1 ? `${entity.count}× ${entity.name}` : entity.name)}</button></div>
        <div class="npc-level normal">Lv ${entity.level}</div>
        <div class="npc-xp">${entity.xp * entity.count} XP</div>
        <div class="preview-tag">${T("npc.previewAdd")}</div>
      </div>
    `).join("");
    let hazardsHtml = "";
    if (state.hazards.length > 0) {
      hazardsHtml = `<div class="hazard-list"><strong>${T("npc.hazardsLabel")}</strong>${
        state.hazards.map(h => `<span>${escapeHtml(h.name)} Lv ${h.level} (${T(h.isComplex ? "plans.complexHazard" : "plans.simpleHazard")})</span>`).join("")
      }</div>`;
    }
    const changedCount = state.npcs.filter(npcHasPendingChange).length;
    const previewCount = previewCreatures.reduce((sum, entity) => sum + entity.count, 0);
    const summaryExtra = (changedCount > 0 ? ` <span class="pending-tag">${T("npc.pendingApply", { n: changedCount })}</span>` : "") +
      (previewCount > 0 ? ` <span class="preview-count-tag">${T("npc.previewAddN", { n: previewCount })}</span>` : "");
    const summaryBody = state.hazards.length > 0
      ? T("npc.summaryWithHazards", { npcs: state.npcs.length, hazards: state.hazards.length })
      : T("npc.summary", { npcs: state.npcs.length });
    const summary = `${T("npc.selectedUnits")} (${summaryBody})${summaryExtra}`;
    return `<details open><summary>${summary}</summary><div class="details-body">${bulkHpButton}${npcsHtml}${previewCreaturesHtml}${hazardsHtml}</div></details>`;
  }


  function creatureCandidateFor(part, state, seed, partIndex) {
    const candidates = themeCandidatesAtLevel(part.level, state);
    if (state.gap <= 0 || !candidates || candidates.length === 0) return null;
    return candidates[((seed || 0) + (partIndex || 0)) % candidates.length];
  }

  function themeCandidateScore(candidate, terms, mode) {
    const name = String(candidate.name || "").toLowerCase();
    const text = String(candidate.searchText || "").toLowerCase();
    const traits = candidate.traits || [];
    const traitSet = new Set(traits.map(trait => String(trait).toLowerCase()));
    if (mode === "and") return terms.every(term => traitSet.has(term)) ? terms.length * 10 : 0;
    const scores = terms.map(term => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(^|[^a-z])${escaped}(s|es|ies)?([^a-z]|$)`, "i");
      if (traits.some(trait => pattern.test(String(trait)))) return 10;
      if (pattern.test(name)) return 7;
      return pattern.test(text) ? 2 : 0;
    });
    return scores.reduce((sum, score) => sum + score, 0);
  }

  function themeCandidatesAtLevel(level, state) {
    const candidates = state.creatureCandidatesByLevel && state.creatureCandidatesByLevel.get(level);
    if (!candidates || !state.theme || !state.theme.trim()) return candidates || [];
    const mode = state.themeMode === "and" ? "and" : "or";
    const key = `${state.theme.toLowerCase()}|${mode}|${level}`;
    state.themeCandidateCache ||= new Map();
    if (state.themeCandidateCache.has(key)) return state.themeCandidateCache.get(key);
    const terms = themeTraits(state).map(trait => trait.toLowerCase());
    const matches = candidates.map(candidate => ({ candidate, score: themeCandidateScore(candidate, terms, mode) }))
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(result => result.candidate);
    state.themeCandidateCache.set(key, matches);
    return matches;
  }

  function planMatchesTheme(item, state) {
    if (!state.theme || !state.theme.trim() || state.gap <= 0 || state.candidateLoadState !== "ready") return true;
    const parts = item.kind === "add" ? item.plan.parts :
      item.kind === "composite" && item.plan.addDirection > 0 ? item.plan.addParts : [];
    return parts.every(part => themeCandidatesAtLevel(part.level, state).length > 0);
  }

  function creaturePartsDesc(parts, state, seed) {
    return parts.map((part, partIndex) => {
      if (state.gap < 0) {
        const names = state.npcs
          .filter(npc => effectiveLevel(npc.baseLevel, npc.previewAdjustment) === part.level)
          .slice(0, part.count)
          .map(npc => npc.name);
        if (names.length === part.count) return names.join(" + ");
      }
      const candidates = themeCandidatesAtLevel(part.level, state);
      const candidate = creatureCandidateFor(part, state, seed, partIndex);
      if (candidate) {
        return T("plans.creatureCandidate", {
          count: part.count, name: candidate.name, level: part.level, matches: candidates.length
        });
      }
      return `${part.count}× Lv ${part.level}`;
    }).join(" + ");
  }

  function planDesc(item, state) {
    const kind = item.kind;
    const plan = item.plan;
    if (kind === "add") {
      const parts = creaturePartsDesc(plan.parts, state, item.sourceIdx);
      if (item.sourceKey === "structure") return T("plans.quickGroupDesc", {
        name: T(`plans.quickGroupOptions.${state.quickGroup}`), parts
      });
      return T(state.gap > 0 ? "plans.addDesc" : "plans.removeDesc", { parts });
    }
    if (kind === "adjust") return adjustDesc(plan.picked);
    if (kind === "simple-hazard" || kind === "complex-hazard") {
      const parts = plan.parts.map(p => `${p.count}× Lv ${p.level}`).join(" + ");
      const type = kind === "complex-hazard" ? T("plans.complexHazard") : T("plans.simpleHazard");
      return T(state.gap > 0 ? "plans.addHazardDesc" : "plans.removeHazardDesc", { type, parts });
    }
    if (kind === "composite") {
      const adj = adjustDesc(plan.adjustsPicked);
      const adds = creaturePartsDesc(plan.addParts, state, item.sourceIdx);
      const add = T(state.gap > 0 ? "plans.addDesc" : "plans.removeDesc", { parts: adds });
      return T("plans.compositeDesc", { adjust: adj, add });
    }
    return "";
  }

  function adjustDesc(picked) {
    if (!picked || picked.length === 0) return "";
    const fmt = (op) => ({ name: op.npcName, to: ADJUSTMENTS[op.toAdj].label });
    if (picked.length === 1) return T("plans.adjustDescOne", fmt(picked[0]));
    if (picked.length === 2) {
      return T("plans.adjustDescTwo", {
        a: picked[0].npcName, ta: ADJUSTMENTS[picked[0].toAdj].label,
        b: picked[1].npcName, tb: ADJUSTMENTS[picked[1].toAdj].label
      });
    }
    return T("plans.adjustDescMore", { ...fmt(picked[0]), extra: picked.length - 1 });
  }

  function planSumSigned(item, state) {
    const kind = item.kind;
    if (kind === "adjust") return item.plan.sum;
    if (kind === "composite") return item.plan.totalSum;
    return state.gap > 0 ? item.plan.sum : -item.plan.sum;
  }

  function planIconHtml(item, state) {
    const kind = item.kind;
    if (kind === "adjust") return '<i class="fas fa-sliders"></i>';
    if (kind === "composite") return '<i class="fas fa-shuffle"></i>';
    if (kind === "simple-hazard" || kind === "complex-hazard") return '<i class="fas fa-triangle-exclamation"></i>';
    return state.gap > 0 ? '<i class="fas fa-plus"></i>' : '<i class="fas fa-minus"></i>';
  }

  function planKey(item) {
    return `${item.kind}:${item.sourceKey || ""}:${item.sourceIdx ?? ""}`;
  }

  function planMatchesFilter(item, filter) {
    if (!filter || filter === "best") return true;
    if (filter === "creatures") return item.kind === "add";
    if (filter === "templates") return item.kind === "adjust";
    if (filter === "mixed") return item.kind === "composite";
    return true;
  }

  function renderPlanItem(item, state) {
    const kind = item.kind;
    const plan = item.plan;
    const sum = planSumSigned(item, state);
    const sumCls = sum >= 0 ? "positive" : "negative";
    const sumLabel = (sum >= 0 ? "+" : "") + sum;
    const ops = planActions(item);
    const desc = escapeHtml(planDesc(item, state));
    const clickable = ["adjust", "add", "composite", "simple-hazard", "complex-hazard"].includes(kind);
    const dev = plan.deviation > 0
      ? ` <span class="plan-deviation">≈${plan.deviation}</span>`
      : "";
    const titleAttr = clickable ? ` title="${T("plans.previewHint")}"` : "";
    const data = `data-plan-kind="${kind}" data-plan-source="${item.sourceKey || ""}" data-plan-idx="${item.sourceIdx != null ? item.sourceIdx : ""}"`;
    const selected = state.selectedPlanKey === planKey(item) ? " selected" : "";
    return `
      <div class="plan-row ${kind}${clickable ? " clickable" : ""}${selected}" ${data}${titleAttr}>
        <span class="plan-icon">${planIconHtml(item, state)}</span>
        <span class="plan-desc">${desc}${dev}</span>
        <span class="plan-sum ${sumCls}">${sumLabel} XP</span>
        <span class="plan-ops">${T("card.ops", { n: ops })}</span>
      </div>
    `;
  }


  function renderPlansSection(state) {
    const activeFilter = state.planFilter || "best";
    const filters = ["best", "creatures", "templates", "mixed"];
    const tabs = `<div class="plan-filters">${filters.map(filter =>
      `<button type="button" class="plan-filter${(!state.quickGroup || state.quickGroup === "auto") && activeFilter === filter ? " active" : ""}" data-plan-filter="${filter}">${T(`plans.filter.${filter}`)}</button>`
    ).join("")}${renderStructureControl(state)}</div>`;
    if (state.quickGroup && state.quickGroup !== "auto" && state.gap > 0) {
      state.structurePlan = buildQuickGroupPlan(state);
      const item = state.structurePlan
        ? renderPlanItem({ kind: "add", plan: state.structurePlan, sourceKey: "structure", sourceIdx: 0 }, state)
        : `<p class="empty-msg">${T(state.candidateLoadState === "loading" ? "plans.candidatesLoading" : "plans.quickGroupUnavailable")}</p>`;
      return `<details open><summary>${T("plans.title")}</summary><div class="details-body">
        ${tabs}<div class="plan-note">${T("plans.quickGroupNote")}</div>${item}
      </div></details>`;
    }
    if (state.gap === 0) {
      return `<details open><summary>${T("plans.title")}</summary><div class="details-body">${tabs}<p class="empty-msg success">${T("plans.done")}</p></div></details>`;
    }
    const MAX_SHOWN = 8;
    const exactAll = getAllPlans(state, false).filter(item => planMatchesFilter(item, activeFilter) && planMatchesTheme(item, state));
    let all = exactAll;
    let usedFallback = false;
    if (exactAll.length < 3) {
      all = getAllPlans(state, true).filter(item => planMatchesFilter(item, activeFilter) && planMatchesTheme(item, state));
      usedFallback = exactAll.length === 0;
    }
    if (all.length === 0) {
      const message = state.theme && state.gap > 0 && state.candidateLoadState === "ready"
        ? T("plans.noThemeMatches") : T("plans.emptyFiltered");
      return `<details open><summary>${T("plans.title")}</summary><div class="details-body">${tabs}<p class="empty-msg">${message}</p></div></details>`;
    }
    const top = all.slice(0, MAX_SHOWN);
    const summary = all.length > top.length
      ? T("plans.titleWithCount", { shown: top.length, total: all.length })
      : T("plans.title");
    const fallbackNote = usedFallback
      ? `<div class="plan-note">${T("plans.noteFallback")}</div>`
      : "";
    return `
      <details open>
        <summary>${summary}</summary>
        <div class="details-body">
          ${tabs}
          ${fallbackNote}
          ${state.candidateLoadState === "loading" && state.gap > 0 ? `<div class="plan-note"><i class="fas fa-spinner fa-spin"></i> ${T("plans.candidatesLoading")}</div>` : ""}
          ${top.map(item => renderPlanItem(item, state)).join("")}
        </div>
      </details>
    `;
  }

  function renderHazardPlansSection(state) {
    if (state.gap === 0) return "";
    const exact = [];
    state.simpleHazardPlans.exact.forEach((plan, i) => exact.push({ kind: "simple-hazard", plan, sourceKey: "exact", sourceIdx: i }));
    state.complexHazardPlans.exact.forEach((plan, i) => exact.push({ kind: "complex-hazard", plan, sourceKey: "exact", sourceIdx: i }));
    let plans = exact;
    let usedFallback = false;
    if (plans.length === 0) {
      usedFallback = true;
      plans = [];
      state.simpleHazardPlans.near.forEach((plan, i) => plans.push({ kind: "simple-hazard", plan, sourceKey: "near", sourceIdx: i }));
      state.complexHazardPlans.near.forEach((plan, i) => plans.push({ kind: "complex-hazard", plan, sourceKey: "near", sourceIdx: i }));
    }
    plans.forEach(item => {
      item.actions = planActions(item);
      item.deviation = item.plan.deviation || 0;
    });
    plans.sort((a, b) => a.deviation - b.deviation || a.actions - b.actions || kindRank(a.kind) - kindRank(b.kind));
    const top = plans.slice(0, 6);
    if (top.length === 0) return "";
    return `
      <details>
        <summary>${T("plans.hazardTitle")}</summary>
        <div class="details-body">
          ${usedFallback ? `<div class="plan-note">${T("plans.noteFallback")}</div>` : ""}
          ${top.map(item => renderPlanItem(item, state)).join("")}
        </div>
      </details>
    `;
  }


  function getReferenceTable(partyLevel, pwol) {
    const minDelta = pwol ? -7 : -4;
    const maxDelta = pwol ? 7 : 4;
    const rows = [];
    for (let delta = minDelta; delta <= maxDelta; delta++) {
      const level = partyLevel + delta;
      const xp = xpForDelta(delta, pwol);
      const exists = level >= -1;
      const roleKey = !pwol && delta >= -4 && delta <= 4 ? `ref.role.${delta >= 0 ? "p" + delta : "n" + (-delta)}` : null;
      rows.push({ delta, level, xp, exists, roleKey });
    }
    return rows;
  }

  function renderReferenceSection(state) {
    const ref = getReferenceTable(state.partyLevel, state.pwol);
    const rows = ref.map(o => {
      const rowCls = (o.delta === 0 ? " party" : "") + (!o.exists ? " missing" : "");
      const levelCell = o.exists
        ? `Lv ${o.level}`
        : `Lv ${o.level} <span class="ref-na">(N/A)</span>`;
      const role = o.roleKey ? T(o.roleKey) : "";
      return `<tr class="ref-row${rowCls}"><td>${levelCell}</td><td>${signed(o.delta)}</td><td>${o.xp}</td><td class="role">${role}</td></tr>`;
    }).join("");
    return `
      <details>
        <summary>${T("ref.title")}</summary>
        <div class="details-body">
          <table class="ref-table">
            <thead><tr><th>${T("ref.level")}</th><th>${T("ref.vsParty")}</th><th>${T("ref.xp")}</th><th>${T("ref.roleHeader")}</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="ref-note">${T("ref.note")}</div>
        </div>
      </details>
    `;
  }

  function renderActions(state) {
    const changedCount = state.npcs.filter(npcHasPendingChange).length;
    const additionCount = (state.previewEntities || []).filter(entity => entity.action === "add" && entity.kind === "creature")
      .reduce((sum, entity) => sum + entity.count, 0);
    const canApply = changedCount > 0 || additionCount > 0;
    const applyLabel = additionCount > 0
      ? changedCount > 0
        ? T("btn.applyMixed", { templates: changedCount, creatures: additionCount })
        : T("btn.applyCreatures", { n: additionCount })
      : changedCount > 0
        ? T("btn.applyN", { n: changedCount })
        : T("btn.selectPlan");
    const resetDis = canApply || state.previewActive ? "" : " disabled";
    const applyDis = canApply ? "" : " disabled";
    return `
      <div class="btn-row">
        <div class="selected-plan-summary">
          <span>${state.selectedPlanLabel ? T("plans.selected") : T("plans.selectionHint")}</span>
          ${state.selectedPlanLabel ? `<strong>${escapeHtml(state.selectedPlanLabel)}</strong>` : ""}
        </div>
        <button type="button" class="secondary" id="reset-btn"${resetDis}><i class="fas fa-rotate-left"></i> ${T("btn.reset")}</button>
        <button type="button" class="secondary" id="undo-btn"${lastAppliedBatch.length > 0 || lastAddedTokens.length > 0 ? "" : " disabled"}><i class="fas fa-clock-rotate-left"></i> ${T("btn.undo")}</button>
        <div class="spacer"></div>
        <button type="button" class="bright" id="apply-btn"${applyDis}>
          <i class="fas fa-check"></i> ${applyLabel}
        </button>
      </div>
    `;
  }

  function renderContent(state) {
    return `
      <div class="xp-tool">
        ${renderHeader(state)}
        ${renderThemeControl(state)}
        ${renderProgressBar(state)}
        ${renderNpcSection(state)}
        ${renderPlansSection(state)}
        ${renderHazardPlansSection(state)}
        ${renderReferenceSection(state)}
        ${renderActions(state)}
      </div>
    `;
  }


  async function setActorHpBoost(actor, enabled, percent = 0) {
    const flag = actor.getFlag(MODULE_ID, "hpBoost");
    if (enabled && flag) return;
    if (!enabled && !flag) return;
    const hp = actor.system.attributes.hp;
    const preparedMax = Number(hp.max);
    const sourceMax = Number(actor._source?.system?.attributes?.hp?.max ?? preparedMax);
    const derivedMaxAdjustment = preparedMax - sourceMax;
    if (enabled) {
      const damage = Math.max(0, preparedMax - Number(hp.value));
      const boostedPreparedMax = Math.ceil(preparedMax * (1 + percent / 100));
      const boostedSourceMax = boostedPreparedMax - derivedMaxAdjustment;
      await actor.update({
        "system.attributes.hp.max": boostedSourceMax,
        [`flags.${MODULE_ID}.hpBoost`]: { baseMax: preparedMax, sourceMax, preparedMax, boostedPreparedMax, percent }
      });
      await actor.update({ "system.attributes.hp.value": Math.max(0, boostedPreparedMax - damage) });
    } else {
      const basePreparedMax = Number(flag.preparedMax ?? flag.baseMax);
      const baseSourceMax = Number(flag.sourceMax ?? (basePreparedMax - derivedMaxAdjustment));
      const boostedPreparedMax = Number(flag.boostedPreparedMax ?? Math.ceil(basePreparedMax * (1 + Number(flag.percent ?? 0) / 100)));
      const damage = Math.max(0, boostedPreparedMax - Number(hp.value));
      await actor.update({ "system.attributes.hp.value": Math.max(0, basePreparedMax - damage) });
      await actor.update({ "system.attributes.hp.max": baseSourceMax });
      await actor.unsetFlag(MODULE_ID, "hpBoost");
    }
  }

  async function applyAdjustments(state) {
    const changed = state.npcs.filter(npcHasPendingChange);
    if (changed.length === 0) return { applied: 0, failed: [] };
    const failed = [];
    const undoEntries = [];
    let applied = 0;
    for (const npc of changed) {
      const actor = (npc.token && npc.token.actor) || (game.actors && game.actors.get(npc.actorId));
      if (!actor) { failed.push(npc.name); continue; }
      try {
        if (npc.currentHpBoost) await setActorHpBoost(actor, false);
        const value = npc.previewAdjustment === "normal" ? null : npc.previewAdjustment;
        if (npc.previewAdjustment !== npc.currentAdjustment) {
          if (typeof actor.applyAdjustment === "function") {
            await actor.applyAdjustment(value);
          } else {
            await actor.update({ "system.attributes.adjustment": value });
          }
        }
        if (npc.previewHpBoost) await setActorHpBoost(actor, true, npc.previewHpPercent);
        undoEntries.push({
          uuid: actor.uuid, actorId: actor.id, name: npc.name,
          adjustment: npc.currentAdjustment, hpBoost: npc.currentHpBoost, hpPercent: npc.currentHpPercent
        });
        npc.currentAdjustment = npc.previewAdjustment;
        npc.currentHpBoost = npc.previewHpBoost;
        npc.currentHpPercent = npc.previewHpPercent;
        applied++;
      } catch (e) {
        console.error(`[${MODULE_ID}] ${T("notif.applyFailed")}:`, npc.name, e);
        failed.push(npc.name);
      }
    }
    if (undoEntries.length > 0) lastAppliedBatch = undoEntries;
    return { applied, failed };
  }

  async function getOrImportCreature(uuid) {
    const existing = game.actors.find(actor => actor.getFlag(MODULE_ID, "sourceUuid") === uuid);
    if (existing) return existing;
    const source = await fromUuid(uuid);
    if (!source || source.type !== "npc" || !source.pack) throw new Error("Creature compendium actor not found");
    const pack = game.packs.get(source.pack);
    if (!pack) throw new Error("Creature compendium not found");
    const actor = await game.actors.importFromCompendium(pack, source.id, {}, { renderSheet: false });
    await actor.setFlag(MODULE_ID, "sourceUuid", uuid);
    return actor;
  }

  function getAddedTokenOrigin(state) {
    const grid = canvas.grid.size || 100;
    const sceneRect = canvas.dimensions && canvas.dimensions.sceneRect;
    const docs = state.npcs.map(npc => npc.token && (npc.token.document || npc.token)).filter(doc => doc && Number.isFinite(doc.x) && Number.isFinite(doc.y));
    if (docs.length === 0) {
      return { x: Math.round(canvas.stage.pivot.x / grid) * grid, y: Math.round(canvas.stage.pivot.y / grid) * grid };
    }
    let x = Math.max(...docs.map(doc => doc.x + (Number(doc.width) || 1) * grid)) + grid;
    let y = Math.min(...docs.map(doc => doc.y));
    if (sceneRect && x + grid * 4 > sceneRect.x + sceneRect.width) {
      x = Math.min(...docs.map(doc => doc.x));
      y = Math.max(...docs.map(doc => doc.y + (Number(doc.height) || 1) * grid)) + grid;
    }
    if (sceneRect) {
      x = Math.max(sceneRect.x, Math.min(x, sceneRect.x + sceneRect.width - grid));
      y = Math.max(sceneRect.y, Math.min(y, sceneRect.y + sceneRect.height - grid));
    }
    return { x, y };
  }

  async function applyPreviewAdditions(state) {
    const additions = (state.previewEntities || []).filter(entity => entity.action === "add" && entity.kind === "creature");
    if (additions.length === 0) return { created: [], failed: [] };
    if (!canvas.scene) return { created: [], failed: additions.map(entity => entity.name) };
    const origin = getAddedTokenOrigin(state);
    const grid = canvas.grid.size || 100;
    const tokenData = [];
    const failed = [];
    let tokenIndex = 0;
    for (const addition of additions) {
      try {
        if (!addition.uuid) throw new Error("No compendium creature match");
        const actor = await getOrImportCreature(addition.uuid);
        for (let i = 0; i < addition.count; i++) {
          const column = tokenIndex % 2;
          const row = Math.floor(tokenIndex / 2);
          const token = await actor.getTokenDocument({
            x: origin.x + column * grid * 2,
            y: origin.y + row * grid * 2
          });
          const data = token.toObject();
          delete data._id;
          tokenData.push(data);
          tokenIndex++;
        }
      } catch (error) {
        console.error(`[${MODULE_ID}] ${T("notif.addCreatureFailed")}:`, addition.name, error);
        failed.push(addition.name);
      }
    }
    let created = [];
    try {
      created = tokenData.length > 0 ? await canvas.scene.createEmbeddedDocuments("Token", tokenData) : [];
    } catch (error) {
      console.error(`[${MODULE_ID}] ${T("notif.addCreatureFailed")}:`, error);
      failed.push(...additions.map(entity => entity.name).filter(name => !failed.includes(name)));
    }
    lastAddedTokens = created.map(token => ({ sceneId: canvas.scene.id, tokenId: token.id, name: token.name }));
    return { created, failed };
  }

  async function undoLastApplication() {
    if (lastAppliedBatch.length === 0 && lastAddedTokens.length === 0) return { restored: 0, removed: 0, removedTokenIds: [], failed: [] };
    const failed = [];
    const remaining = [];
    let restored = 0;
    for (const entry of lastAppliedBatch) {
      try {
        const actor = (entry.uuid && typeof fromUuid === "function" ? await fromUuid(entry.uuid) : null) ||
          (game.actors && game.actors.get(entry.actorId));
        if (!actor) throw new Error("Actor not found");
        if (getActorHpBoost(actor)) await setActorHpBoost(actor, false);
        const value = entry.adjustment === "normal" ? null : entry.adjustment;
        if (typeof actor.applyAdjustment === "function") await actor.applyAdjustment(value);
        else await actor.update({ "system.attributes.adjustment": value });
        if (entry.hpBoost) await setActorHpBoost(actor, true, entry.hpPercent);
        restored++;
      } catch (error) {
        console.error(`[${MODULE_ID}] ${T("notif.undoFailed")}:`, entry.name, error);
        failed.push(entry.name);
        remaining.push(entry);
      }
    }
    lastAppliedBatch = remaining;
    const removedTokenIds = [];
    const remainingTokens = [];
    const tokensByScene = new Map();
    for (const entry of lastAddedTokens) {
      if (!tokensByScene.has(entry.sceneId)) tokensByScene.set(entry.sceneId, []);
      tokensByScene.get(entry.sceneId).push(entry);
    }
    for (const [sceneId, entries] of tokensByScene) {
      const scene = game.scenes.get(sceneId);
      const ids = entries.map(entry => entry.tokenId).filter(id => scene && scene.tokens.has(id));
      try {
        if (scene && ids.length > 0) await scene.deleteEmbeddedDocuments("Token", ids);
        removedTokenIds.push(...ids);
      } catch (error) {
        console.error(`[${MODULE_ID}] ${T("notif.undoAddedFailed")}:`, error);
        failed.push(...entries.map(entry => entry.name));
        remainingTokens.push(...entries);
      }
    }
    lastAddedTokens = remainingTokens;
    return { restored, removed: removedTokenIds.length, removedTokenIds, failed };
  }

  function syncNpcAdjustments(state) {
    state.npcs.forEach(npc => {
      const actor = (npc.token && npc.token.actor) || (game.actors && game.actors.get(npc.actorId));
      if (!actor) return;
      const adjustment = getActorAdjustment(actor);
      const hpBoost = getActorHpBoost(actor);
      const hpPercent = getActorHpBoostPercent(actor);
      npc.currentAdjustment = adjustment;
      npc.previewAdjustment = adjustment;
      npc.currentHpBoost = hpBoost;
      npc.previewHpBoost = hpBoost;
      npc.currentHpPercent = hpPercent;
      npc.previewHpPercent = hpPercent;
    });
    state.openingLevels = state.npcs.map(n => effectiveLevel(n.baseLevel, n.currentAdjustment));
    state.openingHpPercents = state.npcs.map(n => n.currentHpPercent);
  }


  function attachListeners(rootEl, state, refresh) {
    function clearPlanPreview() {
      state.previewActive = false;
      state.virtualPlanDelta = 0;
      state.previewEntities = [];
      state.selectedPlanKey = null;
      state.selectedPlanLabel = "";
    }

    const traitSearch = rootEl.querySelector(".trait-search");
    if (traitSearch) {
      traitSearch.addEventListener("input", () => {
        rootEl.querySelectorAll(".trait-option").forEach(option => {
          option.hidden = !option.dataset.traitSearch.includes(traitSearch.value.trim().toLowerCase());
        });
      });
      traitSearch.addEventListener("keydown", e => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          rootEl.querySelector(".trait-option:not([hidden])")?.click();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          state.traitPickerOpen = false;
          refresh();
          rootEl.querySelector(".trait-add")?.focus();
        }
      });
    }
    rootEl.querySelector(".trait-add")?.addEventListener("click", () => {
      state.traitPickerOpen = !state.traitPickerOpen;
      refresh();
      rootEl.querySelector(state.traitPickerOpen ? ".trait-search" : ".trait-add")?.focus();
    });
    rootEl.querySelectorAll(".trait-option").forEach(button => button.addEventListener("click", () => {
      clearPlanPreview();
      addThemeTrait(state, button.dataset.traitSlug);
      state.traitPickerOpen = false;
      refresh();
    }));
    rootEl.addEventListener("click", e => {
      if (state.traitPickerOpen && !e.target.closest(".trait-card-list")) {
        state.traitPickerOpen = false;
        refresh();
      }
    });
    rootEl.querySelectorAll(".trait-remove").forEach(button => button.addEventListener("click", () => {
      clearPlanPreview();
      removeThemeTrait(state, Number(button.dataset.traitIndex));
      refresh();
    }));
    rootEl.querySelectorAll(".trait-mode-btn").forEach(button => button.addEventListener("click", () => {
      if (state.themeMode === button.dataset.themeMode) return;
      clearPlanPreview();
      state.themeMode = button.dataset.themeMode;
      state.themeCandidateCache = new Map();
      refresh();
    }));
    rootEl.querySelector(".quick-group-select")?.addEventListener("change", e => {
      clearPlanPreview();
      state.quickGroup = e.target.value;
      state.structurePlan = null;
      refresh();
    });

    rootEl.querySelectorAll(".npc-sheet-link").forEach(button => {
      button.addEventListener("click", e => {
        e.preventDefault();
        const npc = state.npcs[Number(button.dataset.npcIdx)];
        const actor = npc && ((npc.token && npc.token.actor) || (game.actors && game.actors.get(npc.actorId)));
        if (actor && actor.sheet) actor.sheet.render(true);
      });
    });

    rootEl.querySelectorAll(".adj-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        e.preventDefault();
        const idx = Number(btn.dataset.npcIdx);
        const adj = btn.dataset.adj;
        if (state.npcs[idx] && ADJUSTMENTS[adj]) {
          clearPlanPreview();
          state.npcs[idx].previewAdjustment = adj;
          refresh();
        }
      });
    });

    rootEl.querySelectorAll(".hp-boost-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        e.preventDefault();
        const npc = state.npcs[Number(btn.dataset.npcIdx)];
        if (!npc) return;
        clearPlanPreview();
        npc.previewHpBoost = !npc.previewHpBoost;
        refresh();
      });
    });

    const hpBoostAllBtn = rootEl.querySelector(".hp-boost-all-btn");
    if (hpBoostAllBtn) {
      hpBoostAllBtn.addEventListener("click", e => {
        e.preventDefault();
        clearPlanPreview();
        toggleAllHpBoost(state.npcs);
        refresh();
      });
    }

    rootEl.querySelectorAll(".plan-filter").forEach(button => {
      button.addEventListener("click", e => {
        e.preventDefault();
        state.quickGroup = "auto";
        state.structurePlan = null;
        state.planFilter = button.dataset.planFilter || "best";
        refresh();
      });
    });

    rootEl.querySelectorAll(".plan-row.clickable").forEach(row => {
      row.addEventListener("click", e => {
        e.preventDefault();
        const kind = row.dataset.planKind;
        const sourceKey = row.dataset.planSource;
        const idx = Number(row.dataset.planIdx);
        let plan;
        if (kind === "adjust") plan = state.adjustPlans[sourceKey] && state.adjustPlans[sourceKey][idx];
        else if (kind === "composite") plan = state.compositePlans[sourceKey] && state.compositePlans[sourceKey][idx];
        else if (kind === "add") plan = sourceKey === "structure"
          ? state.structurePlan : state.addPlans[sourceKey] && state.addPlans[sourceKey][idx];
        else if (kind === "simple-hazard") plan = state.simpleHazardPlans[sourceKey] && state.simpleHazardPlans[sourceKey][idx];
        else if (kind === "complex-hazard") plan = state.complexHazardPlans[sourceKey] && state.complexHazardPlans[sourceKey][idx];
        if (!plan) return;
        const selectedItem = { kind, plan, sourceKey, sourceIdx: idx };
        state.selectedPlanKey = planKey(selectedItem);
        state.selectedPlanLabel = planDesc(selectedItem, state);
        state.npcs.forEach(npc => {
          npc.previewAdjustment = npc.currentAdjustment;
          npc.previewHpBoost = npc.currentHpBoost;
          npc.previewHpPercent = npc.currentHpPercent;
        });
        const picked = kind === "composite" ? plan.adjustsPicked : (kind === "adjust" ? plan.picked : []);
        for (const op of picked) {
          if (state.npcs[op.npcIdx]) state.npcs[op.npcIdx].previewAdjustment = op.toAdj;
        }
        const direction = state.gap > 0 ? 1 : -1;
        state.virtualPlanDelta = kind === "composite"
          ? plan.addSum * plan.addDirection
          : (kind === "add" || kind === "simple-hazard" || kind === "complex-hazard")
            ? plan.sum * direction
            : 0;
        const creatureParts = kind === "composite" ? plan.addParts : (kind === "add" ? plan.parts : []);
        const creatureDirection = kind === "composite" ? plan.addDirection : direction;
        state.previewEntities = creatureDirection > 0
          ? creatureParts.map((part, partIndex) => {
              const candidate = creatureCandidateFor(part, state, idx, partIndex);
              return {
                action: "add", kind: "creature", count: part.count, level: part.level, xp: part.xp,
                name: candidate ? candidate.name : T("npc.levelCreature", { level: part.level }),
                uuid: candidate ? candidate.uuid : null
              };
            })
          : [];
        state.previewActive = true;
        refresh();
      });
    });

    rootEl.querySelectorAll(".preview-creature-link").forEach(button => {
      button.addEventListener("click", async e => {
        e.preventDefault();
        e.stopPropagation();
        if (!button.dataset.creatureUuid) return;
        try {
          const actor = await fromUuid(button.dataset.creatureUuid);
          if (actor && actor.sheet) actor.sheet.render(true);
        } catch (error) {
          console.warn(`[${MODULE_ID}] ${T("notif.candidateOpenFailed")}`, error);
        }
      });
    });

    const sizeInput = rootEl.querySelector(".party-size-input");
    if (sizeInput) {
      sizeInput.addEventListener("change", e => {
        const v = clampFloat(e.target.value, state.partySize);
        if (v !== state.partySize) {
          clearPlanPreview();
          state.partySize = v;
          try { localStorage.setItem("xpMacroPartySize", String(v)); } catch (_) {}
          refresh();
        }
      });
    }

    const levelInput = rootEl.querySelector(".party-level-input");
    if (levelInput) {
      levelInput.addEventListener("change", e => {
        const v = clampInt(e.target.value, state.partyLevel);
        if (v !== state.partyLevel) {
          clearPlanPreview();
          state.partyLevel = v;
          try { localStorage.setItem("xpMacroPartyLevel", String(v)); } catch (_) {}
          refresh();
        }
      });
    }

    const difficultyInput = rootEl.querySelector(".difficulty-input");
    if (difficultyInput) {
      difficultyInput.addEventListener("change", e => {
        const value = e.target.value;
        if (value === "baseline" || value === "custom" || DIFFICULTY_KEYS.includes(value)) {
          clearPlanPreview();
          state.targetMode = value;
          try { localStorage.setItem("xpToolTargetMode", value); } catch (_) {}
          refresh();
        }
      });
    }

    const customTargetInput = rootEl.querySelector(".custom-target-input");
    if (customTargetInput) {
      customTargetInput.addEventListener("change", e => {
        clearPlanPreview();
        state.customTarget = clampInt(e.target.value, state.customTarget);
        try { localStorage.setItem("xpToolCustomTarget", String(state.customTarget)); } catch (_) {}
        refresh();
      });
    }

    rootEl.addEventListener("keydown", e => {
      if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") {
        e.preventDefault();
        e.target.blur();
      }
    });

    const resetBtn = rootEl.querySelector("#reset-btn");
    if (resetBtn && !resetBtn.disabled) {
      resetBtn.addEventListener("click", () => {
        clearPlanPreview();
        state.npcs.forEach(n => {
          n.previewAdjustment = n.currentAdjustment;
          n.previewHpBoost = n.currentHpBoost;
          n.previewHpPercent = n.currentHpPercent;
        });
        refresh();
      });
    }

    const undoBtn = rootEl.querySelector("#undo-btn");
    if (undoBtn && !undoBtn.disabled) {
      undoBtn.addEventListener("click", async () => {
        clearPlanPreview();
        undoBtn.disabled = true;
        undoBtn.textContent = T("btn.undoing");
        const result = await undoLastApplication();
        const removedIds = new Set(result.removedTokenIds);
        state.npcs = state.npcs.filter(npc => {
          const token = npc.token && (npc.token.document || npc.token);
          return !token || !removedIds.has(token.id);
        });
        syncNpcAdjustments(state);
        if (result.failed.length === 0) ui.notifications.info(T("notif.undonePlan", { templates: result.restored, creatures: result.removed }));
        else ui.notifications.warn(T("notif.partialUndo", { restored: result.restored, names: result.failed.join(", ") }));
        refresh();
      });
    }

    const applyBtn = rootEl.querySelector("#apply-btn");
    if (applyBtn && !applyBtn.disabled) {
      applyBtn.addEventListener("click", async () => {
        applyBtn.disabled = true;
        applyBtn.textContent = T("btn.applying");
        lastAppliedBatch = [];
        lastAddedTokens = [];
        const result = await applyAdjustments(state);
        const additions = await applyPreviewAdditions(state);
        for (const tokenDocument of additions.created) {
          const actor = tokenDocument.actor;
          if (!actor) continue;
          const adjustment = getActorAdjustment(actor);
          state.npcs.push({
            token: tokenDocument.object || tokenDocument, actorId: actor.id, name: tokenDocument.name || actor.name,
            baseLevel: getBaseLevel(actor), currentAdjustment: adjustment, previewAdjustment: adjustment,
            currentHpBoost: getActorHpBoost(actor), previewHpBoost: getActorHpBoost(actor),
            currentHpPercent: getActorHpBoostPercent(actor), previewHpPercent: getActorHpBoostPercent(actor)
          });
        }
        state.previewActive = false;
        state.virtualPlanDelta = 0;
        state.previewEntities = [];
        state.selectedPlanKey = null;
        state.selectedPlanLabel = "";
        const failed = [...result.failed, ...additions.failed];
        if (failed.length === 0) {
          ui.notifications.info(T("notif.appliedPlan", { templates: result.applied, creatures: additions.created.length }));
        } else {
          ui.notifications.warn(T("notif.partialApplied", { applied: result.applied + additions.created.length, names: failed.join(", ") }));
        }
        refresh();
      });
    }
  }


  function showXPTool(state) {
    recompute(state);
    let dialog;
    const rootRef = { el: null };

    function refresh() {
      recompute(state);
      if (!rootRef.el) return;
      rootRef.el.innerHTML = renderContent(state);
      attachListeners(rootRef.el, state, refresh);
      if (dialog && dialog.setPosition) {
        try { dialog.setPosition({ height: "auto" }); } catch (_) {}
      }
    }

    dialog = new DialogClass({
      title: T("title"),
      content: renderContent(state),
      buttons: {},
      render: html => {
        const formEl = (html && html[0]) || html;
        if (!formEl) return;
        const contentEl = (formEl.querySelector && formEl.querySelector(".dialog-content")) || formEl;
        rootRef.el = contentEl;
        attachListeners(contentEl, state, refresh);
      }
    }, { width: 720, resizable: true, classes: ["pf2e-xp-tool-dialog", "pf2e-xp-tool-main-dialog"] });

    dialog.render(true);
    loadCreatureCandidates().then(byLevel => {
      state.creatureCandidatesByLevel = byLevel;
      state.themeCandidateCache = new Map();
      state.candidateLoadState = "ready";
      if (rootRef.el && rootRef.el.isConnected) refresh();
    }).catch(error => {
      state.candidateLoadState = "error";
      creatureCandidatesPromise = null;
      console.warn(`[${MODULE_ID}] ${T("notif.candidateLoadFailed")}`, error);
      if (rootRef.el && rootRef.el.isConnected) refresh();
    });
  }


  function buildNpcs(tokens) {
    return tokens.filter(t => {
      const a = t && t.actor;
      if (!a) return false;
      if (a.alliance !== "opposition") return false;
      if (a.type === "hazard") return false;
      if (a.traits && a.traits.has && a.traits.has("minion")) return false;
      return true;
    }).map(t => {
      const actor = t.actor;
      const adj = getActorAdjustment(actor);
      return {
        token: t, actorId: actor.id,
        name: t.name || actor.name,
        baseLevel: getBaseLevel(actor),
        currentAdjustment: adj,
        previewAdjustment: adj,
        currentHpBoost: getActorHpBoost(actor),
        previewHpBoost: getActorHpBoost(actor),
        currentHpPercent: getActorHpBoostPercent(actor),
        previewHpPercent: getActorHpBoostPercent(actor)
      };
    });
  }

  function buildHazards(tokens) {
    return tokens.filter(t => t && t.actor && t.actor.type === "hazard")
      .map(t => ({ name: t.name || t.actor.name, level: t.actor.level, isComplex: !!t.actor.isComplex }));
  }

  function getHazardActors(tokens) {
    return tokens.map(t => t && t.actor).filter(a => a && a.type === "hazard");
  }

  function getPCs(tokens) {
    return tokens.filter(t => {
      const a = t && t.actor;
      return !!a && a.alliance === "party" && !(a.traits && a.traits.has && a.traits.has("minion"));
    }).map(t => t.actor);
  }

  function openTool(partyLevel, partySize, npcs, hazards, hazardActors) {
    const pwol = !!(game.pf2e && game.pf2e.settings && game.pf2e.settings.variants &&
      game.pf2e.settings.variants.pwol && game.pf2e.settings.variants.pwol.enabled);
    let targetMode = "baseline";
    try { targetMode = localStorage.getItem("xpToolTargetMode") || "baseline"; } catch (_) {}
    if (targetMode !== "baseline" && targetMode !== "custom" && !DIFFICULTY_KEYS.includes(targetMode)) targetMode = "baseline";
    if (targetMode === "baseline" && npcs.length === 0 && hazards.length === 0) targetMode = "moderate";
    let customTarget = 80;
    try { customTarget = clampInt(localStorage.getItem("xpToolCustomTarget"), 80); } catch (_) {}
    showXPTool({
      partyLevel, partySize, npcs, hazards, hazardActors, pwol, targetMode, customTarget,
      creatureCandidatesByLevel: new Map(), candidateLoadState: "loading",
      previewActive: false, virtualPlanDelta: 0, previewEntities: [],
      planFilter: "best", selectedPlanKey: null, selectedPlanLabel: "", theme: "", themeMode: "or", quickGroup: "auto"
    });
  }

  function askPartyAndOpen(npcs, hazards, hazardActors) {
    const savedSize = clampFloat(localStorage.getItem("xpMacroPartySize"), 4);
    const savedLevel = clampInt(localStorage.getItem("xpMacroPartyLevel"), 1);
    const content = `
      <form>
        <div class="form-group">
          <label>${L("PF2E.Encounter.Budget.PartySize")}</label>
          <input name="party-size" type="number" value="${savedSize}" min="1" step="0.5">
        </div>
        <div class="form-group">
          <label>${L("PF2E.Encounter.Budget.PartyLevel")}</label>
          <input name="party-level" type="number" value="${savedLevel}" min="1">
        </div>
      </form>
    `;
    new DialogClass({
      title: T("partyDialogTitle"),
      content,
      buttons: {
        no: { icon: '<i class="fas fa-times"></i>', label: T("btn.cancel") },
        yes: {
          icon: '<i class="fas fa-calculator"></i>',
          label: T("btn.calculate"),
          callback: html => {
            const root = (html && html[0]) || html;
            const partySize = clampFloat(root.querySelector('[name="party-size"]').value, 4);
            const partyLevel = clampInt(root.querySelector('[name="party-level"]').value, 1);
            try {
              localStorage.setItem("xpMacroPartySize", String(partySize));
              localStorage.setItem("xpMacroPartyLevel", String(partyLevel));
            } catch (_) {}
            openTool(partyLevel, partySize, npcs, hazards, hazardActors);
          }
        }
      },
      default: "yes"
    }, { classes: ["pf2e-xp-tool-dialog", "pf2e-xp-tool-party-dialog"] }).render(true);
  }

  function openFromSelection() {
    if (!game.user || !game.user.isGM) {
      ui.notifications.warn(T("notif.gmOnly"));
      return;
    }
    const tokens = (canvas && canvas.tokens && canvas.tokens.controlled) || [];
    const npcs = buildNpcs(tokens);
    const hazards = buildHazards(tokens);
    const hazardActors = getHazardActors(tokens);
    const pcs = getPCs(tokens);
    if (pcs.length === 0) askPartyAndOpen(npcs, hazards, hazardActors);
    else openTool(pcs[0].level, pcs.length, npcs, hazards, hazardActors);
  }


  globalThis.PF2EXPTool = { open: openFromSelection };

  function injectButton(app, html) {
    const root = (html && html.length !== undefined && html[0]) ? html[0] : (html && html.querySelector ? html : null);
    if (!root || !root.querySelector) return;
    if (!game.user || !game.user.isGM) return;
    if (root.querySelector(`.${MODULE_ID}-btn`)) return;
    const target =
      root.querySelector(".directory-footer.action-buttons") ||
      root.querySelector(".directory-footer") ||
      root.querySelector("footer.action-buttons") ||
      root.querySelector("footer") ||
      root;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `${MODULE_ID}-btn`;
    btn.innerHTML = `<i class="fas fa-calculator"></i> ${T("buttonLabel")}`;
    btn.addEventListener("click", () => openFromSelection());
    target.appendChild(btn);
  }

  const I18N_FALLBACK = {
    en: {
      title: "PF2E XP Budget Tool", buttonLabel: "PF2E XP Budget", partyDialogTitle: "Party Info",
      adj: { weak: { label: "Weak", short: "W" }, normal: { label: "Normal", short: "N" }, elite: { label: "Elite", short: "E" } },
      hpBoost: {
        short: "H+", active: "H+{percent}%",
        title: "Fortify to target: +{percent}% HP; effective XP fills remaining budget",
        selectAll: "Fortify all", clearAll: "Clear fortify", allTitle: "Toggle Fortify HP for all selected enemies",
        warning: "Fortify requires +{percent}% HP. Consider selecting more enemies or adding a creature."
      },
      header: { partySize: "Size", partyLevel: "Level", target: "Target", threat: "Current threat", previewThreat: "Preview threat" },
      difficulty: {
        baseline: "Original budget", trivial: "Trivial", low: "Low", moderate: "Moderate",
        severe: "Severe", extreme: "Extreme", custom: "Custom", customXP: "Custom XP target"
      },
      progress: { currentTarget: "{current} / {target} XP", previewCurrentTarget: "Preview: {current} / {target} XP" },
      gap: { match: "On target ✓", under: "{n} short", over: "{n} over" },
      npc: {
        selectedUnits: "Selected units", empty: "No opposition or hazard token selected.",
        hazardsLabel: "Hazards: ", pendingApply: "({n} pending)",
        summary: "{npcs} creature(s)", summaryWithHazards: "{npcs} creature(s) / {hazards} hazard(s)",
        previewAdd: "PREVIEW ADD", previewAddN: "(+{n} preview)", levelCreature: "Lv {level} creature",
        creature: "Creature", level: "Level", xp: "XP", template: "Template", openSheet: "Open creature sheet"
      },
      btn: {
        cancel: "Cancel", calculate: "Calculate XP", close: "Close", reset: "Reset preview",
        applyN: "Apply {n} template change(s)", noChanges: "No pending changes", selectPlan: "Select a plan",
        applying: "Applying…", previewPlan: "Preview this plan", undo: "Undo last apply", undoing: "Undoing…",
        applyPlan: "Apply plan ({templates} templates, {creatures} creatures)",
        applyCreatures: "Add {n} creature(s)", applyMixed: "Apply {templates} change(s) + {creatures} creature(s)"
      },
      notif: {
        gmOnly: "GM-only tool",
        needSelection: "Select at least one opposition or hazard token in the scene (PCs optional)",
        applied: "Applied {n} template change(s)",
        partialApplied: "Applied {applied}; failed: {names}",
        applyFailed: "Failed to apply template", undone: "Restored {n} template change(s)",
        partialUndo: "Restored {restored}; failed: {names}", undoFailed: "Failed to undo template",
        candidateLoadFailed: "Could not load creature compendium suggestions",
        candidateOpenFailed: "Could not open suggested creature", addCreatureFailed: "Could not add suggested creature",
        undoAddedFailed: "Could not remove added creature during undo",
        appliedPlan: "Applied {templates} template change(s) and added {creatures} creature(s)",
        undonePlan: "Restored {templates} template change(s) and removed {creatures} added creature(s)"
      },
      plans: {
        title: "Suggested plans", titleWithCount: "Suggested plans ({shown}/{total})", hazardTitle: "Hazard adjustments",
        theme: "Theme / Traits", themePlaceholder: "Search traits", addTrait: "Add trait", removeTrait: "Remove {trait}",
        themeMode: "Trait matching", themeModeHint: { or: "Match any selected trait", and: "Match every selected trait" },
        noThemeMatches: "No matching creatures at required levels",
        quickGroup: "Quick Adventure Group", quickGroupAuto: "Auto suggestions",
        quickGroupDesc: "{name}: Add {parts}",
        quickGroupNote: "Adds this group to selected units. Compare its XP with the target before applying.",
        quickGroupUnavailable: "No matching creatures at every required level",
        quickGroupOptions: {
          "boss-lackeys": "Boss and Lackeys", "boss-lieutenant": "Boss and Lieutenant",
          "elite-enemies": "Elite Enemies", "lieutenant-lackeys": "Lieutenant and Lackeys",
          "mated-pair": "Mated Pair", troop: "Troop", "mook-squad": "Mook Squad"
        },
        done: "Target met, nothing to adjust ✓", empty: "No plans available", emptyFiltered: "No plans in this strategy",
        selected: "Selected plan", selectionHint: "Choose a suggestion or adjust creatures manually",
        filter: { best: "Best", creatures: "Creatures", templates: "Templates", mixed: "Mixed" },
        noteFallback: "No exact plans; showing closest approximations",
        addDesc: "Add {parts}", removeDesc: "Remove {parts}",
        adjustDescOne: "{name} → {to}",
        adjustDescTwo: "{a} → {ta}, {b} → {tb}",
        adjustDescMore: "{name} → {to} +{extra} more",
        compositeDesc: "{adjust} + {add}", previewHint: "Click row to preview",
        simpleHazard: "simple hazard", complexHazard: "complex hazard",
        addHazardDesc: "Add {type}: {parts}", removeHazardDesc: "Remove {type}: {parts}",
        creatureCandidate: "{count}× {name} · Lv {level}",
        candidatesLoading: "Loading real creature matches…", openCandidateHint: "Click to open suggested creature"
      },
      card: { ops: "{n} op(s)" },
      ref: {
        title: "Per-creature XP reference (Table 10-2)",
        level: "Level", vsParty: "vs party", xp: "XP", roleHeader: "Suggested role",
        note: "Rows marked N/A are below Lv -1: PF2e has no such creatures, shown for XP-table reference only.",
        role: {
          n4: "Low-threat lackey", n3: "Low- or moderate-threat lackey",
          n2: "Any lackey or standard creature", n1: "Any standard creature",
          p0: "Any standard creature or low-threat boss",
          p1: "Low- or moderate-threat boss", p2: "Moderate- or severe-threat boss",
          p3: "Severe- or extreme-threat boss", p4: "Extreme-threat solo boss"
        }
      }
    },
    cn: {
      title: "PF2E XP 预算工具", buttonLabel: "PF2E XP 预算工具", partyDialogTitle: "队伍信息",
      adj: { weak: { label: "弱小", short: "弱" }, normal: { label: "普通", short: "普" }, elite: { label: "精英", short: "精" } },
      hpBoost: {
        short: "血+", active: "血+{percent}%",
        title: "强化至目标：+{percent}% 生命值；有效 XP 填满剩余预算",
        selectAll: "全部强化", clearAll: "清除强化", allTitle: "切换所有已选敌人的强化生命值",
        warning: "强化需要 +{percent}% 生命值。建议选择更多敌人或添加怪物。"
      },
      header: { partySize: "人数", partyLevel: "等级", target: "目标", threat: "当前威胁", previewThreat: "预览威胁" },
      difficulty: {
        baseline: "原始预算", trivial: "微不足道", low: "低", moderate: "中等",
        severe: "严重", extreme: "极端", custom: "自定义", customXP: "自定义 XP 目标"
      },
      progress: { currentTarget: "{current} / {target} XP", previewCurrentTarget: "预览：{current} / {target} XP" },
      gap: { match: "达标 ✓", under: "缺 {n}", over: "超 {n}" },
      npc: {
        selectedUnits: "已选单位", empty: "未选择任何敌对或陷阱单位。",
        hazardsLabel: "陷阱：", pendingApply: "({n} 项待应用)",
        summary: "{npcs} 怪物", summaryWithHazards: "{npcs} 怪物 / {hazards} 陷阱",
        previewAdd: "预览添加", previewAddN: "（+{n} 预览）", levelCreature: "等级 {level} 怪物",
        creature: "怪物", level: "等级", xp: "XP", template: "模板", openSheet: "打开怪物卡"
      },
      btn: {
        cancel: "取消", calculate: "计算 XP", close: "关闭", reset: "重置预览",
        applyN: "应用 {n} 项模板更改", noChanges: "无待应用更改", selectPlan: "选择方案",
        applying: "应用中…", previewPlan: "预览此方案", undo: "撤销上次应用", undoing: "撤销中…",
        applyPlan: "应用方案（{templates} 个模板，{creatures} 个怪物）",
        applyCreatures: "添加 {n} 个怪物", applyMixed: "应用 {templates} 项更改并添加 {creatures} 个怪物"
      },
      notif: {
        gmOnly: "此工具仅限 GM 使用",
        needSelection: "请至少在场景中选中一个敌对或陷阱 Token（可额外选择 PC）",
        applied: "已应用 {n} 项模板",
        partialApplied: "已应用 {applied} 项；失败：{names}",
        applyFailed: "应用模板失败", undone: "已恢复 {n} 项模板更改",
        partialUndo: "已恢复 {restored} 项；失败：{names}", undoFailed: "撤销模板失败",
        candidateLoadFailed: "无法加载怪物图鉴建议", candidateOpenFailed: "无法打开建议的怪物",
        addCreatureFailed: "无法添加建议的怪物", undoAddedFailed: "撤销时无法移除已添加的怪物",
        appliedPlan: "已应用 {templates} 项模板更改并添加 {creatures} 个怪物",
        undonePlan: "已恢复 {templates} 项模板更改并移除 {creatures} 个已添加怪物"
      },
      plans: {
        title: "推荐方案", titleWithCount: "推荐方案 ({shown}/{total})", hazardTitle: "陷阱调整",
        theme: "主题 / 特征", themePlaceholder: "搜索特征", addTrait: "添加特征", removeTrait: "移除 {trait}",
        themeMode: "特征匹配", themeModeHint: { or: "匹配任一选定特征", and: "匹配所有选定特征" },
        noThemeMatches: "所需等级没有匹配主题的生物",
        quickGroup: "快速冒险队伍", quickGroupAuto: "自动推荐",
        quickGroupDesc: "{name}：添加 {parts}",
        quickGroupNote: "将此队伍添加到已选单位。应用前请比较经验值与目标。",
        quickGroupUnavailable: "所需等级缺少匹配的生物",
        quickGroupOptions: {
          "boss-lackeys": "首领与喽啰", "boss-lieutenant": "首领与副手",
          "elite-enemies": "精锐敌人", "lieutenant-lackeys": "副手与喽啰",
          "mated-pair": "成对敌人", troop: "小队", "mook-squad": "杂兵群"
        },
        done: "已达成目标，无需调整 ✓", empty: "无可用方案", emptyFiltered: "此策略无可用方案",
        selected: "已选方案", selectionHint: "选择推荐方案或手动调整怪物",
        filter: { best: "最佳", creatures: "怪物", templates: "模板", mixed: "混合" },
        noteFallback: "无精确方案，显示最接近的近似方案",
        addDesc: "添加 {parts}", removeDesc: "移除 {parts}",
        adjustDescOne: "{name} → {to}",
        adjustDescTwo: "{a} → {ta}, {b} → {tb}",
        adjustDescMore: "{name} → {to} +{extra} 项",
        compositeDesc: "{adjust} + {add}", previewHint: "点击行预览",
        simpleHazard: "简单陷阱", complexHazard: "复杂陷阱",
        addHazardDesc: "添加{type}：{parts}", removeHazardDesc: "移除{type}：{parts}",
        creatureCandidate: "{count}× {name} · 等级 {level}",
        candidatesLoading: "正在加载实际怪物匹配…", openCandidateHint: "点击打开建议的怪物"
      },
      card: { ops: "{n} 步" },
      ref: {
        title: "单只怪贡献参考表 (Table 10-2)",
        level: "等级", vsParty: "vs 队伍", xp: "XP", roleHeader: "建议角色",
        note: "标 N/A 的等级低于 -1，PF2e 中不存在该等级的怪物，仅作 XP 数值参考。",
        role: {
          n4: "低威胁喽啰", n3: "低/中威胁喽啰",
          n2: "任意喽啰或标准生物", n1: "任意标准生物",
          p0: "任意标准生物或低威胁 boss",
          p1: "低/中威胁 boss", p2: "中/重威胁 boss",
          p3: "重/极端威胁 boss", p4: "极端威胁独行 boss"
        }
      }
    }
  };
  const I18N_LANG_ALIAS = { "zh-CN": "cn", "zh-Hans": "cn", "zh": "cn" };

  Hooks.once("i18nInit", () => {
    const lang = (game.i18n && game.i18n.lang) || "en";
    const key = I18N_FALLBACK[lang] ? lang : (I18N_LANG_ALIAS[lang] || "en");
    game.i18n.translations.PF2EXPTool = foundry.utils.deepClone(I18N_FALLBACK[key] || I18N_FALLBACK.en);
  });

  Hooks.once("init", () => {
    console.log(`${MODULE_ID} | init`);
  });

  Hooks.on("renderMacroDirectory", injectButton);
  Hooks.on("renderActorDirectory", injectButton);
  Hooks.on("renderMacroDirectoryV2", injectButton);
  Hooks.on("renderActorDirectoryV2", injectButton);

})();

function haversineDistanceNm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371e3;

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaPhi = toRad(lat2 - lat1);
  const deltaLambda = toRad(lon2 - lon1);

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) *
      Math.cos(phi2) *
      Math.sin(deltaLambda / 2) *
      Math.sin(deltaLambda / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return (R * c) / 1852;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function getReferenceDistance(location, userLat, userLon, parsedQuery) {
  const requestedMm = parsedQuery.referenceMileMarker;
  const locationMm = location.geo?.icw_mile;

  if (typeof requestedMm === "number" && typeof locationMm === "number") {
    return {
      value: Number(Math.abs(locationMm - requestedMm).toFixed(1)),
      unit: "icw_miles",
      mode: "mile_marker"
    };
  }

  return {
    value: Number(
      haversineDistanceNm(userLat, userLon, location.geo.lat, location.geo.lon).toFixed(1)
    ),
    unit: "nm",
    mode: "geo"
  };
}

function scoreDistance(distanceValue) {
  if (distanceValue <= 1) return 1.0;
  if (distanceValue <= 3) return 0.97;
  if (distanceValue <= 5) return 0.94;
  if (distanceValue <= 10) return 0.84;
  if (distanceValue <= 15) return 0.72;
  if (distanceValue <= 20) return 0.5;
  if (distanceValue <= 25) return 0.28;
  if (distanceValue <= 30) return 0.12;
  return 0.03;
}

function scoreDraftFit(location, draftFt) {
  if (!draftFt) return 0.75;

  const maxDraft =
    location.depth?.max_recommended_draft_ft ??
    location.depth?.dockside_ft_mlw ??
    location.depth?.approach_ft_mlw ??
    location.depth?.reported_ft_mlw ??
    location.depth?.typical_ft_mlw ??
    0;

  if (!maxDraft) return 0.45;

  if (draftFt <= maxDraft - 1) return 1.0;
  if (draftFt <= maxDraft - 0.5) return 0.85;
  if (draftFt <= maxDraft) return 0.65;
  if (draftFt <= maxDraft + 0.5) return 0.3;
  return 0.05;
}

function scoreUseCase(location, intent) {
  if (intent === "provisioning_stop") {
    const walkability = location.shore_access?.walkability_score ?? 0.3;
    const groceries = location.shore_access?.groceries_nearby ? 0.15 : 0;
    const restaurants = location.shore_access?.restaurants_nearby ? 0.1 : 0;
    const laundry = location.access?.laundry ? 0.08 : 0;
    return clamp(walkability * 0.7 + groceries + restaurants + laundry, 0, 1);
  }

  return location.quality?.use_cases?.[intent] ?? 0.5;
}

function scoreConvenience(location, flags) {
  let score = location.quality?.convenience_score ?? 0.5;

  if (flags?.wantsGroceries) {
    score += location.shore_access?.groceries_nearby ? 0.15 : -0.15;
  }

  if (flags?.wantsLaundry) {
    score += location.access?.laundry ? 0.1 : -0.1;
  }

  if (flags?.wantsFuel) {
    score += location.access?.fuel ? 0.15 : -0.2;
  }

  if (flags?.wantsEasyShoreAccess) {
    score += location.shore_access?.walkability_score
      ? location.shore_access.walkability_score * 0.18
      : -0.1;
  }

  if (flags?.wantsPumpout) {
    score += location.access?.pumpout ? 0.08 : -0.08;
  }

  if (flags?.wantsRestaurant) {
    score += location.access?.restaurant || location.shore_access?.restaurants_nearby ? 0.08 : -0.04;
  }

  return clamp(score);
}

function scoreQuiet(location, flags) {
  let quiet = location.quality?.quiet_score ?? 0.5;

  if (flags?.wantsQuiet || flags?.wantsProtection) {
    quiet += 0.12;
    quiet -= (location.protection?.wake_exposure_score ?? 0.5) * 0.18;
    quiet -= (location.protection?.current_exposure_score ?? 0.5) * 0.08;
  }

  return clamp(quiet);
}

function scoreProtection(location, flags) {
  if (!flags?.wantsProtection) {
    return 0.5;
  }

  const wake = location.protection?.wake_exposure_score ?? 0.5;
  const current = location.protection?.current_exposure_score ?? 0.5;

  return clamp(1 - (wake * 0.65 + current * 0.35));
}

function scoreConfidence(location) {
  return location.status?.confidence ?? 0.5;
}

function scoreFreshness(location) {
  const last = location.status?.last_curated;
  if (!last) return 0.4;

  const lastDate = new Date(last);
  const now = new Date();
  const diffDays = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));

  if (diffDays <= 30) return 1.0;
  if (diffDays <= 90) return 0.85;
  if (diffDays <= 180) return 0.7;
  if (diffDays <= 365) return 0.5;
  return 0.3;
}

function typePenalty(location, preferredType) {
  if (!preferredType) return 1.0;
  return location.type === preferredType ? 1.0 : 0.75;
}

function overnightPolicyMultiplier(location, parsedQuery) {
  const asksOvernight =
    parsedQuery.intent === "overnight_stop" ||
    parsedQuery.intent === "quiet_night" ||
    parsedQuery.intent === "budget_stop";

  if (!asksOvernight) return 1.0;

  const overnight = location.access?.overnight_allowed;

  if (overnight === true) return 1.0;
  if (overnight === false) return 0.05;
  return 0.55;
}

function budgetPolicyMultiplier(location, parsedQuery) {
  if (parsedQuery.intent !== "budget_stop") return 1.0;

  const overnight = location.access?.overnight_allowed;

  if (overnight === true) return 1.0;
  if (overnight === false) return 0.45;
  return 0.75;
}

function pricingScore(location, parsedQuery) {
  if (parsedQuery.intent !== "budget_stop") return 0.5;

  const pricing = location.pricing?.standard;
  if (!pricing) return 0.5;

  if (pricing.dockage_rate === 0) {
    if (pricing.electric_rate && pricing.electric_rate > 0) return 0.9;
    return 1.0;
  }

  if (typeof pricing.dockage_rate === "number" && pricing.dockage_rate > 0) {
    if (pricing.rate_basis && /per ft per night/i.test(pricing.rate_basis)) {
      if (pricing.dockage_rate <= 1.5) return 0.82;
      if (pricing.dockage_rate <= 2.5) return 0.65;
      return 0.42;
    }

    if (pricing.dockage_rate <= 15) return 0.8;
    if (pricing.dockage_rate <= 30) return 0.65;
    return 0.4;
  }

  return 0.45;
}

function budgetTypeBoost(location, parsedQuery) {
  if (parsedQuery.intent !== "budget_stop") return 1.0;

  if (location.type === "free_dock") return 1.18;
  if (location.type === "low_cost_dock") return 1.12;
  if (location.type === "mooring_field") return 1.06;
  if (location.type === "town_dock") return 0.95;
  return 1.0;
}

function policyConfidencePenalty(location, parsedQuery) {
  if (
    parsedQuery.intent !== "budget_stop" &&
    parsedQuery.intent !== "overnight_stop"
  ) {
    return 1.0;
  }

  const overnight = location.access?.overnight_allowed;
  if (overnight === null || typeof overnight === "undefined") return 0.8;
  return 1.0;
}

function serviceBoost(location, flags) {
  let boost = 1.0;

  if (flags?.wantsFuel && location.access?.fuel) boost += 0.06;
  if (flags?.wantsPumpout && location.access?.pumpout) boost += 0.05;
  if (flags?.wantsLaundry && location.access?.laundry) boost += 0.04;
  if (flags?.wantsShowers && location.access?.showers) boost += 0.04;
  if (flags?.wantsWater && location.access?.water) boost += 0.03;
  if (flags?.wantsShorePower && location.access?.shore_power) boost += 0.03;
  if (flags?.wantsRestaurant && (location.access?.restaurant || location.shore_access?.restaurants_nearby)) {
    boost += 0.03;
  }

  if (flags?.wantsTown && (location.shore_access?.walkability_score ?? 0) >= 0.8) {
    boost += 0.07;
  }

  return boost;
}

function cautionPenalty(location) {
  const cautions = Array.isArray(location.cautions) ? location.cautions : [];
  if (!cautions.length) return 1.0;

  let penalty = 1.0;

  cautions.forEach((c) => {
    const severity = typeof c.severity === "number" ? c.severity : 0;
    if (severity >= 0.85) penalty -= 0.12;
    else if (severity >= 0.65) penalty -= 0.07;
    else if (severity >= 0.5) penalty -= 0.04;
  });

  return clamp(penalty, 0.7, 1.0);
}

function buildExplanation(location, parts) {
  const reasons = [];

  if (parts.distanceScore >= 0.9) reasons.push("very close to your target area");
  else if (parts.distanceScore >= 0.7) reasons.push("within a practical nearby range");
  else if (parts.distanceScore <= 0.12) reasons.push("farther from your target area");

  if (parts.draftScore >= 0.85) reasons.push("appears to fit your draft comfortably");
  else if (parts.draftScore <= 0.3) reasons.push("looks marginal for draft");

  if (parts.useCaseScore >= 0.8) reasons.push("strong match for this kind of stop");
  if (parts.convenienceScore >= 0.8) reasons.push("good shoreside convenience");
  if (parts.quietScore >= 0.75) reasons.push("better than average for a quieter stay");
  if (parts.protectionScore >= 0.75) reasons.push("better protected than average");
  if (parts.pricingScore >= 0.9) reasons.push("very strong value");
  else if (parts.pricingScore >= 0.7) reasons.push("good budget value");

  if (location.access?.overnight_allowed === false) {
    reasons.push("not suitable for overnight use");
  }

  return reasons;
}

function scoreOneLocation(location, userLat, userLon, parsedQuery) {
  const refDistance = getReferenceDistance(location, userLat, userLon, parsedQuery);
  const distanceValue = refDistance.value;

  const distanceScore = scoreDistance(distanceValue);
  const draftScore = scoreDraftFit(location, parsedQuery.draftFt);
  const useCaseScore = scoreUseCase(location, parsedQuery.intent);
  const convenienceScore = scoreConvenience(location, parsedQuery.flags);
  const quietScore = scoreQuiet(location, parsedQuery.flags);
  const protectionScore = scoreProtection(location, parsedQuery.flags);
  const confidenceScore = scoreConfidence(location);
  const freshnessScore = scoreFreshness(location);
  const typeMatch = typePenalty(location, parsedQuery.preferredType);
  const overnightMultiplier = overnightPolicyMultiplier(location, parsedQuery);
  const budgetMultiplier = budgetPolicyMultiplier(location, parsedQuery);
  const pricingScoreValue = pricingScore(location, parsedQuery);
  const budgetBoost = budgetTypeBoost(location, parsedQuery);
  const policyPenalty = policyConfidencePenalty(location, parsedQuery);
  const serviceMatchBoost = serviceBoost(location, parsedQuery.flags);
  const operationalPenalty = cautionPenalty(location);

  let finalScore =
    0.30 * distanceScore +
    0.12 * draftScore +
    0.18 * useCaseScore +
    0.12 * convenienceScore +
    0.07 * quietScore +
    0.05 * protectionScore +
    0.06 * confidenceScore +
    0.03 * freshnessScore +
    0.07 * pricingScoreValue;

  finalScore =
    finalScore *
    typeMatch *
    overnightMultiplier *
    budgetMultiplier *
    budgetBoost *
    policyPenalty *
    serviceMatchBoost *
    operationalPenalty;

  const parts = {
    distanceScore,
    draftScore,
    useCaseScore,
    convenienceScore,
    quietScore,
    protectionScore,
    confidenceScore,
    freshnessScore,
    typeMatch,
    overnightMultiplier,
    budgetMultiplier,
    pricingScore: pricingScoreValue,
    budgetBoost,
    policyPenalty,
    serviceMatchBoost,
    operationalPenalty
  };

  return {
    ...location,
    ranking: {
      distance_nm: refDistance.unit === "nm" ? distanceValue : null,
      distance_icw_miles: refDistance.unit === "icw_miles" ? distanceValue : null,
      distance_unit: refDistance.unit,
      distance_mode: refDistance.mode,
      final_score: Number(finalScore.toFixed(4)),
      explanation: buildExplanation(location, parts),
      components: parts
    }
  };
}

function rankLocations(locations, userLatOrOptions, userLon, parsedQuery, options = {}) {
  let userLat = userLatOrOptions;
  let localOptions = options || {};

  if (userLatOrOptions && typeof userLatOrOptions === "object" && !Array.isArray(userLatOrOptions)) {
    userLat = Number(userLatOrOptions.lat);
    userLon = Number(userLatOrOptions.lon);
    parsedQuery = userLatOrOptions.parsedQuery || parsedQuery || {};
    localOptions = userLatOrOptions.options || options || {};
  }

  const radiusNm = parsedQuery?.radiusNm;
  const maxDistance = radiusNm ?? localOptions.maxDistance ?? 15;

  return locations
    .filter((loc) => loc.status?.active)
    .map((loc) => scoreOneLocation(loc, userLat, userLon, parsedQuery))
    .filter((loc) => {
      if (loc.ranking.distance_unit === "icw_miles") {
        return loc.ranking.distance_icw_miles <= maxDistance;
      }
      return loc.ranking.distance_nm <= maxDistance;
    })
    .sort((a, b) => b.ranking.final_score - a.ranking.final_score);
}

module.exports = { rankLocations };
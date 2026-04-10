function parseDraft(text) {
  const match = text.match(/(\d+(\.\d+)?)\s*(foot|feet|ft)\s*(draft)?/i);
  return match ? Number(match[1]) : null;
}

function parseMileMarker(text) {
  const match = text.match(/\b(?:mile marker|mm)\s*(\d+(\.\d+)?)\b/i);
  return match ? Number(match[1]) : null;
}

function detectIntent(text) {
  const lower = text.toLowerCase();

  if (
    lower.includes("overnight") ||
    lower.includes("for the night") ||
    lower.includes("stopping for the night") ||
    lower.includes("stay the night")
  ) {
    return "overnight_stop";
  }

  if (
    lower.includes("budget") ||
    lower.includes("cheap") ||
    lower.includes("low cost") ||
    lower.includes("free")
  ) {
    return "budget_stop";
  }

  if (lower.includes("quiet")) {
    return "quiet_night";
  }

  if (
    lower.includes("fuel") ||
    lower.includes("diesel") ||
    lower.includes("gas") ||
    lower.includes("propane")
  ) {
    return "fuel_stop";
  }

  if (lower.includes("weather")) {
    return "weather_wait";
  }

  if (
    lower.includes("groceries") ||
    lower.includes("provision") ||
    lower.includes("walkable") ||
    lower.includes("restaurants") ||
    lower.includes("shore access") ||
    lower.includes("ashore")
  ) {
    return "provisioning_stop";
  }

  return "general_stop";
}

function detectRequestedTypes(text) {
  const lower = text.toLowerCase();

  const wantsMarinas = lower.includes("marina") || lower.includes("marinas");

  const wantsAnchorages = lower.includes("anchorage") || lower.includes("anchorages");

  const wantsFreeDocks =
    lower.includes("free dock") ||
    lower.includes("free docks") ||
    lower.includes("town dock") ||
    lower.includes("town docks");

  const wantsMoorings =
    lower.includes("mooring") ||
    lower.includes("moorings") ||
    lower.includes("mooring field") ||
    lower.includes("mooring fields");

  const requestedTypes = [];

  if (wantsMarinas) requestedTypes.push("marina");
  if (wantsAnchorages) requestedTypes.push("anchorage");
  if (wantsFreeDocks) requestedTypes.push("free_dock");
  if (wantsMoorings) requestedTypes.push("mooring_field");

  return requestedTypes;
}

function detectPreferredType(requestedTypes) {
  if (requestedTypes.length === 1) return requestedTypes[0];
  return null;
}

function detectFlags(text) {
  const lower = text.toLowerCase();

  return {
    wantsGroceries: lower.includes("groceries") || lower.includes("provision"),
    wantsLaundry: lower.includes("laundry"),
    wantsFuel:
      lower.includes("fuel") ||
      lower.includes("diesel") ||
      lower.includes("gas") ||
      lower.includes("propane"),
    wantsQuiet: lower.includes("quiet"),
    wantsEasyShoreAccess:
      lower.includes("walk") ||
      lower.includes("walkable") ||
      lower.includes("shore access") ||
      lower.includes("restaurants") ||
      lower.includes("ashore"),
    wantsPumpout: lower.includes("pumpout"),
    wantsShowers: lower.includes("shower") || lower.includes("showers"),
    wantsWater: /\bwater\b/.test(lower),
    wantsShorePower: lower.includes("shore power") || lower.includes("electric"),
    wantsRestaurant: lower.includes("restaurant") || lower.includes("food"),
    wantsWifi: lower.includes("wifi") || lower.includes("wi fi"),
    wantsTown: lower.includes("town") || lower.includes("village") || lower.includes("downtown"),
    wantsProtection:
      lower.includes("protected") || lower.includes("weather") || lower.includes("storm"),
    wantsEasyDocking:
      lower.includes("easy in") ||
      lower.includes("easy out") ||
      lower.includes("easy docking") ||
      lower.includes("straightforward")
  };
}

function detectQueryShape(text) {
  const lower = text.toLowerCase();

  return {
    isDirectPlaceQuery:
      /\bwhat about\b/.test(lower) ||
      /\btell me about\b/.test(lower) ||
      /\bhow is\b/.test(lower) ||
      /\bdoes [a-z0-9\s]+ have\b/.test(lower),
    isComparative:
      /\bcompare\b/.test(lower) ||
      /\bversus\b/.test(lower) ||
      /\bbetter\b/.test(lower),
    wantsFartherChoices:
      /\bfarther\b/.test(lower) ||
      /\bfurther\b/.test(lower) ||
      /\bmore choices\b/.test(lower)
  };
}

function parseQuery(text) {
  const requestedTypes = detectRequestedTypes(text);

  return {
    raw: text,
    intent: detectIntent(text),
    requestedTypes,
    preferredType: detectPreferredType(requestedTypes),
    draftFt: parseDraft(text),
    referenceMileMarker: parseMileMarker(text),
    flags: detectFlags(text),
    shape: detectQueryShape(text)
  };
}

module.exports = { parseQuery };
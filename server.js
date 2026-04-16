require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const OpenAI = require("openai");

const { parseQuery } = require("./services/queryParser");
const { rankLocations } = require("./services/rankLocations");
const { formatTopLocations } = require("./services/formatContext");
const { systemPrompt } = require("./prompts/systemPrompt");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use("/images", express.static(path.join(__dirname, "images")));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const sidebarStats = {
  totalShown: 0,
  editorialShown: 0,
  adShown: 0,
  shownByCardId: {}
};

function loadJsonFile(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Error loading JSON file: ${filePath}`, error.message);
    return fallback;
  }
}

function loadJsonFilesFromDirectory(directoryPath) {
  if (!fs.existsSync(directoryPath)) return [];

  const files = fs
    .readdirSync(directoryPath)
    .filter((file) => file.toLowerCase().endsWith(".json"));

  let allRecords = [];

  for (const file of files) {
    const fullPath = path.join(directoryPath, file);
    const data = loadJsonFile(fullPath, []);
    if (Array.isArray(data)) {
      allRecords = allRecords.concat(data);
    }
  }

  return allRecords;
}

function loadLocations() {
  const regionsDir = path.join(__dirname, "data", "regions");
  const specialSourcesDir = path.join(regionsDir, "special_sources");

  const regionalLocations = loadJsonFilesFromDirectory(regionsDir);
  const specialSourceLocations = loadJsonFilesFromDirectory(specialSourcesDir);

  return [...regionalLocations, ...specialSourceLocations];
}

function loadTipCards() {
  const candidates = [
    path.join(__dirname, "data", "sidebar", "global_tips_sidebar.json"),
    path.join(__dirname, "data", "sidebar", "global_tips_sidebar(1).json")
  ];

  for (const filePath of candidates) {
    const data = loadJsonFile(filePath, null);
    if (Array.isArray(data)) return data;
  }

  return [];
}

function loadLocalCardsForRegion(regionId) {
  if (!regionId) return [];

  const candidates = [
    path.join(__dirname, "data", "sidebar", `${regionId}_local_sidebar.json`)
  ];

  for (const filePath of candidates) {
    const data = loadJsonFile(filePath, null);
    if (Array.isArray(data)) return data;
  }

  return [];
}

function loadFallbackLocalCards() {
  const candidates = [
    path.join(__dirname, "data", "sidebar", "global_local_fallback_sidebar.json"),
    path.join(__dirname, "data", "sidebar", "global_local_fallback_sidebar(1).json"),
    path.join(__dirname, "data", "sidebar", "global_fallback_sidebar.json")
  ];

  for (const filePath of candidates) {
    const data = loadJsonFile(filePath, null);
    if (Array.isArray(data)) return data;
  }

  return [];
}

function loadPlaceAliases() {
  const candidates = [
    path.join(__dirname, "data", "place_aliases.json"),
    path.join(__dirname, "data", "place_aliases(3).json")
  ];

  for (const filePath of candidates) {
    const data = loadJsonFile(filePath, null);
    if (Array.isArray(data)) return data;
  }

  return [];
}

function loadLocationPreferences() {
  const candidates = [
    path.join(__dirname, "data", "location_preferences.json"),
    path.join(__dirname, "data", "location_preferences(2).json")
  ];

  for (const filePath of candidates) {
    const data = loadJsonFile(filePath, null);
    if (Array.isArray(data)) return data;
  }

  return [];
}

function normalizeBritishAmericanSpelling(text) {
  return (text || "")
    .replace(/\bharbour\b/g, "harbor")
    .replace(/\bcentre\b/g, "center")
    .replace(/\bmetre\b/g, "meter")
    .replace(/\bmetres\b/g, "meters")
    .replace(/\btraveller\b/g, "traveler")
    .replace(/\btravellers\b/g, "travelers")
    .replace(/\bcolour\b/g, "color")
    .replace(/\bcolours\b/g, "colors")
    .replace(/\bfavourite\b/g, "favorite")
    .replace(/\bfavourites\b/g, "favorites")
    .replace(/\bneighbour\b/g, "neighbor")
    .replace(/\bneighbours\b/g, "neighbors")
    .replace(/\bpractise\b/g, "practice");
}

function normalizeText(text) {
  const lower = String(text || "").toLowerCase();
  const standardized = normalizeBritishAmericanSpelling(lower);

  return standardized
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeAnswerText(text) {
  if (!text) return text;

  return String(text)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^\s*-\s*\*\*([^*]+)\*\*\s*$/gm, "- $1")
    .replace(/^\s*\*\*([^*]+)\*\*:\s*$/gm, "$1:")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildSearchAliases(location) {
  const aliases = new Set();

  const name = location.name || "";
  const normalizedName = normalizeText(name);
  if (normalizedName) aliases.add(normalizedName);

  if (normalizedName.includes(" anchorage")) {
    aliases.add(normalizedName.replace(" anchorage", "").trim());
  }
  if (normalizedName.includes(" marina")) {
    aliases.add(normalizedName.replace(" marina", "").trim());
  }
  if (normalizedName.includes(" yacht harbor")) {
    aliases.add(normalizedName.replace(" yacht harbor", "").trim());
  }
  if (normalizedName.includes(" yacht basin")) {
    aliases.add(normalizedName.replace(" yacht basin", "").trim());
  }
  if (normalizedName.includes(" mooring field")) {
    aliases.add(normalizedName.replace(" mooring field", "").trim());
  }

  if (location.region) aliases.add(normalizeText(location.region));
  if (location.waterbody) aliases.add(normalizeText(location.waterbody));

  if (Array.isArray(location.nearby_places)) {
    location.nearby_places.forEach((place) => aliases.add(normalizeText(place)));
  }

  if (Array.isArray(location.aliases)) {
    location.aliases.forEach((alias) => aliases.add(normalizeText(alias)));
  }

  if (Array.isArray(location.search_terms)) {
    location.search_terms.forEach((term) => aliases.add(normalizeText(term)));
  }

  return [...aliases].filter(Boolean);
}

function findDirectNameMatches(message, locations) {
  const normalizedMessage = normalizeText(message);
  if (!normalizedMessage) return [];

  const scoredMatches = locations
    .filter((loc) => loc.status?.active)
    .map((loc) => {
      const aliases = buildSearchAliases(loc);
      let score = 0;

      for (const alias of aliases) {
        if (!alias) continue;

        if (normalizedMessage === alias) {
          score = Math.max(score, 1.0);
        } else if (normalizedMessage.includes(alias)) {
          score = Math.max(score, 0.95);
        } else {
          const aliasWords = alias.split(" ").filter(Boolean);
          const hitCount = aliasWords.filter((w) => normalizedMessage.includes(w)).length;
          if (aliasWords.length >= 2 && hitCount === aliasWords.length) {
            score = Math.max(score, 0.82);
          }
        }
      }

      return { location: loc, score };
    })
    .filter((m) => m.score >= 0.82)
    .sort((a, b) => b.score - a.score);

  return scoredMatches.map((m) => m.location);
}

function mapRequestedTypeToDatasetTypes(requestedType) {
  if (requestedType === "free_dock") {
    return ["free_dock", "town_dock", "low_cost_dock", "day_dock"];
  }
  return [requestedType];
}

function filterByRequestedTypes(rankedLocations, requestedTypes) {
  if (!requestedTypes || requestedTypes.length === 0) return rankedLocations;

  const allowed = new Set(
    requestedTypes.flatMap((type) => mapRequestedTypeToDatasetTypes(type))
  );

  return rankedLocations.filter((loc) => allowed.has(loc.type));
}

function takeTopByCategory(rankedLocations, requestedTypes, perCategory = 4) {
  if (!requestedTypes || requestedTypes.length === 0) {
    return rankedLocations.slice(0, 12);
  }

  const selected = [];

  for (const requestedType of requestedTypes) {
    const allowedTypes = new Set(mapRequestedTypeToDatasetTypes(requestedType));

    const bucket = rankedLocations
      .filter((loc) => allowedTypes.has(loc.type))
      .slice(0, perCategory);

    selected.push(...bucket);
  }

  const seen = new Set();
  return selected.filter((loc) => {
    if (seen.has(loc.id)) return false;
    seen.add(loc.id);
    return true;
  });
}

function buildGroupedCountSummary(rankedLocations, requestedTypes) {
  const summary = {};

  const typesToCount =
    requestedTypes && requestedTypes.length > 0
      ? requestedTypes
      : ["marina", "anchorage", "free_dock"];

  for (const requestedType of typesToCount) {
    const allowedTypes = new Set(mapRequestedTypeToDatasetTypes(requestedType));
    const count = rankedLocations.filter((loc) => allowedTypes.has(loc.type)).length;
    summary[requestedType] = count;
  }

  return summary;
}

function absolutizeMedia(media, req) {
  if (!media) return null;

  const host = req.get("host");
  const baseUrl = `${req.protocol}://${host}`;
  const result = { ...media };

  if (result.chartlet_url && result.chartlet_url.startsWith("/")) {
    result.chartlet_url = `${baseUrl}${result.chartlet_url}`;
  }

  return result;
}

function resolveNamedPlaceCenter(message) {
  const normalizedMessage = normalizeText(message);
  if (!normalizedMessage) return null;

  const placeAliases = loadPlaceAliases();
  let bestMatch = null;

  for (const place of placeAliases) {
    const aliases = Array.isArray(place.aliases) ? place.aliases : [];

    for (const alias of aliases) {
      const normalizedAlias = normalizeText(alias);
      if (!normalizedAlias) continue;

      if (
        normalizedMessage === normalizedAlias ||
        normalizedMessage.includes(normalizedAlias)
      ) {
        if (!bestMatch || normalizedAlias.length > bestMatch.matchedAliasLength) {
          bestMatch = {
            ...place,
            matchedAliasLength: normalizedAlias.length
          };
        }
      }
    }
  }

  return bestMatch;
}

function resolveSearchCenter(message, fallbackLat, fallbackLon) {
  const namedPlace = resolveNamedPlaceCenter(message);

  if (namedPlace) {
    return {
      lat: namedPlace.lat,
      lon: namedPlace.lon,
      source: "place_alias",
      placeName: namedPlace.name,
      sidebarRegion: namedPlace.sidebarRegion || null
    };
  }

  return {
    lat: fallbackLat,
    lon: fallbackLon,
    source: "request_coords",
    placeName: null,
    sidebarRegion: null
  };
}

function inferSidebarIntent(message) {
  const q = normalizeText(message);

  if (
    /marina|marinas|dock|docks|slip|slips|stay|transient|dockage|fuel|pumpout|service|services|provisioning|laundry|restaurant|groceries|courtesy car|repair/.test(
      q
    )
  ) {
    return "marina";
  }

  if (/tip|advice|watch out|current|approach|hazard|dock into|slack tide|shoal|depth/.test(q)) {
    return "boating_tip";
  }

  return "general_location";
}

function inferOperationalIntent(message) {
  const q = normalizeText(message);

  return {
    fuel: /\bfuel\b|\bdiesel\b|\bgas\b|\bmarine gas\b|\bpropane\b/.test(q),
    services:
      /\bservice\b|\bservices\b|\bpumpout\b|\blaundry\b|\bprovisioning\b|\bwater\b|\bshore power\b|\bshowers\b|\brestrooms\b|\brepair\b|\brepairs\b/.test(
        q
      ),
    marina: /\bmarina\b|\bmarinas\b|\bdock\b|\bdocks\b|\bslip\b|\bslips\b|\btransient\b|\bdockage\b/.test(q),
    town: /\btown\b|\bwalkable\b|\brestaurants\b|\bgroceries\b|\bashore\b/.test(q),
    repairs: /\brepair\b|\brepairs\b|\byard\b|\bboatyard\b|\byacht yard\b/.test(q)
  };
}

function inferDirectInfoIntent(message) {
  const q = normalizeText(message);

  const wantsGeneralContact =
    /\bcontact information\b/.test(q) ||
    /\bcontact info\b/.test(q) ||
    /\bhow do i contact\b/.test(q) ||
    /\bhow can i contact\b/.test(q) ||
    /\bget in touch\b/.test(q) ||
    /\breach\b/.test(q);

  const wantsDetails =
    /\bdetails on\b/.test(q) ||
    /\btell me about\b/.test(q) ||
    /\bwhat about\b/.test(q) ||
    /\binfo on\b/.test(q) ||
    /\binformation on\b/.test(q) ||
    /\btransient rates at\b/.test(q);

  return {
    wantsLink: /\blink\b|\burl\b|\bwebsite\b|\bweb site\b/.test(q) || wantsGeneralContact,
    wantsPhone: /\bphone\b|\btelephone\b|\bcall\b|\bnumber\b/.test(q) || wantsGeneralContact,
    wantsEmail: /\bemail\b|\be mail\b/.test(q) || wantsGeneralContact,
    wantsVhf: /\bvhf\b|\bchannel\b/.test(q),
    wantsCamera: /\bcamera\b|\bharbor cam\b|\bharbour cam\b|\bwebcam\b|\bcam\b/.test(q),
    wantsGeneralContact,
    wantsDetails
  };
}

function isDirectInfoQuery(message) {
  const direct = inferDirectInfoIntent(message);
  return (
    direct.wantsLink ||
    direct.wantsPhone ||
    direct.wantsEmail ||
    direct.wantsVhf ||
    direct.wantsCamera ||
    direct.wantsGeneralContact ||
    direct.wantsDetails
  );
}

function inferYesNoServiceIntent(message) {
  const q = normalizeText(message);

  const asksYesNo =
    /\bis there\b/.test(q) ||
    /\bare there\b/.test(q) ||
    /\bdo they have\b/.test(q) ||
    /\bdoes it have\b/.test(q) ||
    /\bdo we have\b/.test(q) ||
    /\bdoes [a-z0-9\s]+ have\b/.test(q) ||
    /\bavailable\b/.test(q);

  const requestedServices = [];

  if (/\bpumpout\b/.test(q)) requestedServices.push("pumpout");
  if (/\bfuel\b|\bdiesel\b|\bgas\b|\bmarine gas\b|\bpropane\b/.test(q)) requestedServices.push("fuel");
  if (/\bfree dock\b|\bfree docks\b|\btown dock\b|\btown docks\b/.test(q)) requestedServices.push("free_dock");
  if (/\blaundry\b/.test(q)) requestedServices.push("laundry");
  if (/\bshowers\b|\bshower\b/.test(q)) requestedServices.push("showers");
  if (/\bwater\b/.test(q)) requestedServices.push("water");
  if (/\bshore power\b|\belectric\b/.test(q)) requestedServices.push("shore_power");
  if (/\brestaurant\b|\bfood\b/.test(q)) requestedServices.push("restaurant");
  if (/\bwifi\b|\bwi fi\b/.test(q)) requestedServices.push("wifi");

  const uniqueRequestedServices = [...new Set(requestedServices)];

  let matchMode = "all";
  if (/\bor\b/.test(q) && uniqueRequestedServices.length > 1) {
    matchMode = "any";
  }

  return {
    asksYesNo,
    requestedServices: uniqueRequestedServices,
    matchMode
  };
}

function isYesNoServiceQuery(message) {
  const info = inferYesNoServiceIntent(message);
  return Boolean(info.asksYesNo && info.requestedServices && info.requestedServices.length > 0);
}

function locationNameText(location) {
  return normalizeText([
    location.name || "",
    location.region || "",
    location.waterbody || "",
    ...(Array.isArray(location.nearby_places) ? location.nearby_places : []),
    ...(Array.isArray(location.aliases) ? location.aliases : []),
    ...(Array.isArray(location.search_terms) ? location.search_terms : [])
  ].join(" "));
}

function hasFuelSignal(location) {
  const blob = normalizeText(JSON.stringify(location));
  return /\bfuel\b|\bdiesel\b|\bgas\b|\bmarine gas\b|\bpropane\b/.test(blob);
}

function getMatchingPreferences(message, searchCenter) {
  const prefs = loadLocationPreferences();
  const q = normalizeText(message);
  const placeName = normalizeText(searchCenter?.placeName || "");
  const region = normalizeText(searchCenter?.sidebarRegion || "");

  return prefs.filter((pref) => {
    const queryMatch =
      !Array.isArray(pref.query_tags) ||
      pref.query_tags.length === 0 ||
      pref.query_tags.some((tag) => {
        const t = normalizeText(tag);
        return t && q.includes(t);
      });

    const placeMatch =
      !Array.isArray(pref.place_aliases) ||
      pref.place_aliases.length === 0 ||
      pref.place_aliases.some((alias) => {
        const a = normalizeText(alias);
        return a && (placeName.includes(a) || q.includes(a) || region.includes(a));
      });

    return queryMatch && placeMatch;
  });
}

function scorePreferenceForLocation(pref, location) {
  const haystack = normalizeText([
    location.name || "",
    location.region || "",
    location.waterbody || "",
    ...(Array.isArray(location.nearby_places) ? location.nearby_places : []),
    ...(Array.isArray(location.aliases) ? location.aliases : []),
    ...(Array.isArray(location.search_terms) ? location.search_terms : [])
  ].join(" "));

  let bonus = 0;

  const preferred = Array.isArray(pref.prefer_matches) ? pref.prefer_matches : [];
  const deprioritized = Array.isArray(pref.deprioritize_matches) ? pref.deprioritize_matches : [];

  preferred.forEach((term) => {
    const t = normalizeText(term);
    if (t && haystack.includes(t)) bonus += Number(pref.prefer_bonus || 0);
  });

  deprioritized.forEach((term) => {
    const t = normalizeText(term);
    if (t && haystack.includes(t)) bonus -= Number(pref.deprioritize_penalty || 0);
  });

  return bonus;
}

function applyQuerySpecificRankingBoosts(rankedLocations, message, searchCenter) {
  if (!Array.isArray(rankedLocations) || rankedLocations.length === 0) return rankedLocations;

  const boosted = rankedLocations.map((loc) => ({ ...loc }));
  const preferences = getMatchingPreferences(message, searchCenter);

  if (preferences.length === 0) return boosted;

  boosted.forEach((loc) => {
    let bonus = 0;
    preferences.forEach((pref) => {
      bonus += scorePreferenceForLocation(pref, loc);
    });
    loc._queryBoost = bonus;
    loc._score = Number(loc._score || 0) + bonus;
  });

  boosted.sort((a, b) => Number(b._score || 0) - Number(a._score || 0));
  return boosted;
}

function normalizePhoneHref(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return `tel:${digits}`;
  return `tel:+${digits}`;
}

function formatPhoneLink(phone) {
  const href = normalizePhoneHref(phone);
  if (!href) return null;
  return `[${phone}](${href})`;
}

function getPrimaryPhone(location) {
  return location?.contact?.phone || null;
}

function getPrimaryWebsite(location) {
  return location?.contact?.website || location?.source?.source_url || null;
}

function getPrimaryEmail(location) {
  return location?.contact?.email || null;
}

function getPrimaryVhf(location) {
  return location?.contact?.vhf || null;
}

function hasStructuredDetails(location) {
  if (!location) return false;

  return Boolean(
    location.depth ||
    location.access ||
    location.pricing ||
    location.contact ||
    location.vessel_fit ||
    location.quality
  );
}

function compareNumericHigherBetter(a, b) {
  if (typeof a !== "number" || typeof b !== "number") return null;
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

function compareNumericLowerBetter(a, b) {
  if (typeof a !== "number" || typeof b !== "number") return null;
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

function summarizeDepth(location) {
  const approach = location?.depth?.approach_ft_mlw;
  const dockside = location?.depth?.dockside_ft_mlw;
  const draft = location?.depth?.max_recommended_draft_ft;

  const parts = [];
  if (typeof approach === "number") parts.push(`approach ${approach} ft MLW`);
  if (typeof dockside === "number") parts.push(`dockside ${dockside} ft MLW`);
  if (typeof draft === "number") parts.push(`best for about ${draft} ft draft or less`);

  return parts.join("; ");
}

function summarizePricing(location) {
  const rate = location?.pricing?.standard?.dockage_rate;
  const basis = location?.pricing?.standard?.rate_basis;
  const phone = getPrimaryPhone(location);

  if (typeof rate === "number" && basis) {
    return `${location.name}: published dockage starts at $${rate.toFixed(2)} with basis "${basis}".`;
  }

  if (typeof rate === "number") {
    return `${location.name}: published dockage rate $${rate.toFixed(2)}.`;
  }

  if (phone) {
    return `${location.name}: Dockage rates are not published; please contact the marina directly for pricing. ${formatPhoneLink(phone)}`;
  }

  return `${location.name}: Dockage rates are not published; please contact the marina directly for pricing.`;
}

function summarizeServices(location) {
  const access = location?.access || {};
  const services = [];

  if (access.fuel) services.push("fuel");
  if (access.pumpout) services.push("pump-out");
  if (access.water) services.push("water");
  if (access.shore_power) services.push("shore power");
  if (access.showers) services.push("showers");
  if (access.laundry) services.push("laundry");
  if (access.pool) services.push("pool");
  if (access.restaurant) services.push("restaurant");
  if (access.wifi) services.push("Wi-Fi");
  if (access.repairs) services.push("repair capability");

  if (services.length === 0) return "No strong structured service list is published in the current record.";
  if (services.length <= 3) return services.join(", ");
  return `${services.slice(0, 5).join(", ")}.`;
}

function cleanLogbookPrefix(text) {
  if (!text) return text;

  return String(text)
    .replace(/^\s*Sail to the Sun Logbook:\s*/i, "")
    .replace(/^\s*Sail to the Sun Expert Opinion:\s*/i, "")
    .trim();
}

function extractLogbookText(location) {
  const notes = [];

  if (location?.expert_notes?.plain) notes.push(cleanLogbookPrefix(location.expert_notes.plain));

  if (location?.local_notes) {
    Object.values(location.local_notes).forEach((value) => {
      if (typeof value === "string" && value.trim()) notes.push(cleanLogbookPrefix(value));
    });
  }

  if (Array.isArray(location?.cautions)) {
    location.cautions
      .filter((c) => Number(c?.severity || 0) >= 0.85 && c?.text)
      .forEach((c) => notes.push(cleanLogbookPrefix(c.text)));
  }

  return notes.join(" ");
}

function buildDetailAnswer(location) {
  const phone = getPrimaryPhone(location);
  const website = getPrimaryWebsite(location);
  const email = getPrimaryEmail(location);
  const vhf = getPrimaryVhf(location);

  const advisory = [];
  const conditions = [];
  const marinaLines = [];
  const logbook = [];
  const summary = [];

  if (location?.cautions?.length) {
    location.cautions.slice(0, 2).forEach((c) => {
      if (c?.text) advisory.push(`- ${c.text}`);
    });
  }

  if (advisory.length === 0) {
    advisory.push("- Published fields are reasonably strong here, but confirm current rates and any operational changes directly.");
  }

  conditions.push(`- ${location.name} is a ${location.type} in ${location?.geo?.segment || location?.region || "the current area"}.`);

  const depthSummary = summarizeDepth(location);
  if (depthSummary) {
    conditions.push(`- Published depth picture: ${depthSummary}.`);
  }

  const loa = location?.vessel_fit?.max_comfortable_loa_ft;
  const bigBoat = location?.vessel_fit?.big_boat_friendly;
  const tide = location?.depth?.tidal_range_ft;

  const facts = [];
  if (typeof loa === "number") facts.push(`max comfortable LOA about ${loa} ft`);
  if (typeof tide === "number") facts.push(`tidal range about ${tide} ft`);
  if (typeof bigBoat === "boolean") facts.push(`big-boat friendly: ${bigBoat ? "yes" : "no"}`);

  if (facts.length) {
    conditions.push(`- Operational fit: ${facts.join("; ")}.`);
  }

  marinaLines.push(`- ${location.name}: ${summarizeServices(location)}`);

  if (vhf) marinaLines.push(`- VHF: ${vhf}`);
  if (phone) marinaLines.push(`- Phone: ${formatPhoneLink(phone)}`);
  if (email) marinaLines.push(`- Email: [${email}](mailto:${email})`);
  if (website) marinaLines.push(`- Website: [${website}](${website})`);

  marinaLines.push(`- ${summarizePricing(location)}`);

  const logbookText = extractLogbookText(location);
  if (logbookText) {
    logbook.push(`- ${logbookText}`);
  }

  summary.push(`- ${location.name} is the direct answer here. Use it as a serious candidate if its depth, LOA, and amenity mix fit your boat and stop style.`);

  let answer = `⚠️ Advisory:\n${advisory.join("\n")}\n\n`;
  answer += `📍 Conditions:\n${conditions.join("\n")}\n\n`;
  answer += `⚓ Marinas:\n${marinaLines.join("\n")}\n\n`;

  if (logbook.length) {
    answer += `☀️ Sail to the Sun Logbook:\n${logbook.join("\n")}\n\n`;
  }

  answer += `✔️ Summary:\n${summary.join("\n")}`;

  return sanitizeAnswerText(answer);
}

function detectComparisonQuery(message) {
  const q = normalizeText(message);

  if (!q) return false;

  return (
    /\bcompare\b/.test(q) ||
    /\bwhich marina is better\b/.test(q) ||
    /\bwhich is better\b/.test(q) ||
    (/\bbetter\b/.test(q) && /\bor\b/.test(q)) ||
    /\bvs\b/.test(q) ||
    /\bversus\b/.test(q)
  );
}

function buildComparisonCandidates(message, locations) {
  const directMatches = findDirectNameMatches(message, locations);
  const unique = [];
  const seen = new Set();

  for (const loc of directMatches) {
    if (!loc?.id || seen.has(loc.id)) continue;
    seen.add(loc.id);
    unique.push(loc);
  }

  return unique.slice(0, 4);
}

function chooseBestPairForComparison(message, locations) {
  const q = normalizeText(message);

  const exactNameMatches = locations
    .filter((loc) => loc?.status?.active)
    .filter((loc) => {
      const fullName = normalizeText(loc.name || "");
      return fullName && q.includes(fullName);
    });

  const uniqueExact = [];
  const seen = new Set();

  for (const loc of exactNameMatches) {
    if (!loc?.id || seen.has(loc.id)) continue;
    seen.add(loc.id);
    uniqueExact.push(loc);
  }

  if (uniqueExact.length >= 2) {
    uniqueExact.sort((a, b) => normalizeText(b.name).length - normalizeText(a.name).length);
    return [uniqueExact[0], uniqueExact[1]];
  }

  const candidates = buildComparisonCandidates(message, locations);
  if (candidates.length < 2) return null;

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = normalizeText(candidates[i].name);
      const b = normalizeText(candidates[j].name);
      if (a && b && q.includes(a) && q.includes(b)) {
        return [candidates[i], candidates[j]];
      }
    }
  }

  return [candidates[0], candidates[1]];
}

function buildComparisonAnswer(a, b) {
  const advisory = [];
  const conditions = [];
  const comparison = [];
  const betterFit = [];
  const logbook = [];
  const summary = [];

  const aQuiet = a?.quality?.quiet_score;
  const bQuiet = b?.quality?.quiet_score;
  const aConvenience = a?.quality?.convenience_score;
  const bConvenience = b?.quality?.convenience_score;
  const aWeather = a?.quality?.use_cases?.weather_wait;
  const bWeather = b?.quality?.use_cases?.weather_wait;
  const aWalk = a?.shore_access?.walkability_score;
  const bWalk = b?.shore_access?.walkability_score;
  const aDraft = a?.depth?.max_recommended_draft_ft;
  const bDraft = b?.depth?.max_recommended_draft_ft;
  const aLoa = a?.vessel_fit?.max_comfortable_loa_ft;
  const bLoa = b?.vessel_fit?.max_comfortable_loa_ft;

  advisory.push("- This is a direct two-stop comparison using the current structured records. Confirm rates and any operational changes directly before committing.");

  conditions.push(`- ${a.name} is in ${a?.geo?.segment || "its local area"}.`);
  conditions.push(`- ${b.name} is in ${b?.geo?.segment || "its local area"}.`);

  comparison.push(`- Depth and boat fit: ${a.name}${summarizeDepth(a) ? ` has ${summarizeDepth(a)}` : " does not publish a strong structured depth picture in this record"}; ${b.name}${summarizeDepth(b) ? ` has ${summarizeDepth(b)}` : " does not publish a strong structured depth picture in this record"}.`);

  if (typeof aLoa === "number" || typeof bLoa === "number") {
    comparison.push(`- Published size fit: ${a.name}${typeof aLoa === "number" ? ` about ${aLoa} ft max comfortable LOA` : " has no clear published max LOA in this record"}; ${b.name}${typeof bLoa === "number" ? ` about ${bLoa} ft max comfortable LOA` : " has no clear published max LOA in this record"}.`);
  }

  comparison.push(`- Services: ${a.name} offers ${summarizeServices(a)} ${b.name} offers ${summarizeServices(b)}`);

  comparison.push(`- Pricing clarity: ${summarizePricing(a)} ${summarizePricing(b)}`);

  if (typeof aConvenience === "number" && typeof bConvenience === "number") {
    const winner = compareNumericHigherBetter(aConvenience, bConvenience);
    if (winner === 1) {
      comparison.push(`- Convenience edge: ${a.name} looks more convenient in the current record.`);
    } else if (winner === -1) {
      comparison.push(`- Convenience edge: ${b.name} looks more convenient in the current record.`);
    } else {
      comparison.push(`- Convenience: these two score about the same in the current record.`);
    }
  }

  if (typeof aWalk === "number" && typeof bWalk === "number") {
    const winner = compareNumericHigherBetter(aWalk, bWalk);
    if (winner === 1) {
      comparison.push(`- Walkability and town access: ${a.name} has the stronger in-town advantage.`);
    } else if (winner === -1) {
      comparison.push(`- Walkability and town access: ${b.name} has the stronger in-town advantage.`);
    }
  }

  if (typeof aQuiet === "number" && typeof bQuiet === "number") {
    const winner = compareNumericHigherBetter(aQuiet, bQuiet);
    if (winner === 1) {
      comparison.push(`- Quiet-night edge: ${a.name} looks calmer in the current record.`);
    } else if (winner === -1) {
      comparison.push(`- Quiet-night edge: ${b.name} looks calmer in the current record.`);
    }
  }

  if (typeof aWeather === "number" && typeof bWeather === "number") {
    const winner = compareNumericHigherBetter(aWeather, bWeather);
    if (winner === 1) {
      comparison.push(`- Weather-wait edge: ${a.name} looks stronger as a weather-wait stop.`);
    } else if (winner === -1) {
      comparison.push(`- Weather-wait edge: ${b.name} looks stronger as a weather-wait stop.`);
    }
  }

  if (typeof aDraft === "number" && typeof bDraft === "number") {
    const winner = compareNumericHigherBetter(aDraft, bDraft);
    if (winner === 1) {
      betterFit.push(`- Choose ${a.name} if deeper draft margin matters more.`);
    } else if (winner === -1) {
      betterFit.push(`- Choose ${b.name} if deeper draft margin matters more.`);
    }
  }

  if (typeof aWalk === "number" && typeof bWalk === "number") {
    const winner = compareNumericHigherBetter(aWalk, bWalk);
    if (winner === 1) {
      betterFit.push(`- Choose ${a.name} if you want the stronger walkable-town feel.`);
    } else if (winner === -1) {
      betterFit.push(`- Choose ${b.name} if you want the stronger walkable-town feel.`);
    }
  }

  if (typeof aQuiet === "number" && typeof bQuiet === "number") {
    const winner = compareNumericHigherBetter(aQuiet, bQuiet);
    if (winner === 1) {
      betterFit.push(`- Choose ${a.name} if your priority is a quieter, more protected-feeling stop.`);
    } else if (winner === -1) {
      betterFit.push(`- Choose ${b.name} if your priority is a quieter, more protected-feeling stop.`);
    }
  }

  const aLog = extractLogbookText(a);
  const bLog = extractLogbookText(b);

  if (aLog) logbook.push(`- ${a.name}: ${aLog}`);
  if (bLog) logbook.push(`- ${b.name}: ${bLog}`);

  summary.push(`- Bottom line: neither is universally "better." The better stop depends on whether you care more about protection and weather-wait utility, or in-town convenience and destination value.`);

  let answer = `⚠️ Advisory:\n${advisory.join("\n")}\n\n`;
  answer += `📍 Conditions:\n${conditions.join("\n")}\n\n`;
  answer += `⚖️ Comparison:\n${comparison.join("\n")}\n\n`;

  if (betterFit.length) {
    answer += `⚓ Better fit by use case:\n${betterFit.join("\n")}\n\n`;
  }

  if (logbook.length) {
    answer += `☀️ Sail to the Sun Logbook:\n${logbook.join("\n")}\n\n`;
  }

  answer += `✔️ Summary:\n${summary.join("\n")}`;

  return sanitizeAnswerText(answer);
}

function findBestDirectLocation(message, locations) {
  const normalizedMessage = normalizeText(message);
  if (!normalizedMessage) return null;

  const exactNameMatches = locations
    .filter((loc) => loc?.status?.active)
    .filter((loc) => {
      const fullName = normalizeText(loc.name || "");
      return fullName && normalizedMessage.includes(fullName);
    });

  if (exactNameMatches.length) {
    exactNameMatches.sort(
      (a, b) => normalizeText(b.name || "").length - normalizeText(a.name || "").length
    );
    return exactNameMatches[0];
  }

  const directMatches = findDirectNameMatches(message, locations);
  if (!directMatches.length) return null;
  return directMatches[0];
}

function isAnnapolisQuery(message = "", searchCenter = null) {
  const q = normalizeText(message);
  const placeName = normalizeText(searchCenter?.placeName || "");
  const sidebarRegion = normalizeText(searchCenter?.sidebarRegion || "");

  return (
    q.includes("annapolis") ||
    q.includes("eastport") ||
    q.includes("back creek") ||
    q.includes("spa creek") ||
    placeName.includes("annapolis") ||
    sidebarRegion.includes("annapolis")
  );
}

function isFuelQuery(message = "", parsed = {}) {
  const q = normalizeText(message);
  return Boolean(
    parsed?.flags?.wantsFuel ||
    /\bfuel\b|\bdiesel\b|\bgas\b|\bmarine gas\b|\bpropane\b/.test(q)
  );
}

function isQuietQuery(message = "", parsed = {}) {
  const q = normalizeText(message);
  return Boolean(
    parsed?.flags?.wantsQuiet ||
    parsed?.flags?.wantsProtection ||
    parsed?.intent === "quiet_night" ||
    parsed?.intent === "weather_wait" ||
    /\bquiet\b|\bprotected\b|\bprotection\b|\bcalm\b|\bweather wait\b/.test(q)
  );
}

function isBroadTransientQuery(message = "", parsed = {}) {
  const q = normalizeText(message);
  return Boolean(
    parsed?.intent === "overnight_stop" ||
    /\btransient\b|\btransient slips\b|\bbest transient\b|\bbest marina\b|\bovernight\b|\bmarina\b|\bmarinas\b/.test(q)
  );
}

function isRepairOrYardQuery(message = "", parsed = {}) {
  const q = normalizeText(message);
  return Boolean(
    parsed?.flags?.wantsRepairs ||
    /\brepair\b|\brepairs\b|\byard\b|\bboatyard\b|\byacht yard\b/.test(q)
  );
}

function annapolisShortlistPrune(rankedLocations, message, parsed, searchCenter) {
  if (!Array.isArray(rankedLocations) || rankedLocations.length === 0) return rankedLocations;
  if (!isAnnapolisQuery(message, searchCenter)) return rankedLocations;

  const fuelQuery = isFuelQuery(message, parsed);
  const quietQuery = isQuietQuery(message, parsed);
  const transientQuery = isBroadTransientQuery(message, parsed);
  const yardQuery = isRepairOrYardQuery(message, parsed);

  const normalizedById = rankedLocations.map((loc) => ({
    ...loc,
    _normName: normalizeText(loc.name || "")
  }));

  let allowedNames = null;

  if (fuelQuery) {
    allowedNames = [
      "annapolis city marina",
      "annapolis landing marina"
    ];
  } else if (quietQuery) {
    allowedNames = [
      "horn point harbor marina",
      "annapolis landing marina",
      "the marina at nautilus point"
    ];

    if (yardQuery) {
      allowedNames.push("bert jabin yacht yard");
    }
  } else if (transientQuery) {
    allowedNames = [
      "horn point harbor marina",
      "the marina at nautilus point",
      "annapolis landing marina",
      "annapolis city marina"
    ];
  } else {
    allowedNames = [
      "horn point harbor marina",
      "the marina at nautilus point",
      "annapolis landing marina",
      "annapolis city marina"
    ];
  }

  let pruned = normalizedById.filter((loc) => allowedNames.includes(loc._normName));

  if (fuelQuery && pruned.length < 2) {
    const liberty = normalizedById.find((loc) => loc._normName === "liberty marina");
    if (liberty) pruned.push(liberty);
  }

  if (!pruned.length) {
    return rankedLocations;
  }

  console.log("ANNAPOLIS PRUNE ACTIVE:", pruned.map((loc) => loc.name));

  return pruned
    .sort((a, b) => {
      const aIndex = allowedNames.indexOf(a._normName);
      const bIndex = allowedNames.indexOf(b._normName);

      if (aIndex !== -1 && bIndex !== -1 && aIndex !== bIndex) {
        return aIndex - bIndex;
      }

      return Number(b.ranking?.final_score || 0) - Number(a.ranking?.final_score || 0);
    })
    .map(({ _normName, ...loc }) => loc);
}

async function buildAnswerFromOpenAI({
  userMessage,
  candidateLocations,
  groupedCountSummary
}) {
  const formattedContext = formatTopLocations(candidateLocations || []);
  const contextText = formattedContext || "No strong candidates found in the current dataset.";
  const countText = groupedCountSummary
    ? `Grouped candidate counts: ${JSON.stringify(groupedCountSummary)}`
    : "";

  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        `User question: ${userMessage}`,
        countText,
        "Candidate location data:",
        contextText
      ]
        .filter(Boolean)
        .join("\n\n")
    }
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages
  });

  return sanitizeAnswerText(
    completion?.choices?.[0]?.message?.content || "I’m sorry, but I could not build a reliable answer from the current dataset."
  );
}

app.get("/", (_req, res) => {
  res.send("ICW Assistant server running.");
});

app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = String(req.body?.message || "").trim();
    const lat = Number.isFinite(Number(req.body?.lat)) ? Number(req.body?.lat) : 30.0;
    const lon = Number.isFinite(Number(req.body?.lon)) ? Number(req.body?.lon) : -81.0;

    if (!userMessage) {
      return res.status(400).json({ error: "Message is required." });
    }

    const allLocations = loadLocations();
    const parsed = parseQuery(userMessage);
    const searchCenter = resolveSearchCenter(userMessage, lat, lon);

    if (detectComparisonQuery(userMessage)) {
      const pair = chooseBestPairForComparison(userMessage, allLocations);
      if (pair && pair.length === 2) {
        const answer = buildComparisonAnswer(pair[0], pair[1]);
        return res.json({ answer, locationContext: searchCenter });
      }
    }

    if (isDirectInfoQuery(userMessage)) {
      const directLocation = findBestDirectLocation(userMessage, allLocations);
      if (directLocation && hasStructuredDetails(directLocation)) {
        const answer = buildDetailAnswer(directLocation);
        return res.json({ answer, locationContext: searchCenter });
      }
    }

    let rankedLocations = rankLocations(allLocations, {
      lat: searchCenter.lat,
      lon: searchCenter.lon,
      parsedQuery: parsed,
      rawQuery: userMessage
    });

    rankedLocations = applyQuerySpecificRankingBoosts(rankedLocations, userMessage, searchCenter);
    rankedLocations = annapolisShortlistPrune(rankedLocations, userMessage, parsed, searchCenter);

    if (parsed?.requestedTypes?.length) {
      rankedLocations = filterByRequestedTypes(rankedLocations, parsed.requestedTypes);
    }

    if (isYesNoServiceQuery(userMessage)) {
      const info = inferYesNoServiceIntent(userMessage);
      rankedLocations = rankedLocations.filter((loc) => {
        const access = loc?.access || {};
        const matches = info.requestedServices.map((service) => {
          if (service === "fuel") return Boolean(access.fuel || hasFuelSignal(loc));
          if (service === "free_dock") {
            return ["free_dock", "town_dock", "low_cost_dock", "day_dock"].includes(loc.type);
          }
          return Boolean(access[service]);
        });

        return info.matchMode === "any" ? matches.some(Boolean) : matches.every(Boolean);
      });
    }

    if (!rankedLocations.length) {
      const coverageMessage =
        searchCenter.source === "request_coords"
          ? `⚠️ Advisory:
- Your current position appears to be outside the present ICW Assistant coverage area for nearby search.

📍 Conditions:
- "Near me" is using your actual browser location.
- Right now, the curated dataset is focused on the Chesapeake and Norfolk-to-Florida cruising corridor, not Toronto or Lake Ontario.

✔️ Summary:
- Try a named-place query such as "marinas near Annapolis", "fuel near Baltimore", or "anchorages near St. Augustine", or switch back to the default reference location.`
          : `⚠️ Advisory:
- No strong candidates were found in the current dataset for that query.

📍 Conditions:
- The assistant did not find a practical nearby match within the current search radius and coverage area.

✔️ Summary:
- Try a broader place-based query or a different nearby service request.`;

      return res.json({
        answer: coverageMessage,
        locationContext: searchCenter
      });
    }

    const topLocations = takeTopByCategory(
      rankedLocations,
      parsed?.requestedTypes?.length ? parsed.requestedTypes : null,
      4
    );

    const groupedCountSummary = buildGroupedCountSummary(
      rankedLocations,
      parsed?.requestedTypes?.length ? parsed.requestedTypes : null
    );

    const answer = await buildAnswerFromOpenAI({
      userMessage,
      candidateLocations: topLocations,
      groupedCountSummary
    });

    return res.json({ answer });
  } catch (error) {
    console.error("Chat error:", error.stack || error);
    return res.status(500).json({
      error: "The assistant hit a server-side error.",
      detail: error.message
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
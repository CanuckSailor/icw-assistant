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
    town: /\btown\b|\bwalkable\b|\brestaurants\b|\bgroceries\b|\bashore\b/.test(q)
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

  return {
    wantsLink: /\blink\b|\burl\b|\bwebsite\b|\bweb site\b/.test(q) || wantsGeneralContact,
    wantsPhone: /\bphone\b|\btelephone\b|\bcall\b|\bnumber\b/.test(q) || wantsGeneralContact,
    wantsEmail: /\bemail\b|\be mail\b/.test(q) || wantsGeneralContact,
    wantsVhf: /\bvhf\b|\bchannel\b/.test(q),
    wantsCamera: /\bcamera\b|\bharbor cam\b|\bharbour cam\b|\bwebcam\b|\bcam\b/.test(q),
    wantsGeneralContact
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
    direct.wantsGeneralContact
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

  const intent = inferOperationalIntent(message);
  const placeName = normalizeText(searchCenter?.placeName || "");
  const sidebarRegion = normalizeText(searchCenter?.sidebarRegion || "");
  const matchingPreferences = getMatchingPreferences(message, searchCenter);

  const isGeneralMarinaQuestion =
    intent.marina && !intent.fuel && !intent.services && !intent.town;

  const isPalmBeachStyleMarket =
    placeName.includes("palm beach") ||
    placeName.includes("west palm beach") ||
    sidebarRegion.includes("palm_beach") ||
    placeName.includes("fort lauderdale") ||
    sidebarRegion.includes("fort_lauderdale");

  const boosted = rankedLocations.map((loc) => {
    let bonus = 0;

    const nameBlob = locationNameText(loc);
    const textBlob = normalizeText(
      [
        loc.name || "",
        loc.region || "",
        loc.waterbody || "",
        loc.source?.name || "",
        loc.source?.source_url || "",
        loc.expert_notes?.plain || "",
        loc.pricing?.standard?.rate_basis || "",
        loc.pricing?.standard?.notes || "",
        ...(Array.isArray(loc.cautions) ? loc.cautions.map((c) => c.text || "") : [])
      ].join(" ")
    );

    const currentScore = Number(loc.ranking?.final_score ?? 0);

    if ((intent.fuel || intent.services || intent.marina || intent.town) && placeName) {
      const firstPlaceWord = placeName.split(" ")[0];
      if (firstPlaceWord && nameBlob.includes(firstPlaceWord)) bonus += 0.18;
      if (nameBlob.includes(placeName)) bonus += 0.12;
    }

    if (intent.fuel && hasFuelSignal(loc)) bonus += 0.18;

    if (intent.town && (loc.shore_access?.walkability_score ?? 0) >= 0.75) {
      bonus += 0.12;
    }

    if ((intent.fuel || intent.services) && loc.ranking?.distance_nm != null && loc.ranking.distance_nm > 3) {
      bonus -= 0.05;
    }

    if (
      (intent.fuel || intent.services) &&
      loc.ranking?.distance_icw_miles != null &&
      loc.ranking.distance_icw_miles > 5
    ) {
      bonus -= 0.05;
    }

    if (isGeneralMarinaQuestion) {
      if ((loc.type || "") === "marina") bonus += 0.03;

      if (textBlob.includes("municipal")) bonus += 0.28;
      if (textBlob.includes("city marina")) bonus += 0.28;
      if (textBlob.includes("working transient option")) bonus += 0.24;
      if (textBlob.includes("practical transient")) bonus += 0.22;
      if (textBlob.includes("practical")) bonus += 0.10;

      if ((loc.quality?.value_score ?? 0) >= 0.55) bonus += 0.10;
      if ((loc.quality?.convenience_score ?? 0) >= 0.7) bonus += 0.08;
      if ((loc.shore_access?.walkability_score ?? 0) >= 0.75) bonus += 0.07;
      if (loc.access?.transient_slips) bonus += 0.05;
      if (loc.access?.pumpout) bonus += 0.03;

      if (textBlob.includes("superyacht")) bonus -= 0.42;
      if (textBlob.includes("premium marina")) bonus -= 0.24;
      if (textBlob.includes("premium")) bonus -= 0.12;
      if (textBlob.includes("service yard")) bonus -= 0.22;
      if (textBlob.includes("50 to 300 feet")) bonus -= 0.34;
      if (textBlob.includes("60 feet upward")) bonus -= 0.42;
      if (textBlob.includes("starts at 60 ft")) bonus -= 0.36;
      if (textBlob.includes("not a natural fit for the average 25 50 foot cruising boat")) bonus -= 0.45;
      if (textBlob.includes("not the average cruiser default")) bonus -= 0.35;
      if (textBlob.includes("large yacht oriented")) bonus -= 0.32;
      if (textBlob.includes("yacht oriented")) bonus -= 0.18;
    }

    if (isPalmBeachStyleMarket && isGeneralMarinaQuestion) {
      if (nameBlob.includes("palm harbor marina")) bonus += 0.48;
      if (nameBlob.includes("riviera beach city marina")) bonus += 0.06;
      if (nameBlob.includes("safe harbor rybovich")) bonus -= 0.28;
      if (nameBlob.includes("sailfish marina")) bonus -= 0.08;
      if (nameBlob.includes("safe harbor new port cove")) bonus -= 0.14;

      if (placeName.includes("west palm beach") && nameBlob.includes("palm harbor marina")) {
        bonus += 0.10;
      }

      if (textBlob.includes("city marina")) bonus += 0.10;
      if (textBlob.includes("reported dockside depth is only 7 feet")) bonus -= 0.04;
      if (textBlob.includes("dockside depth of only 5 feet")) bonus -= 0.16;
      if (textBlob.includes("reported dockside depth of only 5 feet")) bonus -= 0.16;
      if (textBlob.includes("5 feet mlw")) bonus -= 0.12;
    }

    matchingPreferences.forEach((pref) => {
      bonus += scorePreferenceForLocation(pref, loc);
    });

    return {
      ...loc,
      ranking: {
        ...loc.ranking,
        final_score: Number((currentScore + bonus).toFixed(4)),
        explanation: [
          ...((loc.ranking && Array.isArray(loc.ranking.explanation)) ? loc.ranking.explanation : []),
          ...(bonus !== 0 ? [`query_specific_bonus ${bonus.toFixed(2)}`] : [])
        ]
      }
    };
  });

  boosted.sort((a, b) => {
    const aScore = Number(a.ranking?.final_score ?? 0);
    const bScore = Number(b.ranking?.final_score ?? 0);
    return bScore - aScore;
  });

  return boosted;
}

function extractContactLikeFields(location) {
  const direct = {};

  if (location?.contact?.phone) direct.phone = location.contact.phone;
  if (location?.contact?.email) direct.email = location.contact.email;
  if (location?.contact?.website) direct.website = location.contact.website;
  if (location?.contact?.vhf) direct.vhf = location.contact.vhf;
  if (location?.contact?.camera_url) direct.camera_url = location.contact.camera_url;

  if (location?.source?.source_url) direct.source_url = location.source.source_url;

  return direct;
}

function getLogbookText(location) {
  if (location?.expert_notes?.plain) {
    return String(location.expert_notes.plain)
      .replace(/^sail to the sun expert opinion:\s*/i, "")
      .replace(/^sail to the sun logbook:\s*/i, "")
      .trim();
  }
  return "";
}

function getCameraLinkFromLocation(location) {
  if (location?.contact?.camera_url) {
    return location.contact.camera_url;
  }

  const expert = getLogbookText(location);
  const noteBlob = normalizeText(expert);

  if (noteBlob.includes("towndock net") || noteBlob.includes("harbor cam")) {
    return "https://towndock.net/harborcam";
  }

  return null;
}

function buildDirectInfoPrompt({
  message,
  directIntent,
  searchCenter,
  matchedLocations
}) {
  const locationLines = matchedLocations
    .map((loc, idx) => {
      const contact = extractContactLikeFields(loc);
      return `
Candidate ${idx + 1}:
Name: ${loc.name || "Unknown"}
Type: ${loc.type || "Unknown"}
Region: ${loc.region || "Unknown"}
Website: ${contact.website || "None"}
Phone: ${contact.phone || "None"}
Email: ${contact.email || "None"}
VHF: ${contact.vhf || "None"}
Camera URL: ${contact.camera_url || "None"}
Source URL: ${contact.source_url || "None"}
Logbook note: ${getLogbookText(loc) || "None"}
Camera link override: ${getCameraLinkFromLocation(loc) || "None"}
`;
    })
    .join("\n");

  let requestType = "direct information";
  if (directIntent.wantsGeneralContact) requestType = "contact information";
  else if (directIntent.wantsCamera) requestType = "camera link";
  else if (directIntent.wantsPhone) requestType = "phone number";
  else if (directIntent.wantsEmail) requestType = "email address";
  else if (directIntent.wantsVhf) requestType = "VHF channel";
  else if (directIntent.wantsLink) requestType = "link or website";

  return `
User question:
${message}

Resolved place:
${searchCenter?.placeName || "Unknown"}

Request type:
${requestType}

Relevant candidates:
${locationLines || "None"}

Instructions:
- Answer the user's direct request first and keep it short.
- Do not use bold markdown or wrap facility names in asterisks.
- If the request type is contact information, return the available phone, website, email, and VHF in a compact practical format.
- For any website, camera link, or other URL, return it as a markdown link using the format [Label](https://example.com).
- If the user asked for a camera link and a camera URL or camera link override is present, use it.
- If the user asked for a phone number, email, website, or VHF, provide only that information plus at most one short clarifying sentence.
- Do NOT give the full structured marina or free-dock rundown unless the user explicitly asks for more.
- If there are two closely related candidates and the distinction matters, mention that briefly.
- If the information is not available in the candidate data, say that plainly.
`;
}

function locationHasRequestedDirectField(location, directIntent) {
  if (!location || !directIntent) return false;

  if (directIntent.wantsGeneralContact) {
    return Boolean(
      location?.contact?.phone ||
        location?.contact?.email ||
        location?.contact?.website ||
        location?.contact?.vhf
    );
  }
  if (directIntent.wantsCamera) return Boolean(getCameraLinkFromLocation(location));
  if (directIntent.wantsPhone) return Boolean(location?.contact?.phone);
  if (directIntent.wantsEmail) return Boolean(location?.contact?.email);
  if (directIntent.wantsVhf) return Boolean(location?.contact?.vhf);
  if (directIntent.wantsLink) {
    return Boolean(location?.contact?.website || location?.source?.source_url);
  }

  return false;
}

function isDockLikeLocation(location) {
  const blob = normalizeText([
    location?.name || "",
    ...(Array.isArray(location?.aliases) ? location.aliases : []),
    ...(Array.isArray(location?.search_terms) ? location.search_terms : []),
    ...(Array.isArray(location?.nearby_places) ? location.nearby_places : [])
  ].join(" "));

  return (
    location?.type === "free_dock" ||
    location?.type === "town_dock" ||
    location?.type === "day_dock" ||
    location?.type === "low_cost_dock" ||
    blob.includes("dock")
  );
}

function scoreDirectInfoCandidate(location, message, directIntent, searchCenter) {
  let score = 0;

  const normalizedMessage = normalizeText(message);
  const placeName = normalizeText(searchCenter?.placeName || "");
  const sidebarRegion = normalizeText(searchCenter?.sidebarRegion || "");
  const nameBlob = normalizeText([
    location?.name || "",
    location?.region || "",
    ...(Array.isArray(location?.aliases) ? location.aliases : []),
    ...(Array.isArray(location?.search_terms) ? location.search_terms : []),
    ...(Array.isArray(location?.nearby_places) ? location.nearby_places : [])
  ].join(" "));

  if (locationHasRequestedDirectField(location, directIntent)) score += 5;

  if (placeName && nameBlob.includes(placeName)) score += 2;
  if (sidebarRegion && normalizeText(location?.region || "") === sidebarRegion) score += 1;

  if (directIntent?.wantsCamera) {
    if (isDockLikeLocation(location)) score += 4;
    if (/\bfree dock\b|\bfree docks\b|\btown dock\b|\btown docks\b/.test(normalizedMessage)) {
      if (location?.type === "free_dock" || location?.type === "town_dock") score += 6;
    }
  }

  if (
    directIntent?.wantsPhone ||
    directIntent?.wantsEmail ||
    directIntent?.wantsVhf ||
    directIntent?.wantsLink ||
    directIntent?.wantsGeneralContact
  ) {
    if (/\bmarina\b/.test(normalizedMessage) && location?.type === "marina") score += 2;
    if (/\banchorage\b/.test(normalizedMessage) && location?.type === "anchorage") score += 2;
  }

  if (location?.name) {
    const normalizedName = normalizeText(location.name);
    if (normalizedName && normalizedMessage.includes(normalizedName)) score += 6;
  }

  return score;
}

function chooseDirectInfoCandidates(message, locations, searchCenter) {
  const directIntent = inferDirectInfoIntent(message);
  const directMatches = findDirectNameMatches(message, locations);

  if (directMatches.length > 0) {
    return [...directMatches]
      .sort((a, b) => {
        const aScore = scoreDirectInfoCandidate(a, message, directIntent, searchCenter);
        const bScore = scoreDirectInfoCandidate(b, message, directIntent, searchCenter);
        return bScore - aScore;
      })
      .slice(0, 4);
  }

  const region = normalizeText(searchCenter?.sidebarRegion || "");
  const placeName = normalizeText(searchCenter?.placeName || "");

  let fallback = locations.filter((loc) => {
    if (!loc?.status?.active) return false;

    const locRegion = normalizeText(loc.region || "");
    const locNameBlob = normalizeText([
      loc.name || "",
      ...(Array.isArray(loc.aliases) ? loc.aliases : []),
      ...(Array.isArray(loc.search_terms) ? loc.search_terms : []),
      ...(Array.isArray(loc.nearby_places) ? loc.nearby_places : [])
    ].join(" "));

    const sameRegion = region && locRegion === region;
    const mentionsPlace = placeName && locNameBlob.includes(placeName.split(" ")[0]);

    if (directIntent.wantsCamera) {
      return (sameRegion || mentionsPlace) && isDockLikeLocation(loc);
    }

    return sameRegion || mentionsPlace;
  });

  if (directIntent.wantsCamera) {
    fallback = fallback.filter((loc) => Boolean(getCameraLinkFromLocation(loc)));
  }

  return [...fallback]
    .sort((a, b) => {
      const aScore = scoreDirectInfoCandidate(a, message, directIntent, searchCenter);
      const bScore = scoreDirectInfoCandidate(b, message, directIntent, searchCenter);
      return bScore - aScore;
    })
    .slice(0, 4);
}

function locationOffersServiceLiteral(location, serviceName) {
  if (!location) return false;

  if (serviceName === "fuel") {
    if (location?.access?.fuel === true) return true;
    return hasFuelSignal(location);
  }

  if (serviceName === "free_dock") {
    return ["free_dock", "town_dock", "low_cost_dock", "day_dock"].includes(location.type);
  }

  if (serviceName === "pumpout") return location?.access?.pumpout === true;
  if (serviceName === "laundry") return location?.access?.laundry === true;
  if (serviceName === "showers") return location?.access?.showers === true;
  if (serviceName === "water") return location?.access?.water === true;
  if (serviceName === "shore_power") return location?.access?.shore_power === true;
  if (serviceName === "restaurant") return location?.access?.restaurant === true;
  if (serviceName === "wifi") return location?.access?.wifi === true;

  return false;
}

function getAssociatedServiceNote(location, serviceName) {
  const associations = Array.isArray(location?.service_associations)
    ? location.service_associations
    : [];

  const match = associations.find((item) => item?.service === serviceName);
  return match?.plain || null;
}

function locationOffersService(location, serviceName) {
  if (locationOffersServiceLiteral(location, serviceName)) return true;
  if (getAssociatedServiceNote(location, serviceName)) return true;
  return false;
}

function locationMatchesServiceSet(location, requestedServices, matchMode = "all") {
  if (!Array.isArray(requestedServices) || requestedServices.length === 0) return false;

  if (matchMode === "any") {
    return requestedServices.some((service) => locationOffersService(location, service));
  }

  return requestedServices.every((service) => locationOffersService(location, service));
}

function describeRequestedServices(requestedServices, matchMode = "all") {
  if (!Array.isArray(requestedServices) || requestedServices.length === 0) return "service";

  if (requestedServices.length === 1) return requestedServices[0];

  const joiner = matchMode === "any" ? " or " : " and ";
  if (requestedServices.length === 2) {
    return `${requestedServices[0]}${joiner}${requestedServices[1]}`;
  }

  const last = requestedServices[requestedServices.length - 1];
  const firstPart = requestedServices.slice(0, -1).join(", ");
  return `${firstPart}${matchMode === "any" ? ", or " : ", and "}${last}`;
}

function buildServiceQualificationText(location, requestedServices) {
  const parts = [];

  requestedServices.forEach((service) => {
    if (locationOffersServiceLiteral(location, service)) {
      parts.push(`${service}: direct`);
    } else {
      const note = getAssociatedServiceNote(location, service);
      if (note) {
        parts.push(`${service}: associated access - ${note}`);
      }
    }
  });

  return parts.join("\n");
}

function buildYesNoServicePrompt({
  message,
  searchCenter,
  requestedServices,
  matchMode,
  nearbyCandidates,
  fartherCandidates
}) {
  const positiveNearby = (nearbyCandidates || []).filter((loc) =>
    locationMatchesServiceSet(loc, requestedServices, matchMode)
  );

  const positiveFarther = (fartherCandidates || []).filter((loc) =>
    locationMatchesServiceSet(loc, requestedServices, matchMode)
  );

  const requestedServiceText = describeRequestedServices(requestedServices, matchMode);

  const summarize = (items) =>
    items
      .map(
        (loc, idx) => `
Candidate ${idx + 1}:
Name: ${loc.name || "Unknown"}
Type: ${loc.type || "Unknown"}
Distance NM: ${loc.ranking?.distance_nm ?? "Unknown"}
Distance ICW miles: ${loc.ranking?.distance_icw_miles ?? "Unknown"}
Requested services (${requestedServiceText}): YES
Qualification details:
${buildServiceQualificationText(loc, requestedServices) || "None"}
Access object: ${JSON.stringify(loc.access || {}, null, 2)}
Contact: ${JSON.stringify(loc.contact || {}, null, 2)}
Logbook: ${getLogbookText(loc) || "None"}
Notes: ${loc.notes || ""}
Practical takeaway: ${loc.practical_takeaway || ""}
`
      )
      .join("\n");

  return `
User question:
${message}

Resolved place:
${searchCenter?.placeName || "Unknown"}

Requested services:
${requestedServiceText}

Match mode:
${matchMode}

Positive nearby candidates:
${summarize(positiveNearby) || "None"}

Positive farther candidates:
${summarize(positiveFarther) || "None"}

Instructions:
- Answer in SHORT direct style, not the full structured advisory format.
- Do not use bold markdown or wrap facility names in asterisks.
- Start with YES or NO on the first line.
- If one or more positive candidates are present, lead with YES.
- Only mention locations that satisfy the requested service set under the stated match mode.
- If a service is available through an adjacent practical association rather than directly on the property, say that plainly and accurately.
- Do NOT falsely state that a facility directly has a service when the data says it is associated nearby.
- If match mode is ALL, do NOT include places that have only one of the requested services.
- Do NOT list places that do not satisfy the requested service set.
- Do NOT use headings like Advisory, Conditions, Marinas, Free Docks, or Summary unless absolutely necessary.
- Do NOT explain where the service is unavailable unless there are no positive candidates at all.
- Keep the answer concise and practical.
- Prefer plain short paragraphs or short bullets.
- Name the best nearby or in-town place first if supported by the candidate data.
- Mention an additional farther option only if it is genuinely useful.
- If the best answer is in-town or right at the named place, say that clearly.
- For any website or URL mentioned, return it as a markdown link using the format [Label](https://example.com).
- Do not invent services that are not present in the candidate data.
`;
}

const EXCLUDED_SOURCES = [
  /peter\s+swanson/i,
  /loose\s+cannon/i,
  /loosecannon/i,
  /jeff\s+siegel/i
];

function isBlacklistedCard(card) {
  const haystack = [
    card.source_name || "",
    card.source_credit || "",
    card.source_url || "",
    card.notes || ""
  ].join(" ");

  return EXCLUDED_SOURCES.some((pattern) => pattern.test(haystack));
}

function isEligibleCard(card, context) {
  if (!card || card.status !== "active") return false;
  if (isBlacklistedCard(card)) return false;

  if (card.type === "local_event") {
    const now = new Date(context.nowISO);
    if (card.start_date && new Date(card.start_date) > now) return false;
    if (card.end_date && new Date(card.end_date) < now) return false;
  }

  if (card.region && card.region !== "global" && card.region !== context.region) return false;

  return true;
}

function scoreTipCard(card, context, stats) {
  let score = 0;

  score += card.priority || 0;
  score += card.boater_relevance || 0;

  const textBlob = [
    card.title || "",
    card.summary || "",
    card.display_text || "",
    (card.category_tags || []).join(" "),
    card.subtype || ""
  ].join(" ").toLowerCase();

  if (/boat galley/i.test(card.source_name || "")) score += 12;
  if (/waterway guide/i.test(card.source_name || "")) score += 6;
  if (/cruisersnet/i.test(card.source_name || "")) score += 6;

  if (context.intent === "marina" && /current|dock|approach|timing|provisioning|transient|fuel|pumpout|laundry/.test(textBlob)) {
    score += 4;
  }

  if (context.intent === "boating_tip" && card.type === "boating_tip") {
    score += 4;
  }

  if (card.audio_text) score += 1;

  const timesShown = stats.shownByCardId[card.id] || 0;
  score -= timesShown * 3;

  return score;
}

function scoreLocalCard(card, context, stats) {
  let score = 0;

  score += card.priority || 0;
  score += card.boater_relevance || 0;

  const subtype = (card.subtype || "").toLowerCase();
  const type = (card.type || "").toLowerCase();

  const textBlob = [
    card.title || "",
    card.summary || "",
    card.display_text || "",
    (card.category_tags || []).join(" "),
    subtype,
    type
  ].join(" ").toLowerCase();

  if (/chamber|tourism|visitor|cvb|waterway guide|cruisersnet|towndock/i.test(card.source_name || "")) {
    score += 5;
  }

  if (context.intent === "general_location") {
    if (type === "local_event") score += 10;
    if (type === "shoreside_activity") score += 8;
    if (/museum|park|historic|waterfront|view|festival|event|calendar|ashore|town character/.test(textBlob)) {
      score += 5;
    }
    if (type === "editorial_tip") score -= 1;
  }

  if (context.intent === "marina") {
    if (type === "editorial_tip") score += 6;
    if (/boater_services|dockage_practical|marina|transient|provisioning|courtesy car|laundry|restaurant|fuel|pumpout|shore access|current|docking/.test(textBlob)) {
      score += 6;
    }
    if (type === "local_event" || type === "shoreside_activity") score -= 1;
  }

  if (context.intent === "boating_tip") {
    if (type === "editorial_tip") score += 4;
    if (/current|approach|dock|timing|hazard|shoal|depth/.test(textBlob)) {
      score += 4;
    }
  }

  if (card.audio_text) score += 1;

  const timesShown = stats.shownByCardId[card.id] || 0;
  score -= timesShown * 3;

  return score;
}

function chooseBestCard(pool, scoreFn, context, stats, excludedIds = new Set()) {
  const filtered = (pool || []).filter((card) => !excludedIds.has(card.id));
  if (!filtered.length) return null;

  const scored = filtered.map((card) => ({
    card,
    score: scoreFn(card, context, stats)
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored[0].card;
}

function updateSidebarStats(cards, stats) {
  for (const card of cards) {
    stats.totalShown += 1;
    if (card.type === "ad") stats.adShown += 1;
    else stats.editorialShown += 1;

    stats.shownByCardId[card.id] = (stats.shownByCardId[card.id] || 0) + 1;
  }
}

function buildStaticLogoCard() {
  return {
    id: "stts-static-logo-card",
    type: "static_logo",
    region: "global",
    title: "Sail to the Sun",
    summary: "Sail to the Sun logo card",
    display_text: "",
    audio_text: "",
    image_url: "/images/sail-to-the-sun-logo.png",
    source_name: "ICW Assistant",
    source_credit: "Sail to the Sun",
    priority: 100,
    status: "active"
  };
}

function buildSidebarPayload(message, searchCenter) {
  const context = {
    region: searchCenter?.sidebarRegion || "global",
    intent: inferSidebarIntent(message),
    nowISO: new Date().toISOString()
  };

  const tipCards = loadTipCards().filter((card) => isEligibleCard(card, context));
  const localCards = loadLocalCardsForRegion(searchCenter?.sidebarRegion).filter((card) =>
    isEligibleCard(card, context)
  );
  const fallbackLocalCards = loadFallbackLocalCards().filter((card) =>
    isEligibleCard(card, context)
  );

  const usedIds = new Set();
  const selected = [];

  const leftPrimary =
    chooseBestCard(localCards, scoreLocalCard, context, sidebarStats, usedIds) ||
    chooseBestCard(tipCards, scoreTipCard, context, sidebarStats, usedIds) ||
    chooseBestCard(fallbackLocalCards, scoreLocalCard, context, sidebarStats, usedIds);

  if (leftPrimary) {
    selected.push(leftPrimary);
    usedIds.add(leftPrimary.id);
  }

  updateSidebarStats(selected, sidebarStats);

  selected.push(buildStaticLogoCard());

  return selected.slice(0, 2);
}

function buildSpecialGuidance(message, searchCenter) {
  const matchingPreferences = getMatchingPreferences(message, searchCenter);
  if (!matchingPreferences.length) return "";

  let guidance = "\nSpecial local guidance:\n";

  matchingPreferences.forEach((pref) => {
    if (pref.prompt_guidance) {
      guidance += `- ${pref.prompt_guidance}\n`;
    }
  });

  return guidance;
}

app.get("/", (req, res) => {
  res.send("ICW Assistant backend is running.");
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, lat, lon } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Missing message" });
    }

    if (typeof lat !== "number" || typeof lon !== "number") {
      return res.status(400).json({ error: "Missing or invalid lat/lon" });
    }

    const searchCenter = resolveSearchCenter(message, lat, lon);
    const locations = loadLocations();

    if (isDirectInfoQuery(message)) {
      const directIntent = inferDirectInfoIntent(message);
      const directCandidates = chooseDirectInfoCandidates(message, locations, searchCenter);
      const sidebarCards = buildSidebarPayload(message, searchCenter);

      const directPrompt = buildDirectInfoPrompt({
        message,
        directIntent,
        searchCenter,
        matchedLocations: directCandidates
      });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: directPrompt }
        ]
      });

      const rawAnswer =
        completion.choices?.[0]?.message?.content || "No response generated.";
      const answer = sanitizeAnswerText(rawAnswer);

      const topCandidatesPayload = directCandidates.slice(0, 4).map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        icw_mile: r.geo?.icw_mile ?? null,
        distance_nm: null,
        distance_icw_miles: null,
        distance_unit: null,
        final_score: null,
        media: absolutizeMedia(r.media, req)
      }));

      return res.json({
        parsedQuery: { direct_info_mode: true },
        searchCenter,
        directMatchMode: directCandidates.length > 0,
        nearbyCount: directCandidates.length,
        fartherCount: 0,
        nearbyTypeCounts: {},
        fartherTypeCounts: {},
        topCandidates: topCandidatesPayload,
        sidebarCards,
        answer
      });
    }

    const parsedQuery = parseQuery(message);
    const directMatches = findDirectNameMatches(message, locations);

    let nearbyRanked = [];
    let fartherRanked = [];
    let directMatchMode = false;

    if (directMatches.length > 0) {
      directMatchMode = true;

      nearbyRanked = directMatches.slice(0, 8).map((loc) => ({
        ...loc,
        ranking: {
          distance_nm: null,
          distance_icw_miles: null,
          distance_unit: null,
          distance_mode: "direct_match",
          final_score: 1.0,
          explanation: ["direct name match"],
          components: {}
        }
      }));
    } else {
      let allNearby = rankLocations(locations, searchCenter.lat, searchCenter.lon, parsedQuery, {
        maxDistance: 15
      });

      let allFarther = rankLocations(locations, searchCenter.lat, searchCenter.lon, parsedQuery, {
        maxDistance: 30
      }).filter((loc) => {
        if (loc.ranking.distance_unit === "icw_miles") {
          return loc.ranking.distance_icw_miles > 15;
        }
        return loc.ranking.distance_nm > 15;
      });

      allNearby = applyQuerySpecificRankingBoosts(allNearby, message, searchCenter);
      allFarther = applyQuerySpecificRankingBoosts(allFarther, message, searchCenter);

      const filteredNearby = filterByRequestedTypes(allNearby, parsedQuery.requestedTypes);
      const filteredFarther = filterByRequestedTypes(allFarther, parsedQuery.requestedTypes);

      nearbyRanked = takeTopByCategory(filteredNearby, parsedQuery.requestedTypes, 4);
      fartherRanked = takeTopByCategory(filteredFarther, parsedQuery.requestedTypes, 4);
    }

    if (isYesNoServiceQuery(message)) {
      const yesNo = inferYesNoServiceIntent(message);

      const nearbyServiceCandidates = nearbyRanked
        .filter((loc) => locationMatchesServiceSet(loc, yesNo.requestedServices, yesNo.matchMode))
        .slice(0, 8);

      const fartherServiceCandidates = fartherRanked
        .filter((loc) => locationMatchesServiceSet(loc, yesNo.requestedServices, yesNo.matchMode))
        .slice(0, 6);

      const sidebarCards = buildSidebarPayload(message, searchCenter);

      const yesNoPrompt = buildYesNoServicePrompt({
        message,
        searchCenter,
        requestedServices: yesNo.requestedServices,
        matchMode: yesNo.matchMode,
        nearbyCandidates: nearbyServiceCandidates,
        fartherCandidates: fartherServiceCandidates
      });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.15,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: yesNoPrompt }
        ]
      });

      const rawAnswer =
        completion.choices?.[0]?.message?.content || "No response generated.";
      const answer = sanitizeAnswerText(rawAnswer);

      const topCandidatesPayload = nearbyServiceCandidates.slice(0, 12).map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        icw_mile: r.geo?.icw_mile ?? null,
        distance_nm: r.ranking?.distance_nm ?? null,
        distance_icw_miles: r.ranking?.distance_icw_miles ?? null,
        distance_unit: r.ranking?.distance_unit ?? null,
        final_score: r.ranking?.final_score ?? null,
        media: absolutizeMedia(r.media, req)
      }));

      return res.json({
        parsedQuery: {
          yes_no_service_mode: true,
          requestedServices: yesNo.requestedServices,
          matchMode: yesNo.matchMode
        },
        searchCenter,
        directMatchMode,
        nearbyCount: nearbyServiceCandidates.length,
        fartherCount: fartherServiceCandidates.length,
        nearbyTypeCounts: buildGroupedCountSummary(nearbyServiceCandidates, parsedQuery.requestedTypes),
        fartherTypeCounts: buildGroupedCountSummary(fartherServiceCandidates, parsedQuery.requestedTypes),
        topCandidates: topCandidatesPayload,
        sidebarCards,
        answer
      });
    }

    const nearbyContext = formatTopLocations(nearbyRanked, 12);
    const fartherContext = formatTopLocations(fartherRanked, 12);

    const nearbyTypeCounts = buildGroupedCountSummary(nearbyRanked, parsedQuery.requestedTypes);
    const fartherTypeCounts = buildGroupedCountSummary(fartherRanked, parsedQuery.requestedTypes);

    const locationReferenceText =
      searchCenter.source === "place_alias" && searchCenter.placeName
        ? `Search center resolved from place alias: ${searchCenter.placeName}`
        : `Search center resolved from request coordinates: lat ${searchCenter.lat}, lon ${searchCenter.lon}`;

    const specialGuidance = buildSpecialGuidance(message, searchCenter);

    const userPrompt = `
User question:
${message}

Parsed query:
${JSON.stringify(parsedQuery, null, 2)}

Search center:
${locationReferenceText}

Direct name match mode:
${directMatchMode ? "yes" : "no"}

Nearby grouped candidate counts:
${JSON.stringify(nearbyTypeCounts, null, 2)}

Farther grouped candidate counts:
${JSON.stringify(fartherTypeCounts, null, 2)}

Nearby candidates:
${nearbyContext || "None"}

Additional farther candidates:
${fartherContext || "None"}

Instructions:
- Use only the candidate data above.
- Do not use bold markdown or wrap facility names in asterisks.
- If direct name match mode is YES:
  - answer the user's question directly from the matched record(s)
  - do NOT say there are no nearby options
  - do NOT ask whether they want farther choices
  - treat this as a direct facility or anchorage question
- If direct name match mode is NO:
  - default to nearby candidates within 15 miles of the resolved search center
  - preserve category balance when the user asked for more than one category
  - if the user asked for marinas and anchorages, discuss both if relevant candidates exist
  - if the user asked for marinas, anchorages, and free docks, keep them under separate headings
  - if nearby choices are sparse and there are additional choices in the 15-30 mile band, ask:
    "Do you want more choices that are farther from your desired location?"
  - do not automatically list farther choices unless the user explicitly asks
- If the query is based on Mile Marker or MM, treat the distances as ICW miles from the requested stopping point.
- If a stop is day-use only, say so plainly and do not recommend it for overnight use.
- Do not invent facilities, prices, overnight permissions, mile markers, or depths.
- Do not force a fixed number of options.
- If the user clearly named a place, do not answer as though the search were centered somewhere else.
- On fuel or service questions, prefer the most convenient in-place option over a farther alternative when the underlying data supports that framing.
- On walkability or provisioning questions, prefer useful in-town answers over isolated marina answers when the data supports that framing.
- When you include a website or URL, return it as a markdown link using the format [Label](https://example.com).
${specialGuidance}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.25,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    const rawAnswer =
      completion.choices?.[0]?.message?.content || "No response generated.";
    const answer = sanitizeAnswerText(rawAnswer);

    const topCandidatesPayload = nearbyRanked.slice(0, 12).map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      icw_mile: r.geo?.icw_mile ?? null,
      distance_nm: r.ranking?.distance_nm ?? null,
      distance_icw_miles: r.ranking?.distance_icw_miles ?? null,
      distance_unit: r.ranking?.distance_unit ?? null,
      final_score: r.ranking?.final_score ?? null,
      media: absolutizeMedia(r.media, req)
    }));

    const sidebarCards = buildSidebarPayload(message, searchCenter);

    res.json({
      parsedQuery,
      searchCenter,
      directMatchMode,
      nearbyCount: nearbyRanked.length,
      fartherCount: fartherRanked.length,
      nearbyTypeCounts,
      fartherTypeCounts,
      topCandidates: topCandidatesPayload,
      sidebarCards,
      answer
    });
  } catch (error) {
    console.error("API error:", error);
    res.status(500).json({
      error: "Server error",
      details: error.message
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});